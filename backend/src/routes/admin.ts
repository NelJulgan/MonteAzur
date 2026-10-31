/**
 * ============================================================================
 * MONTE AZUR ROUTES — ADMIN MANAGEMENT & DATE BLOCKING (src/routes/admin.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Admin Authentication Hook & Zod Payloads)
 * - STAGE 2: CORE FUNCTIONALITY (Paginated Bookings Query & Payment Auditing)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Administrative Date Blocking & Cache Eviction)
 *
 * WHY THIS CODE EXISTS:
 * Provides management with authenticated control over estate inventory:
 * 1. Viewing all active, upcoming, and past reservations along with Stripe IDs.
 * 2. Manually locking villa dates for maintenance, deep cleaning, or offline
 *    direct bookings (Instagram/Facebook/VIP concierge guests).
 *
 * TRICKY LOGIC:
 * - Admin auth checks both `Authorization: Bearer <KEY>` and custom header `x-admin-key`.
 * - Administrative blocks use `status = 'maintenance'`, which the GiST exclusion
 *   defense, Redis cache, and frontend calendar treat as mathematically booked.
 *
 * TODO:
 * - Add role-based access control (RBAC) for cleaning staff vs owners in Phase 4.
 * ============================================================================
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { pool, isDbLive, fallbackStore, DEFAULT_PROPERTY_ID, InMemBooking } from '../db/index.js';
import { invalidateAvailabilityCache } from '../services/redis.js';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// STAGE 1: FOUNDATION CODE — Authentication & Validation Schemas
// ============================================================================

const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'aur_admin_secret_key_2026';

/**
 * Constant-time string comparison to prevent side-channel timing attacks.
 */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Fastify preHandler hook ensuring requests have valid admin credentials.
 */
export async function requireAdminAuth(req: FastifyRequest, reply: FastifyReply) {
  const authHeader = req.headers.authorization;
  const customHeader = req.headers['x-admin-key'];

  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (typeof customHeader === 'string') {
    token = customHeader.trim();
  }

  if (!token || !timingSafeCompare(token, ADMIN_API_KEY)) {
    return reply.status(401).send({
      success: false,
      error: 'Unauthorized: Invalid or missing administrator credentials.',
    });
  }
}

const blockDatesSchema = z.object({
  propertyId: z.string().uuid().default(DEFAULT_PROPERTY_ID),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'checkIn must be YYYY-MM-DD'),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'checkOut must be YYYY-MM-DD'),
  reason: z.string().min(2, 'Please provide a reason or guest description').default('Estate Maintenance Block'),
  notes: z.string().optional(),
});

const bookingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'maintenance', 'all']).default('all'),
});

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Paginated Bookings Audit List
// ============================================================================

export default async function adminRoutes(fastify: FastifyInstance) {
  // Apply admin authorization to all routes in this plugin
  fastify.addHook('preHandler', requireAdminAuth);

  // STEP 1: GET /api/admin/bookings
  fastify.get('/api/admin/bookings', async (req: FastifyRequest, reply: FastifyReply) => {
    const parseResult = bookingsQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid query parameters',
        details: parseResult.error.flatten(),
      });
    }

    const { page, limit, status } = parseResult.data;
    const offset = (page - 1) * limit;

    let total = 0;
    const items: any[] = [];

    if (isDbLive()) {
      try {
        let countQuery = 'SELECT COUNT(*) FROM bookings';
        let dataQuery = 'SELECT * FROM bookings';
        const params: any[] = [];

        if (status !== 'all') {
          countQuery += ' WHERE status = $1';
          dataQuery += ' WHERE status = $1';
          params.push(status);
        }

        const countRes = await pool.query(countQuery, params);
        total = parseInt(countRes.rows[0].count, 10);

        dataQuery += ` ORDER BY check_in_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        const dataRes = await pool.query(dataQuery, [...params, limit, offset]);

        for (const row of dataRes.rows) {
          items.push({
            id: row.id,
            propertyId: row.property_id,
            guestName: row.guest_name,
            guestEmail: row.guest_email,
            guestPhone: row.guest_phone,
            guests: row.guests,
            checkInDate: row.check_in_date,
            checkOutDate: row.check_out_date,
            totalCents: row.total_cents,
            totalPricePhp: row.total_cents ? row.total_cents / 100 : 0,
            status: row.status,
            stripeSessionId: row.stripe_session_id,
            stripePaymentIntentId: row.stripe_payment_intent_id,
            holdExpiresAt: row.hold_expires_at,
            createdAt: row.created_at,
          });
        }
      } catch (err: any) {
        console.warn(`[Admin Bookings] Database query error (${err.message}). Reading fallback store.`);
      }
    }

    // In-memory fallback dataset
    if (items.length === 0 && fallbackStore.bookings.size > 0) {
      const all = Array.from(fallbackStore.bookings.values()).filter((b) =>
        status === 'all' ? true : b.status === status
      );
      total = all.length;
      const paged = all.slice(offset, offset + limit);
      for (const b of paged) {
        items.push({
          ...b,
          totalPricePhp: b.totalCents ? b.totalCents / 100 : 0,
        });
      }
    }

    return reply.send({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
      bookings: items,
    });
  });

  // ============================================================================
  // STAGE 3: ENHANCEMENT / OPTIMIZATION — Manual Date Blocking
  // ============================================================================

  // STEP 2: POST /api/admin/block-dates
  fastify.post('/api/admin/block-dates', async (req: FastifyRequest, reply: FastifyReply) => {
    const parseResult = blockDatesSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'Validation failed',
        details: parseResult.error.flatten(),
      });
    }

    const { propertyId, checkIn, checkOut, reason } = parseResult.data;

    // Date range constraint
    if (checkIn >= checkOut) {
      return reply.status(400).send({
        success: false,
        error: 'Check-out date must be after check-in date.',
      });
    }

    const bookingId = crypto.randomUUID();

    if (isDbLive()) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check for collision with existing confirmed or maintenance dates
        const conflictQuery = `
          SELECT id, guest_name FROM bookings
          WHERE property_id = $1
            AND (status = 'confirmed' OR status = 'maintenance' OR (status = 'pending' AND hold_expires_at > NOW()))
            AND daterange(check_in_date, check_out_date, '[)') && daterange($2::date, $3::date, '[)')
          FOR UPDATE
        `;

        const conflict = await client.query(conflictQuery, [propertyId, checkIn, checkOut]);

        if (conflict.rows.length > 0) {
          await client.query('ROLLBACK');
          return reply.status(409).send({
            success: false,
            error: `Selected dates conflict with existing stay/block: ${conflict.rows[0].guest_name}`,
          });
        }

        // Insert maintenance block
        const insertQuery = `
          INSERT INTO bookings (
            id, property_id, guest_name, guest_email, check_in_date, check_out_date,
            total_cents, status, stripe_session_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING *
        `;

        await client.query(insertQuery, [
          bookingId,
          propertyId,
          reason,
          'concierge@monteazur.com',
          checkIn,
          checkOut,
          0,
          'maintenance',
          `admin_block_${Date.now()}`,
        ]);

        await client.query('COMMIT');
      } catch (err: any) {
        await client.query('ROLLBACK');
        console.error('[Admin Block] Transaction error:', err);
        return reply.status(500).send({ success: false, error: err.message });
      } finally {
        client.release();
      }
    } else {
      // In-memory fallback execution
      for (const existing of fallbackStore.bookings.values()) {
        const isConflict =
          existing.propertyId === propertyId &&
          (existing.status === 'confirmed' ||
            existing.status === 'maintenance' ||
            (existing.status === 'pending' &&
              existing.holdExpiresAt &&
              existing.holdExpiresAt > new Date()));

        if (isConflict && existing.checkInDate < checkOut && existing.checkOutDate > checkIn) {
          return reply.status(409).send({
            success: false,
            error: `Selected dates conflict with existing reservation (${existing.guestName}).`,
          });
        }
      }

      const rec: InMemBooking = {
        id: bookingId,
        propertyId,
        guestName: reason,
        guestEmail: 'concierge@monteazur.com',
        guestPhone: null,
        guests: 0,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        totalCents: 0,
        status: 'maintenance',
        stripeSessionId: `admin_block_${Date.now()}`,
        stripePaymentIntentId: null,
        holdExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      fallbackStore.bookings.set(bookingId, rec);
    }

    // Bust Redis availability cache so direct calendar reflects the blocked dates immediately
    await invalidateAvailabilityCache(propertyId);
    console.log(`🔒 [Admin] Dates blocked for ${reason} (${checkIn} to ${checkOut}). Redis cache invalidated.`);

    return reply.status(201).send({
      success: true,
      bookingId,
      message: `Successfully blocked dates from ${checkIn} to ${checkOut}.`,
    });
  });

  // STEP 3: DELETE /api/admin/bookings/:id (Unblock maintenance or cancel booking)
  fastify.delete('/api/admin/bookings/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const bookingId = (req.params as any)?.id;
    let propertyId = DEFAULT_PROPERTY_ID;

    if (isDbLive()) {
      try {
        const res = await pool.query(
          `UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1 RETURNING property_id`,
          [bookingId]
        );
        if (res.rows.length > 0) {
          propertyId = res.rows[0].property_id;
        }
      } catch (err: any) {
        return reply.status(500).send({ success: false, error: err.message });
      }
    } else {
      const stored = fallbackStore.bookings.get(bookingId);
      if (stored) {
        stored.status = 'cancelled';
        propertyId = stored.propertyId;
      }
    }

    await invalidateAvailabilityCache(propertyId);
    return reply.send({
      success: true,
      message: `Booking/Block ${bookingId} has been cancelled. Dates are reopened.`,
    });
  });
}
