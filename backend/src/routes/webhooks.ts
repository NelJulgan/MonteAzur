/**
 * ============================================================================
 * MONTE AZUR ROUTES — STRIPE WEBHOOKS (src/routes/webhooks.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Fastify Raw Body Route Registration & Signature Validation)
 * - STAGE 2: CORE FUNCTIONALITY (checkout.session.completed Handler & Database Update)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (BullMQ Email Dispatch & Cache Eviction)
 *
 * WHY THIS CODE EXISTS:
 * Serves as the authoritative, asynchronous webhook receiver for Stripe event callbacks.
 * Eliminates fraud and race conditions by waiting for cryptographic Stripe verification
 * before confirming reservations and sending private guest itineraries.
 *
 * TRICKY LOGIC:
 * - Uses `req.rawBody` provided by `fastify-raw-body`. If JSON body parsing mutates
 *   even a single whitespace or quote in the webhook payload, Stripe signature verification
 *   will fail mathematically.
 *
 * TODO:
 * - Handle `charge.refunded` event to cancel bookings automatically on disputes or refunds.
 * ============================================================================
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { constructWebhookEvent } from '../services/stripe.js';
import { pool, isDbLive, fallbackStore } from '../db/index.js';
import { invalidateAvailabilityCache } from '../services/redis.js';
import { enqueueBookingNotification } from '../services/queue.js';

export default async function webhookRoutes(fastify: FastifyInstance) {
  // STEP 1: Register POST /api/webhooks/stripe
  fastify.post(
    '/api/webhooks/stripe',
    {
      config: {
        rawBody: true, // Ensure fastify-raw-body captures the untransformed stream
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const signature = req.headers['stripe-signature'] as string;
      const rawPayload = (req as any).rawBody;

      if (!signature) {
        return reply.status(400).send({ error: 'Missing stripe-signature header' });
      }

      if (!rawPayload || (typeof rawPayload !== 'string' && !Buffer.isBuffer(rawPayload))) {
        return reply.status(400).send({
          error: 'Raw request body buffer unavailable for signature verification. Ensure fastify-raw-body is active.',
        });
      }

      let event: any;
      try {
        event = constructWebhookEvent(rawPayload, signature);
      } catch (err: any) {
        console.error(`❌ [Webhook] Stripe signature verification failed: ${err.message}`);
        return reply.status(400).send({ error: `Webhook Error: ${err.message}` });
      }

      console.log(`🔔 [Webhook] Received verified Stripe event: ${event.type}`);

      // ============================================================================
      // STAGE 2: CORE FUNCTIONALITY — Event Handlers
      // ============================================================================

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const bookingId = session.client_reference_id || session.metadata?.bookingId;
        const paymentIntentId = session.payment_intent as string;

        if (bookingId) {
          console.log(`✅ [Webhook] Checkout completed for booking: ${bookingId}`);

          let guestName = session.metadata?.guestName || session.customer_details?.name || 'Valued Guest';
          let guestEmail = session.customer_details?.email || session.customer_email || '';
          let propertyId = session.metadata?.propertyId;
          let checkIn = session.metadata?.checkIn || '';
          let checkOut = session.metadata?.checkOut || '';
          let totalPrice = session.amount_total ? session.amount_total / 100 : 0;

          if (isDbLive()) {
            try {
              const res = await pool.query(
                `UPDATE bookings 
                 SET status = 'confirmed', 
                     stripe_payment_intent_id = $1, 
                     hold_expires_at = NULL,
                     updated_at = NOW() 
                 WHERE id = $2 
                 RETURNING *`,
                [paymentIntentId, bookingId]
              );

              if (res.rows.length > 0) {
                const b = res.rows[0];
                guestName = b.guest_name;
                guestEmail = b.guest_email;
                propertyId = b.property_id;
                checkIn = b.check_in_date;
                checkOut = b.check_out_date;
                totalPrice = b.total_cents ? b.total_cents / 100 : totalPrice;
              }
            } catch (dbErr: any) {
              console.error(`[Webhook] Database update failed: ${dbErr.message}`);
            }
          } else {
            const stored = fallbackStore.bookings.get(bookingId);
            if (stored) {
              stored.status = 'confirmed';
              stored.stripePaymentIntentId = paymentIntentId;
              stored.holdExpiresAt = null;
              stored.updatedAt = new Date();
              guestName = stored.guestName;
              guestEmail = stored.guestEmail;
              propertyId = stored.propertyId;
              checkIn = stored.checkInDate;
              checkOut = stored.checkOutDate;
              totalPrice = stored.totalCents ? stored.totalCents / 100 : totalPrice;
            }
          }

          // ============================================================================
          // STAGE 3: ENHANCEMENT / OPTIMIZATION — Confirmation Queue & Cache Invalidation
          // ============================================================================

          if (propertyId) {
            await invalidateAvailabilityCache(propertyId);
          }

          // Enqueue confirmation job containing bookingId and cached metadata
          await enqueueBookingNotification(bookingId, {
            guestName,
            guestEmail,
            propertyName: 'Monte Azur Luxury Villa',
            checkIn,
            checkOut,
            totalPrice,
          });
        }
      } else if (event.type === 'checkout.session.expired') {
        const session = event.data.object;
        const bookingId = session.client_reference_id || session.metadata?.bookingId;

        if (bookingId) {
          console.log(`⌛ [Webhook] Checkout session expired for booking: ${bookingId}. Releasing dates.`);
          let propertyId = session.metadata?.propertyId;

          if (isDbLive()) {
            try {
              const res = await pool.query(
                `UPDATE bookings 
                 SET status = 'cancelled', 
                     hold_expires_at = NULL, 
                     updated_at = NOW() 
                 WHERE id = $1 
                 RETURNING property_id`,
                [bookingId]
              );
              if (res.rows.length > 0) {
                propertyId = res.rows[0].property_id;
              }
            } catch (err: any) {
              console.error(`[Webhook] Database update failed on expire: ${err.message}`);
            }
          } else {
            const stored = fallbackStore.bookings.get(bookingId);
            if (stored) {
              stored.status = 'cancelled';
              stored.holdExpiresAt = null;
              stored.updatedAt = new Date();
              propertyId = stored.propertyId;
            }
          }

          if (propertyId) {
            await invalidateAvailabilityCache(propertyId);
            console.log(`🧹 [Webhook] Redis availability cache busted for property ${propertyId}. Dates immediately reopened.`);
          }
        }
      }

      return reply.send({ received: true });
    }
  );
}
