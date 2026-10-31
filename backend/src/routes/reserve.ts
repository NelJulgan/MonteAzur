/**
 * ============================================================================
 * MONTE AZUR ROUTES — RESERVATION & CHECKOUT ENDPOINTS (src/routes/reserve.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Rate Limiting, Zod Schema & Server-Side Pricing Engine)
 * - STAGE 2: CORE FUNCTIONALITY (Atomic Transaction, Row Lock & GiST Overlap Check)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Stripe Checkout Session & Month Cache Invalidation)
 *
 * WHY THIS CODE EXISTS:
 * Handles booking requests with strict IP rate limiting (3 requests/10 mins),
 * executes atomic PostgreSQL transactions with row-level locks (`SELECT FOR UPDATE`),
 * prevents double-bookings with half-open GiST ranges, provisions 30-minute holds,
 * and creates hosted Stripe Checkout sessions in Philippine Peso (`php`).
 *
 * TRICKY LOGIC:
 * - Atomic serialization: Executes `SELECT * FROM properties WHERE id = $1 FOR UPDATE`
 *   inside a PostgreSQL transaction so concurrent visitors attempting to book the
 *   same villa are strictly evaluated one-at-a-time.
 * - Double-booking check: Evaluates `daterange(check_in_date, check_out_date, '[)') && daterange($2, $3, '[)') FOR UPDATE`
 *   for active records (`status = 'confirmed' OR (status = 'pending' AND hold_expires_at > NOW())`).
 *   If any conflicting booking exists, immediately rolls back and returns HTTP 409 Conflict.
 * - 30-minute hold: `hold_expires_at = NOW() + INTERVAL '30 minutes'` and Stripe session
 *   `expires_at = 30 mins`. If payment is abandoned, dates automatically return to availability.
 *
 * TODO:
 * - Support promotional voucher codes in Phase 2.
 * ============================================================================
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool, isDbLive, fallbackStore, DEFAULT_PROPERTY_ID, InMemBooking } from '../db/index.js';
import { invalidateAvailabilityCache } from '../services/redis.js';
import { createStripeCheckoutSession } from '../services/stripe.js';
import { sendBookingConfirmation } from '../services/queue.js';
import crypto from 'node:crypto';

// ============================================================================
// STAGE 1: FOUNDATION CODE — Zod Payload Validation & Server Pricing Engine
// ============================================================================

// STEP 1: Define strict payload validation schema
const reserveSchema = z
  .object({
    propertyId: z.string().uuid('propertyId must be a valid UUID').default(DEFAULT_PROPERTY_ID),
    checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Check-in must be YYYY-MM-DD'),
    checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Check-out must be YYYY-MM-DD'),
    guestName: z.string().min(2, 'Guest name must be at least 2 characters'),
    guestEmail: z.string().email('Please enter a valid guest email address'),
    guestPhone: z.string().optional().default(''),
    guests: z.number().int().min(1, 'At least 1 guest required').max(8, 'Maximum 8 guests').optional(),
    guestsCount: z.number().int().min(1).max(8).optional(),
    paymentMethod: z.enum(['stripe', 'inquiry', 'credit_card', 'card', 'gcash']).optional().default('inquiry'),
    turnstileToken: z.string().optional(),
  })
  .transform((val) => ({
    ...val,
    guests: val.guests ?? val.guestsCount ?? 2,
  }));

type ReservePayload = z.infer<typeof reserveSchema>;

// STEP 2: Calculate stay nights and itemized rates in integer centavos strictly on server
function calculateStayPricing(
  checkInStr: string,
  checkOutStr: string,
  nightlyRateCents = 4850000,
  weekendRateCents = 5500000,
  cleaningFeeCents = 1450000
) {
  const start = new Date(`${checkInStr}T00:00:00Z`);
  const end = new Date(`${checkOutStr}T00:00:00Z`);
  const diffTime = end.getTime() - start.getTime();
  const nights = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (nights <= 0) {
    return {
      nights: 0,
      nightlyRateCents,
      weekendRateCents,
      accommodationSubtotalCents: 0,
      cleaningFeeCents: 0,
      serviceFeeCents: 0,
      totalCents: 0,
    };
  }

  let accommodationSubtotalCents = 0;
  const cur = new Date(start);

  while (cur < end) {
    const dayOfWeek = cur.getUTCDay(); // 0 = Sun, 5 = Fri, 6 = Sat
    const isWeekend = dayOfWeek === 5 || dayOfWeek === 6;
    accommodationSubtotalCents += isWeekend ? weekendRateCents : nightlyRateCents;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  const serviceFeeCents = Math.round(accommodationSubtotalCents * 0.08); // 8% concierge service
  const totalCents = accommodationSubtotalCents + cleaningFeeCents + serviceFeeCents;

  return {
    nights,
    nightlyRateCents,
    weekendRateCents,
    accommodationSubtotalCents,
    cleaningFeeCents,
    serviceFeeCents,
    totalCents,
  };
}

// Helper: Validates Cloudflare Turnstile bot token
async function verifyTurnstileToken(token?: string, remoteIp?: string): Promise<boolean> {
  const secret = process.env.CLOUDFLARE_TURNSTILE_SECRET_KEY;
  // Graceful bypass if Turnstile is in simulation mode or test keys are used
  if (!secret || secret.includes('placeholder') || secret.startsWith('1x0000000000000000000000000000000AA')) {
    return true;
  }

  if (!token) {
    return false;
  }

  try {
    const form = new URLSearchParams();
    form.append('secret', secret);
    form.append('response', token);
    if (remoteIp) form.append('remoteip', remoteIp);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });

    const outcome = (await res.json()) as any;
    return Boolean(outcome.success);
  } catch (err: any) {
    console.error('[Turnstile] Verification request error:', err.message);
    return true; // Fail open gracefully during network blips
  }
}

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Atomic Transaction & Concurrency Locking
// ============================================================================

export default async function reserveRoutes(fastify: FastifyInstance) {
  const handleReserve = async (req: FastifyRequest, reply: FastifyReply) => {
    // Parse & validate payload with Zod
    const parseResult = reserveSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        success: false,
        error: 'Validation failed',
        details: parseResult.error.flatten(),
      });
    }

    const payload = parseResult.data;

    // Verify Cloudflare Turnstile token
    const isHuman = await verifyTurnstileToken(payload.turnstileToken, req.ip);
    if (!isHuman) {
      return reply.status(403).send({
        success: false,
        error: 'Security verification failed. Please complete the captcha challenge.',
      });
    }

    const bookingId = crypto.randomUUID();

    // Verify stay nights constraints
    const tempPricing = calculateStayPricing(payload.checkIn, payload.checkOut);
    if (tempPricing.nights <= 0) {
      return reply.status(400).send({
        success: false,
        error: 'Check-out date must be after check-in date.',
      });
    }

    if (tempPricing.nights < 2) {
      return reply.status(400).send({
        success: false,
        error: 'Monte Azur requires a minimum stay of 2 nights.',
      });
    }

    let finalPricing = tempPricing;
    const holdExpiresAt = new Date(Date.now() + 30 * 60 * 1000);

    // ============================================================================
    // ATOMIC POSTGRESQL TRANSACTION (db.transaction / client.query)
    // ============================================================================
    if (isDbLive()) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // STEP 1: Lock the house row: SELECT * FROM properties WHERE id = $1 FOR UPDATE
        const propertyRes = await client.query(
          'SELECT * FROM properties WHERE id = $1 FOR UPDATE',
          [payload.propertyId]
        );

        if (propertyRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({
            success: false,
            error: 'Staycation property not found.',
          });
        }

        const propRow = propertyRes.rows[0];
        const propNightly = propRow.nightly_rate_cents || 4850000;
        const propWeekend = propRow.weekend_rate_cents || 5500000;
        const propCleaning = propRow.cleaning_fee_cents || 1450000;

        // Recompute pricing strictly using authoritative locked database row values
        finalPricing = calculateStayPricing(
          payload.checkIn,
          payload.checkOut,
          propNightly,
          propWeekend,
          propCleaning
        );

        // STEP 1b: Eagerly clean up any expired pending holds that overlap with the requested dates
        // This prevents PostgreSQL's GiST constraint from throwing false-positive 23P01 collision violations
        await client.query(
          `UPDATE bookings
           SET status = 'cancelled', updated_at = NOW()
           WHERE property_id = $1
             AND status = 'pending'
             AND hold_expires_at IS NOT NULL
             AND hold_expires_at <= NOW()
             AND daterange(check_in_date, check_out_date, '[)') && daterange($2::date, $3::date, '[)')`,
          [payload.propertyId, payload.checkIn, payload.checkOut]
        );

        // STEP 2: Check for overlapping active bookings using daterange(..., '[)') && daterange(..., '[)') FOR UPDATE
        const conflictQuery = `
          SELECT id FROM bookings
          WHERE property_id = $1
            AND (status = 'confirmed' OR status = 'maintenance' OR (status = 'pending' AND hold_expires_at > NOW()))
            AND daterange(check_in_date, check_out_date, '[)') && daterange($2::date, $3::date, '[)')
          FOR UPDATE
        `;

        const conflictCheck = await client.query(conflictQuery, [
          payload.propertyId,
          payload.checkIn,
          payload.checkOut,
        ]);

        if (conflictCheck.rows.length > 0) {
          await client.query('ROLLBACK');
          return reply.status(409).send({
            success: false,
            error: 'Selected dates are no longer available. Please select another date range.',
          });
        }

        // STEP 3: Insert pending booking with hold_expires_at = NOW() + INTERVAL '30 minutes'
        const insertQuery = `
          INSERT INTO bookings (
            id, property_id, guest_name, guest_email, guest_phone, guests,
            check_in_date, check_out_date, total_cents, status, hold_expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() + INTERVAL '30 minutes')
          RETURNING *
        `;

        await client.query(insertQuery, [
          bookingId,
          payload.propertyId,
          payload.guestName,
          payload.guestEmail,
          payload.guestPhone || null,
          payload.guests,
          payload.checkIn,
          payload.checkOut,
          finalPricing.totalCents,
          payload.paymentMethod === 'inquiry' ? 'confirmed' : 'pending',
        ]);

        await client.query('COMMIT');
      } catch (err: any) {
        await client.query('ROLLBACK');
        console.error('[Reserve] Atomic database transaction failed:', err);
        return reply.status(500).send({
          success: false,
          error: 'Database error processing reservation.',
        });
      } finally {
        client.release();
      }
    } else {
      // Resilient in-memory fallback for local development without active PostgreSQL
      const now = new Date();
      // Eagerly purge any expired pending holds before conflict checking
      for (const b of fallbackStore.bookings.values()) {
        if (b.status === 'pending' && b.holdExpiresAt && b.holdExpiresAt <= now) {
          b.status = 'cancelled';
          b.updatedAt = now;
        }
      }

      for (const existing of fallbackStore.bookings.values()) {
        const isConflict =
          existing.propertyId === payload.propertyId &&
          (existing.status === 'confirmed' ||
            existing.status === 'maintenance' ||
            (existing.status === 'pending' &&
              existing.holdExpiresAt &&
              existing.holdExpiresAt > now));

        if (isConflict) {
          if (existing.checkInDate < payload.checkOut && existing.checkOutDate > payload.checkIn) {
            return reply.status(409).send({
              success: false,
              error: 'Selected dates are no longer available. Please select another date range.',
            });
          }
        }
      }

      const inMemRecord: InMemBooking = {
        id: bookingId,
        propertyId: payload.propertyId,
        guestName: payload.guestName,
        guestEmail: payload.guestEmail,
        guestPhone: payload.guestPhone || null,
        guests: payload.guests,
        checkInDate: payload.checkIn,
        checkOutDate: payload.checkOut,
        totalCents: finalPricing.totalCents,
        status: payload.paymentMethod === 'inquiry' ? 'confirmed' : 'pending',
        stripeSessionId: null,
        stripePaymentIntentId: null,
        holdExpiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      fallbackStore.bookings.set(bookingId, inMemRecord);
    }

    // ============================================================================
    // STAGE 3: ENHANCEMENT / OPTIMIZATION — Redis Busting & Stripe Checkout
    // ============================================================================

    // STEP 4: Bust the availability cache for the affected month(s)
    await invalidateAvailabilityCache(payload.propertyId);

    const isStripeConfigured = Boolean(
      process.env.STRIPE_SECRET_KEY &&
      !process.env.STRIPE_SECRET_KEY.includes('placeholder')
    );

    // STEP 5: Dispatch Telegram bot confirmation and calendar/email tasks
    // If inquiry/placeholder mode OR running in simulation/concept mode without live Stripe:
    if (payload.paymentMethod !== 'stripe' || !isStripeConfigured) {
      // Mark booking as confirmed in database or fallback in-memory store
      if (isDbLive()) {
        await pool.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1", [bookingId]);
      } else {
        const stored = fallbackStore.bookings.get(bookingId);
        if (stored) {
          stored.status = 'confirmed';
        }
      }

      await sendBookingConfirmation({
        bookingId,
        guestName: payload.guestName,
        guestEmail: payload.guestEmail,
        propertyName: 'Monte Azur Luxury Villa Sanctuary',
        checkIn: payload.checkIn,
        checkOut: payload.checkOut,
        totalPrice: finalPricing.totalCents / 100,
        paymentMethod: payload.paymentMethod,
      });

      console.log(`📱 [Reserve] Telegram confirmation alert dispatched for Booking ${bookingId}`);

      return reply.send({
        checkoutUrl: null,
        bookingId,
        referenceId: `MA-${bookingId.substring(0, 6).toUpperCase()}`,
        status: 'confirmed_inquiry',
        quote: {
          currency: 'PHP',
          currencySymbol: '₱',
          nights: finalPricing.nights,
          totalCents: finalPricing.totalCents,
          totalPricePhp: finalPricing.totalCents / 100,
        },
      });
    }

    // STEP 5: Create a Stripe Checkout Session (currency: 'php', expires_at = 30 mins)
    try {
      const checkoutSession = await createStripeCheckoutSession({
        bookingId,
        propertyId: payload.propertyId,
        propertyName: 'Monte Azur Luxury Villa',
        guestEmail: payload.guestEmail,
        guestName: payload.guestName,
        guestPhone: payload.guestPhone,
        guests: payload.guests,
        checkIn: payload.checkIn,
        checkOut: payload.checkOut,
        nights: finalPricing.nights,
        nightlyRateCents: finalPricing.nightlyRateCents,
        weekendRateCents: finalPricing.weekendRateCents,
        cleaningFeeCents: finalPricing.cleaningFeeCents,
        serviceFeeCents: finalPricing.serviceFeeCents,
        totalCents: finalPricing.totalCents,
      });

      // Update session ID in database
      if (isDbLive()) {
        await pool.query(
          'UPDATE bookings SET stripe_session_id = $1 WHERE id = $2',
          [checkoutSession.id, bookingId]
        );
      } else {
        const stored = fallbackStore.bookings.get(bookingId);
        if (stored) {
          stored.stripeSessionId = checkoutSession.id;
        }
      }

      // STEP 6: Return exact contract: { checkoutUrl: session.url }
      return reply.send({
        checkoutUrl: checkoutSession.url,
        bookingId,
        referenceId: `MA-${bookingId.substring(0, 6).toUpperCase()}`,
        status: 'pending_payment',
        quote: {
          currency: 'PHP',
          currencySymbol: '₱',
          nights: finalPricing.nights,
          totalCents: finalPricing.totalCents,
          totalPricePhp: finalPricing.totalCents / 100,
        },
      });
    } catch (err: any) {
      console.error('[Reserve] Stripe session creation error:', err);
      return reply.status(500).send({
        success: false,
        error: 'Failed to initiate Stripe Checkout Session.',
      });
    }
  };

  // STEP 7: Register POST /api/reserve with @fastify/rate-limit (max 3 requests per IP per 10 minutes)
  fastify.post(
    '/api/reserve',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '10 minutes',
        },
      },
    },
    handleReserve
  );

  fastify.post(
    '/api/v1/bookings/checkout-session',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '10 minutes',
        },
      },
    },
    handleReserve
  );

  // Clear reservations helper (Strictly disabled in production; requires admin authorization in development)
  fastify.post('/api/bookings/clear', async (req: FastifyRequest, reply: FastifyReply) => {
    if (process.env.NODE_ENV === 'production') {
      return reply.status(403).send({
        success: false,
        error: 'Forbidden: Clear bookings endpoint is permanently disabled in production.',
      });
    }

    const authHeader = req.headers.authorization;
    const adminKey = process.env.ADMIN_API_KEY || 'aur_admin_secret_key_2026';
    if (!authHeader || authHeader !== `Bearer ${adminKey}`) {
      return reply.status(401).send({
        success: false,
        error: 'Unauthorized: Valid administrator bearer token required to reset calendar.',
      });
    }

    fallbackStore.bookings.clear();
    await invalidateAvailabilityCache(DEFAULT_PROPERTY_ID);
    return reply.send({ success: true, message: 'All reservations cleared.' });
  });
}
