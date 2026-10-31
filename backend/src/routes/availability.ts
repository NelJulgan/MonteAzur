/**
 * ============================================================================
 * MONTE AZUR ROUTES — AVAILABILITY ENDPOINTS (src/routes/availability.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Zod Schema Validation for propertyId & month)
 * - STAGE 2: CORE FUNCTIONALITY (Redis avail:${propertyId}:${month} 60s Cache & SQL Overlap Query)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Half-Open Interval Expansion & Cache Ingestion)
 *
 * WHY THIS CODE EXISTS:
 * Serves live unavailable date ranges for any given month, checking Redis first
 * and evaluating half-open ranges `[check_in_date, check_out_date)` so morning check-out
 * dates remain 100% available for afternoon check-in turnarounds.
 *
 * TRICKY LOGIC:
 * - Half-open interval expansion: Loops strictly `cur < end`. A booking from Nov 12 to Nov 15
 *   marks Nov 12, 13, and 14 as unavailable. Nov 15 is the departure morning, which leaves
 *   Nov 15 open for the incoming guest's 3:00 PM check-in without collision.
 * - Active hold check: Evaluates `status = 'confirmed' OR (status = 'pending' AND hold_expires_at > NOW())`,
 *   ensuring abandoned carts with expired holds (> 30 mins) release their dates automatically.
 *
 * TODO:
 * - Add bulk multi-month availability pre-fetching for 12-month calendar views.
 * ============================================================================
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db, pool, isDbLive, fallbackStore, DEFAULT_PROPERTY_ID } from '../db/index.js';
import { bookings } from '../db/schema.js';
import { eq, and, or, lt, gt, sql } from 'drizzle-orm';
import { getAvailabilityCache, setAvailabilityCache } from '../services/redis.js';

// ============================================================================
// STAGE 1: FOUNDATION CODE — Zod Query Schema Validation
// ============================================================================

// STEP 1: Define strict Zod validation schema for propertyId (UUID) and month (YYYY-MM)
const currentMonthDefault = () => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
};

const availabilityQuerySchema = z.object({
  propertyId: z
    .string()
    .uuid('propertyId must be a valid UUID')
    .default(DEFAULT_PROPERTY_ID),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be in YYYY-MM format')
    .default(currentMonthDefault),
});

type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

// STEP 2: Calculate ISO date bounds for the target month
function getMonthDateBounds(month: string) {
  const [yearStr, monthNumStr] = month.split('-');
  const year = parseInt(yearStr, 10);
  const monthNum = parseInt(monthNumStr, 10);

  const monthStart = `${yearStr}-${monthNumStr}-01`;
  const nextYear = monthNum === 12 ? year + 1 : year;
  const nextMonthNum = monthNum === 12 ? 1 : monthNum + 1;
  const monthEnd = `${nextYear}-${String(nextMonthNum).padStart(2, '0')}-01`;

  return { monthStart, monthEnd };
}

// STEP 3: Expand [check_in_date, check_out_date) half-open interval into YYYY-MM-DD strings
function expandBookingNights(checkInStr: string, checkOutStr: string, targetMonth: string): string[] {
  const dates: string[] = [];
  const cur = new Date(`${checkInStr}T00:00:00Z`);
  const end = new Date(`${checkOutStr}T00:00:00Z`);

  // Half-open interval: cur < end (check-out day morning remains bookable for afternoon check-in)
  while (cur < end) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    const dateKey = `${y}-${m}-${d}`;

    if (dateKey.startsWith(targetMonth)) {
      dates.push(dateKey);
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return dates;
}

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Route Handler & Redis Integration
// ============================================================================

export default async function availabilityRoutes(fastify: FastifyInstance) {
  // STEP 4: Register GET /api/availability
  const handleAvailability = async (req: FastifyRequest, reply: FastifyReply) => {
    const parseResult = availabilityQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'Validation failed',
        details: parseResult.error.flatten(),
      });
    }

    const { propertyId, month } = parseResult.data;

    // STEP 5: Check Redis key avail:${propertyId}:${month} first (60s TTL)
    const cachedDates = await getAvailabilityCache(propertyId, month);
    if (cachedDates !== null) {
      return reply.send({
        month,
        unavailableDates: cachedDates,
        bookedDates: cachedDates, // Backwards-compatible alias for frontend calendar
      });
    }

    // ============================================================================
    // STAGE 3: ENHANCEMENT / OPTIMIZATION — Database Query & Date Expansion
    // ============================================================================

    const { monthStart, monthEnd } = getMonthDateBounds(month);
    const bookedDateSet = new Set<string>();

    if (isDbLive()) {
      try {
        // Query bookings overlapping the month with active status or unexpired holds
        const rows = await db
          .select({
            checkInDate: bookings.checkInDate,
            checkOutDate: bookings.checkOutDate,
          })
          .from(bookings)
          .where(
            and(
              eq(bookings.propertyId, propertyId),
              or(
                eq(bookings.status, 'confirmed'),
                eq(bookings.status, 'maintenance'),
                and(
                  eq(bookings.status, 'pending'),
                  sql`${bookings.holdExpiresAt} > NOW()`
                )
              ),
              // Half-open interval overlap check with target month
              lt(bookings.checkInDate, monthEnd),
              gt(bookings.checkOutDate, monthStart)
            )
          );

        for (const row of rows) {
          const expanded = expandBookingNights(row.checkInDate, row.checkOutDate, month);
          for (const d of expanded) {
            bookedDateSet.add(d);
          }
        }
      } catch (err: any) {
        console.warn(`[Availability] DB query error (${err.message}). Reading fallback store.`);
      }
    }

    // Query resilient store if PostgreSQL is offline or dev store has records
    const now = new Date();
    for (const booking of fallbackStore.bookings.values()) {
      const isDefended =
        booking.propertyId === propertyId &&
        (booking.status === 'confirmed' ||
          booking.status === 'maintenance' ||
          (booking.status === 'pending' &&
            booking.holdExpiresAt &&
            booking.holdExpiresAt > now));

      // Overlap with month: checkInDate < monthEnd && checkOutDate > monthStart
      if (isDefended && booking.checkInDate < monthEnd && booking.checkOutDate > monthStart) {
        const expanded = expandBookingNights(booking.checkInDate, booking.checkOutDate, month);
        for (const d of expanded) {
          bookedDateSet.add(d);
        }
      }
    }

    const unavailableDates = Array.from(bookedDateSet).sort();

    // Cache in Redis under avail:${propertyId}:${month} with 60s TTL
    await setAvailabilityCache(propertyId, month, unavailableDates, 60);

    // Return { month, unavailableDates }
    return reply.send({
      month,
      unavailableDates,
      bookedDates: unavailableDates, // Backwards-compatible alias for frontend calendar
    });
  };

  fastify.get('/api/availability', handleAvailability);
  fastify.get('/api/bookings/availability', handleAvailability);
  fastify.get('/api/v1/bookings/availability', handleAvailability);
}
