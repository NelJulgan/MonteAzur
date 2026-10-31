/**
 * ============================================================================
 * MONTE AZUR ROUTES — ICAL EXPORT & SYNC (src/routes/ical.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (HTTP Response Headers & MIME Type)
 * - STAGE 2: CORE FUNCTIONALITY (GET /api/calendar.ics Feed Endpoint)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (POST /api/calendar/sync On-Demand Trigger)
 *
 * WHY THIS CODE EXISTS:
 * Serves the live iCalendar (.ics) subscription URL for external booking channels
 * (Airbnb, Agoda, Booking.com) to consume in real time.
 *
 * TRICKY LOGIC:
 * - Fastify requires raw text responses for `text/calendar` without JSON stringification.
 *   Uses `reply.type('text/calendar; charset=utf-8').send(icsContent)`.
 * ============================================================================
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateIcalFeed, syncExternalIcalFeeds } from '../services/ical.js';
import { requireAdminAuth } from './admin.js';

export default async function icalRoutes(fastify: FastifyInstance) {
  // STEP 1: Register GET /api/calendar.ics for Airbnb & OTA import
  fastify.get('/api/calendar.ics', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const propertyId = (req.query as any)?.propertyId;
      const icsData = await generateIcalFeed(propertyId);

      reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Content-Disposition', 'inline; filename="monte-azur.ics"')
        .header('Cache-Control', 'no-cache, no-store, must-revalidate')
        .send(icsData);
    } catch (err: any) {
      console.error('[iCal Route] Generation error:', err);
      return reply.status(500).send('ERROR: Could not generate calendar feed.');
    }
  });

  // STEP 2: Register POST /api/calendar/sync for immediate manual OTA sync (Protected by Admin Auth)
  fastify.post(
    '/api/calendar/sync',
    {
      preHandler: [requireAdminAuth],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const outcome = await syncExternalIcalFeeds();
      return reply.send({
        success: true,
        message: 'External channel synchronization finished.',
        importedCount: outcome.importedCount,
        errors: outcome.errors,
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        error: err.message,
      });
    }
  });
}
