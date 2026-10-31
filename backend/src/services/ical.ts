/**
 * ============================================================================
 * MONTE AZUR SERVICES — ICAL CHANNEL BI-DIRECTIONAL SYNC (src/services/ical.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (iCal Feed Configuration & Timezone Normalization)
 * - STAGE 2: CORE FUNCTIONALITY (Live .ics Generation for Airbnb/Agoda/Booking.com)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (External OTA Calendar Ingestion & Collision Sync)
 *
 * WHY THIS CODE EXISTS:
 * Enables bi-directional calendar synchronization between the direct staycation
 * website and external Online Travel Agencies (OTAs) such as Airbnb, VRBO, Agoda,
 * and Booking.com.
 * 1. Export (`generateIcalFeed`): Generates a standardized RFC 5545 `.ics` feed
 *    that management pastes into Airbnb to prevent double-booking direct guests.
 * 2. Import (`syncExternalIcalFeeds`): Ingests external OTA calendar links on an
 *    hourly schedule, marking dates blocked on Airbnb as 'maintenance' blocks
 *    on the direct website.
 *
 * TRICKY LOGIC:
 * - Half-open intervals: iCal check-in begins at 15:00 (3:00 PM) PHT, and check-out
 *   ends at 11:00 AM PHT. Expressing this in explicit UTC timestamps prevents OTAs
 *   from erroneously blocking checkout days for incoming arrivals.
 * - Deduplication: Uses the external iCal `UID` mapped to `stripe_session_id` (`ical_<UID>`)
 *   to ensure repeat sync cycles are idempotent and never create duplicate records.
 *
 * TODO:
 * - Support multi-property calendar feed routing via URL query parameters.
 * ============================================================================
 */

import ical, { ICalCalendarMethod } from 'ical-generator';
import nodeIcal from 'node-ical';
import crypto from 'crypto';
import { pool, isDbLive, fallbackStore, DEFAULT_PROPERTY_ID, InMemBooking } from '../db/index.js';
import { invalidateAvailabilityCache } from './redis.js';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// STAGE 1: FOUNDATION CODE — Feed Configuration & Time Helpers
// ============================================================================

function formatDateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Live .ics Export Generation
// ============================================================================

/**
 * Generates an RFC 5545 compliant .ics calendar feed for all confirmed stays.
 * @param {string} [propertyId=DEFAULT_PROPERTY_ID]
 * @returns {Promise<string>} .ics calendar data string
 */
export async function generateIcalFeed(propertyId: string = DEFAULT_PROPERTY_ID): Promise<string> {
  const calendar = (ical as any)({
    name: 'Monte Azur Sanctuary — Direct Reservations',
    timezone: 'Asia/Manila',
    method: ICalCalendarMethod.PUBLISH,
  });

  const confirmedStays: Array<{
    id: string;
    checkInDate: string;
    checkOutDate: string;
    guestName: string;
    status: string;
  }> = [];

  if (isDbLive()) {
    try {
      const res = await pool.query(
        `SELECT id, check_in_date, check_out_date, guest_name, status 
         FROM bookings 
         WHERE property_id = $1 
           AND status IN ('confirmed', 'maintenance')
         ORDER BY check_in_date ASC`,
        [propertyId]
      );
      for (const row of res.rows) {
        confirmedStays.push({
          id: row.id,
          checkInDate: row.check_in_date,
          checkOutDate: row.check_out_date,
          guestName: row.guest_name,
          status: row.status,
        });
      }
    } catch (err: any) {
      console.warn(`[iCal Export] Database query failed (${err.message}). Using fallback.`);
    }
  }

  // Fallback store integration
  if (confirmedStays.length === 0) {
    for (const b of fallbackStore.bookings.values()) {
      if (b.propertyId === propertyId && (b.status === 'confirmed' || b.status === 'maintenance')) {
        confirmedStays.push({
          id: b.id,
          checkInDate: b.checkInDate,
          checkOutDate: b.checkOutDate,
          guestName: b.guestName,
          status: b.status,
        });
      }
    }
  }

  // STEP 1: Add each confirmed reservation to the iCal calendar
  for (const stay of confirmedStays) {
    // 3:00 PM Check-In PHT (07:00 UTC)
    const startDate = new Date(`${stay.checkInDate}T07:00:00Z`);
    // 11:00 AM Check-Out PHT (03:00 UTC)
    const endDate = new Date(`${stay.checkOutDate}T03:00:00Z`);

    const isMaintenance = stay.status === 'maintenance';
    const summary = isMaintenance
      ? `Blocked: ${stay.guestName || 'Maintenance'}`
      : 'Reserved — Monte Azur Sanctuary';

    calendar.createEvent({
      id: stay.id,
      start: startDate,
      end: endDate,
      summary,
      description: `Reference: ${stay.id}\nProperty: Monte Azur Luxury Sanctuary`,
      location: 'Monte Azur Sanctuary, Batangas, Philippines',
      status: 'CONFIRMED',
    });
  }

  return calendar.toString();
}

// ============================================================================
// STAGE 3: ENHANCEMENT / OPTIMIZATION — External Channel Ingestion & Cron Sync
// ============================================================================

/**
 * Fetches external .ics calendar URLs (e.g. Airbnb export) and creates maintenance blocks.
 * @returns {Promise<{ importedCount: number, errors: string[] }>}
 */
export async function syncExternalIcalFeeds(): Promise<{ importedCount: number; errors: string[] }> {
  const rawUrls = process.env.EXTERNAL_ICAL_URLS || '';
  const urls = rawUrls
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.startsWith('http://') || u.startsWith('https://'));

  if (urls.length === 0) {
    return { importedCount: 0, errors: [] };
  }

  console.log(`🔄 [iCal Sync] Synchronizing ${urls.length} external calendar feed(s)...`);
  let importedCount = 0;
  const errors: string[] = [];

  for (const url of urls) {
    try {
      const events = await (nodeIcal as any).async.fromURL(url);

      for (const key of Object.keys(events)) {
        const item = events[key];
        if (item.type !== 'VEVENT' || !item.start || !item.end) continue;

        const startStr = formatDateKey(new Date(item.start));
        const endStr = formatDateKey(new Date(item.end));

        if (startStr >= endStr) continue;

        const externalUid = `ical_${item.uid || key}`;
        const summary = item.summary || 'External Channel Reservation (Airbnb/OTA)';

        if (isDbLive()) {
          // Idempotent insertion: checks if UID already exists
          const existing = await pool.query(
            'SELECT id FROM bookings WHERE stripe_session_id = $1 LIMIT 1',
            [externalUid]
          );

          if (existing.rows.length === 0) {
            // Check for conflict
            const conflict = await pool.query(
              `SELECT id FROM bookings 
               WHERE property_id = $1 
                 AND status IN ('confirmed', 'maintenance')
                 AND daterange(check_in_date, check_out_date, '[)') && daterange($2::date, $3::date, '[)')`,
              [DEFAULT_PROPERTY_ID, startStr, endStr]
            );

            if (conflict.rows.length === 0) {
              await pool.query(
                `INSERT INTO bookings (
                  id, property_id, guest_name, guest_email, check_in_date, check_out_date,
                  total_cents, status, stripe_session_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                  crypto.randomUUID(),
                  DEFAULT_PROPERTY_ID,
                  summary,
                  'channel-sync@monteazur.com',
                  startStr,
                  endStr,
                  0,
                  'maintenance',
                  externalUid,
                ]
              );
              importedCount++;
            }
          }
        } else {
          // In-memory fallback deduplication
          const alreadyImported = Array.from(fallbackStore.bookings.values()).some(
            (b) => b.stripeSessionId === externalUid
          );

          if (!alreadyImported) {
            const newId = crypto.randomUUID();
            const rec: InMemBooking = {
              id: newId,
              propertyId: DEFAULT_PROPERTY_ID,
              guestName: summary,
              guestEmail: 'channel-sync@monteazur.com',
              guestPhone: null,
              guests: 2,
              checkInDate: startStr,
              checkOutDate: endStr,
              totalCents: 0,
              status: 'maintenance',
              stripeSessionId: externalUid,
              stripePaymentIntentId: null,
              holdExpiresAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            fallbackStore.bookings.set(newId, rec);
            importedCount++;
          }
        }
      }
    } catch (err: any) {
      console.error(`❌ [iCal Sync] Error syncing URL ${url}:`, err.message);
      errors.push(`URL ${url}: ${err.message}`);
    }
  }

  if (importedCount > 0) {
    console.log(`✅ [iCal Sync] Successfully imported ${importedCount} external OTA block(s).`);
    await invalidateAvailabilityCache(DEFAULT_PROPERTY_ID);
  }

  return { importedCount, errors };
}

let icalTimer: NodeJS.Timeout | null = null;

/**
 * Starts the hourly iCal sync cron worker.
 * @param {number} [intervalMs=3600000] Interval in milliseconds (default: 1 hour)
 */
export function startIcalSyncCron(intervalMs: number = 60 * 60 * 1000): void {
  if (icalTimer) return;

  console.log(`⏱️ [iCal Sync] Initializing Channel Sync Worker (interval: ${intervalMs / 1000 / 60}m).`);

  // Run initial pass after 10-second startup delay
  setTimeout(() => {
    syncExternalIcalFeeds().catch((err) => {
      console.warn('[iCal Sync] Initial pass skipped:', err.message);
    });
  }, 10000);

  icalTimer = setInterval(() => {
    syncExternalIcalFeeds().catch((err) => {
      console.error('[iCal Sync] Hourly pass error:', err.message);
    });
  }, intervalMs);

  if (icalTimer && typeof icalTimer.unref === 'function') {
    icalTimer.unref();
  }
}

export function stopIcalSyncCron(): void {
  if (icalTimer) {
    clearInterval(icalTimer);
    icalTimer = null;
    console.log('🛑 [iCal Sync] Channel Sync Worker stopped.');
  }
}
