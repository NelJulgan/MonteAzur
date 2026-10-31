/**
 * ============================================================================
 * MONTE AZUR SERVICES — ASYNC NOTIFICATION WORKER (src/services/worker.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Client Credentials & Service Account Setup)
 * - STAGE 2: CORE FUNCTIONALITY (Resend HTML Email & Google Calendar Event Push)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Database Row Hydration & In-Process Worker Lifecycle)
 *
 * WHY THIS CODE EXISTS:
 * Processes booking notification jobs asynchronously.
 * 1. Emails the guest a branded itinerary + villa guide via Resend.
 * 2. Synchronizes stay dates to management's Google Calendar via Google Service Account JWT.
 * 3. Dispatches immediate Telegram alerts to property managers.
 *
 * TRICKY LOGIC:
 * - Google Calendar Service Account private keys stored in `.env` often contain literal
 *   escaped `\n` characters which must be converted to real newlines (`.replace(/\\n/g, '\n')`)
 *   or OpenSSL key parsing will throw an `ERR_OSSL_PEM_NO_START_LINE` error.
 * - Operates entirely in-process using Node.js event-loop dispatching without requiring
 *   external BullMQ or Redis instances for concept mode.
 *
 * TODO:
 * - Sync cancellation events to Google Calendar to delete or strike-out cancelled stays.
 * ============================================================================
 */

import { Resend } from 'resend';
import { google } from 'googleapis';
import { pool, isDbLive, fallbackStore } from '../db/index.js';
import {
  BookingNotificationPayload,
  registerFallbackProcessor,
} from './queue.js';
import { sendTelegramBookingAlert } from './telegram.js';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// STAGE 1: FOUNDATION CODE — Client Initializations & JWT Authentication
// ============================================================================

// STEP 1: Initialize Resend Client
const resendApiKey = process.env.RESEND_API_KEY || 're_placeholder';
const resend = new Resend(resendApiKey);
const isResendConfigured = resendApiKey && !resendApiKey.includes('placeholder');

// STEP 2: Initialize Google Calendar API via Service Account JWT
const googleClientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL || '';
const rawGooglePrivateKey = process.env.GOOGLE_PRIVATE_KEY || '';
const googlePrivateKey = rawGooglePrivateKey.replace(/\\n/g, '\n');
const googleCalendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

const isGoogleCalendarConfigured =
  googleClientEmail &&
  googlePrivateKey &&
  !googleClientEmail.includes('placeholder') &&
  !googlePrivateKey.includes('placeholder');

let calendarClient: any = null;

if (isGoogleCalendarConfigured) {
  try {
    const jwtClient = new google.auth.JWT({
      email: googleClientEmail,
      key: googlePrivateKey,
      scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
    });

    calendarClient = google.calendar({ version: 'v3', auth: jwtClient });
    console.log('✅ [Google Calendar] Service Account JWT successfully configured.');
  } catch (err: any) {
    console.warn(`⚠️ [Google Calendar] JWT initialization error: ${err.message}`);
  }
} else {
  console.log('ℹ️ [Google Calendar] Service Account credentials not provided. Calendar sync running in simulation mode.');
}

// STEP 3: Booking data fetcher (hydrates full booking record by UUID)
interface HydratedBooking {
  id: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string;
  guests: number;
  checkInDate: string;
  checkOutDate: string;
  totalPriceCents: number;
  totalPrice: number;
  propertyName: string;
  paymentMethod?: string | null;
}

async function hydrateBookingDetails(payload: BookingNotificationPayload): Promise<HydratedBooking> {
  const defaultPropertyName = 'Monte Azur Luxury Villa Sanctuary';

  if (isDbLive()) {
    try {
      const res = await pool.query(
        `SELECT b.*, p.name as property_name 
         FROM bookings b
         LEFT JOIN properties p ON b.property_id = p.id
         WHERE b.id = $1`,
        [payload.bookingId]
      );

      if (res.rows.length > 0) {
        const row = res.rows[0];
        const totalCents = Number(row.total_cents) || 0;
        return {
          id: row.id,
          guestName: row.guest_name || payload.guestName || 'Valued Guest',
          guestEmail: row.guest_email || payload.guestEmail || '',
          guestPhone: row.guest_phone || '',
          guests: Number(row.guests) || 2,
          checkInDate: row.check_in_date,
          checkOutDate: row.check_out_date,
          totalPriceCents: totalCents,
          totalPrice: totalCents ? totalCents / 100 : (payload.totalPrice || 0),
          propertyName: row.property_name || payload.propertyName || defaultPropertyName,
          paymentMethod: payload.paymentMethod || null,
        };
      }
    } catch (dbErr: any) {
      console.warn(`[Worker] Database lookup failed for booking ${payload.bookingId}:`, dbErr.message);
    }
  }

  // Fallback store lookup or payload pass-through
  const stored = fallbackStore.bookings.get(payload.bookingId);
  if (stored) {
    return {
      id: stored.id,
      guestName: stored.guestName || payload.guestName || 'Valued Guest',
      guestEmail: stored.guestEmail || payload.guestEmail || '',
      guestPhone: stored.guestPhone || '',
      guests: stored.guests || 2,
      checkInDate: stored.checkInDate || payload.checkIn || '',
      checkOutDate: stored.checkOutDate || payload.checkOut || '',
      totalPriceCents: stored.totalCents || 0,
      totalPrice: stored.totalCents ? stored.totalCents / 100 : (payload.totalPrice || 0),
      propertyName: payload.propertyName || defaultPropertyName,
      paymentMethod: payload.paymentMethod || null,
    };
  }

  return {
    id: payload.bookingId,
    guestName: payload.guestName || 'Valued Guest',
    guestEmail: payload.guestEmail || 'guest@example.com',
    guestPhone: '',
    guests: 2,
    checkInDate: payload.checkIn || '2026-11-01',
    checkOutDate: payload.checkOut || '2026-11-04',
    totalPriceCents: (payload.totalPrice || 0) * 100,
    totalPrice: payload.totalPrice || 0,
    propertyName: payload.propertyName || defaultPropertyName,
    paymentMethod: payload.paymentMethod || null,
  };
}

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Resend Email & Google Calendar Actions
// ============================================================================

/**
 * Action 1: Sends professional confirmation email using Resend
 */
async function sendGuestConfirmationEmail(booking: HydratedBooking): Promise<void> {
  console.log(`\n============================================================`);
  console.log(`✉️ [Worker — Resend] Preparing Confirmation Email for: ${booking.guestEmail}`);
  console.log(`Guest: ${booking.guestName} | Stay: ${booking.checkInDate} → ${booking.checkOutDate}`);
  console.log(`Total Paid: ₱${booking.totalPrice.toLocaleString()} PHP`);
  console.log(`============================================================\n`);

  if (!isResendConfigured) {
    console.log(`ℹ️ [Worker — Resend] RESEND_API_KEY is not set or in demo mode. Simulated email logged successfully.`);
    return;
  }

  const fromAddress = process.env.EMAIL_FROM || 'reservations@monteazur.com';

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Booking Confirmed — Monte Azur</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #0b0f0e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #f4efe6;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 620px; margin: 40px auto; background-color: #111715; border: 1px solid rgba(212, 175, 55, 0.25); border-radius: 8px; overflow: hidden;">
        <!-- Header -->
        <tr>
          <td style="padding: 40px 36px; text-align: center; background: linear-gradient(180deg, #16201c 0%, #111715 100%); border-bottom: 1px solid rgba(212, 175, 55, 0.2);">
            <p style="margin: 0 0 8px 0; color: #d4af37; font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase;">Private Luxury Sanctuary</p>
            <h1 style="margin: 0; color: #ffffff; font-size: 26px; font-weight: 400; letter-spacing: 0.05em; font-family: Georgia, serif;">MONTE AZUR</h1>
          </td>
        </tr>
        
        <!-- Welcome Message -->
        <tr>
          <td style="padding: 36px 36px 20px 36px;">
            <p style="margin: 0 0 16px 0; font-size: 16px; color: #e4dfd7;">Dear ${booking.guestName},</p>
            <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #b8b5ae;">
              Your stay at <strong>${booking.propertyName}</strong> is officially confirmed. Our estate team is preparing for your arrival.
            </p>

            <!-- Reservation Card -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background-color: rgba(212, 175, 55, 0.05); border: 1px solid rgba(212, 175, 55, 0.2); border-radius: 6px; margin-bottom: 28px;">
              <tr>
                <td style="padding: 20px 24px;">
                  <table width="100%" cellpadding="6" cellspacing="0" style="font-size: 14px;">
                    <tr>
                      <td style="color: #9e9b94; width: 40%;">Reservation Reference:</td>
                      <td style="color: #d4af37; font-weight: 600; font-family: monospace; font-size: 15px;">${booking.id}</td>
                    </tr>
                    <tr>
                      <td style="color: #9e9b94;">Check-In:</td>
                      <td style="color: #ffffff; font-weight: 500;">${booking.checkInDate} (From 3:00 PM PHT)</td>
                    </tr>
                    <tr>
                      <td style="color: #9e9b94;">Check-Out:</td>
                      <td style="color: #ffffff; font-weight: 500;">${booking.checkOutDate} (Until 11:00 AM PHT)</td>
                    </tr>
                    <tr>
                      <td style="color: #9e9b94;">Guest Party:</td>
                      <td style="color: #ffffff;">${booking.guests} Guest${booking.guests > 1 ? 's' : ''}</td>
                    </tr>
                    <tr>
                      <td style="color: #9e9b94;">Total Paid:</td>
                      <td style="color: #d4af37; font-weight: 600; font-size: 16px;">₱${booking.totalPrice.toLocaleString()} PHP</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- House Instructions -->
            <h3 style="margin: 0 0 12px 0; color: #d4af37; font-size: 14px; letter-spacing: 0.1em; text-transform: uppercase;">Villa Instructions & Arrival</h3>
            <ul style="margin: 0 0 28px 0; padding-left: 20px; font-size: 14px; line-height: 1.8; color: #c8c5be;">
              <li><strong>Gate Access:</strong> Keyless smart-lock passcode will be sent via SMS 24 hours prior to check-in.</li>
              <li><strong>Infinity Pool & Spa:</strong> Heated automatically between 6:00 AM and 10:00 PM daily.</li>
              <li><strong>Quiet Hours:</strong> We honor the serenity of the cove; outdoor sound is restricted after 10:00 PM.</li>
              <li><strong>Concierge Service:</strong> Your dedicated butler can arrange private yacht charters, private chefs, and massages.</li>
            </ul>

            <p style="margin: 0 0 10px 0; font-size: 14px; color: #9e9b94;">
              If you require airport transfers or bespoke requests, contact our concierge desk directly at <a href="mailto:concierge@monteazur.com" style="color: #d4af37; text-decoration: none;">concierge@monteazur.com</a>.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding: 24px 36px; background-color: #0c1110; border-top: 1px solid rgba(255, 255, 255, 0.08); text-align: center;">
            <p style="margin: 0; font-size: 12px; color: #6e6b65;">
              Monte Azur Sanctuary • Batangas Seaside Escarpment • Philippines
            </p>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  await resend.emails.send({
    from: fromAddress,
    to: booking.guestEmail,
    subject: `Confirmed Itinerary: Your Stay at Monte Azur (${booking.checkInDate})`,
    html: htmlContent,
  });

  console.log(`✅ [Worker — Resend] Confirmation email successfully delivered to ${booking.guestEmail}`);
}

/**
 * Action 2: Pushes reservation event to Google Calendar
 */
async function pushReservationToGoogleCalendar(booking: HydratedBooking): Promise<void> {
  console.log(`📅 [Worker — Google Calendar] Syncing reservation ${booking.id} to Google Calendar...`);

  if (!calendarClient) {
    console.log(`ℹ️ [Worker — Google Calendar] Calendar client not configured. Simulated event sync logged:`);
    console.log(`   Summary: Reservation: ${booking.guestName} (${booking.guests} Guests)`);
    console.log(`   Dates: ${booking.checkInDate} to ${booking.checkOutDate}`);
    return;
  }

  try {
    const event = {
      summary: `Stay: ${booking.guestName} (${booking.guests} Guests) — Monte Azur`,
      description: [
        `Villa Reservation Reference: ${booking.id}`,
        `Guest Name: ${booking.guestName}`,
        `Guest Email: ${booking.guestEmail}`,
        `Guest Phone: ${booking.guestPhone || 'Not provided'}`,
        `Party Size: ${booking.guests} Guests`,
        `Total Paid: ₱${booking.totalPrice.toLocaleString()} PHP`,
        `Check-In: ${booking.checkInDate} (3:00 PM)`,
        `Check-Out: ${booking.checkOutDate} (11:00 AM)`,
      ].join('\n'),
      start: {
        date: booking.checkInDate, // All-day entry
      },
      end: {
        date: booking.checkOutDate,
      },
      colorId: '2', // Sage green in Google Calendar palette
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 120 },     // 2 hours before
        ],
      },
    };

    const res = await calendarClient.events.insert({
      calendarId: googleCalendarId,
      requestBody: event,
    });

    console.log(`✅ [Worker — Google Calendar] Event created on management calendar: ${res.data.htmlLink || res.data.id}`);
  } catch (err: any) {
    console.error(`❌ [Worker — Google Calendar] Failed to push event (${err.message}).`);
  }
}

// ============================================================================
// STAGE 3: ENHANCEMENT / OPTIMIZATION — Master Job Processor & Worker Lifecycle
// ============================================================================

/**
 * Master processor that executes Resend, Google Calendar, and Telegram alert actions.
 */
export async function processBookingNotification(payload: BookingNotificationPayload): Promise<void> {
  const booking = await hydrateBookingDetails(payload);

  // Run email, calendar sync, and Telegram notification concurrently
  const results = await Promise.allSettled([
    sendGuestConfirmationEmail(booking),
    pushReservationToGoogleCalendar(booking),
    sendTelegramBookingAlert(booking),
  ]);

  results.forEach((r, idx) => {
    if (r.status === 'rejected') {
      const actionNames = ['Resend Email', 'Google Calendar', 'Telegram Alert'];
      console.error(`❌ [Notification Action Error] ${actionNames[idx]}:`, r.reason);
    }
  });
}

// Register processor as the active handler for in-process asynchronous dispatching
registerFallbackProcessor(processBookingNotification);

/**
 * Starts the in-process notification worker (BullMQ and Redis disabled for concept mode).
 */
export function startNotificationWorker(): { isRunning: boolean } {
  console.log('⚡ [Worker] In-process notification worker active (BullMQ & Redis disabled for concept mode).');
  return { isRunning: true };
}

// If executed directly from CLI (e.g. `npm run worker`)
const isMainModule = process.argv[1] && process.argv[1].replace(/\\/g, '/').includes('worker');
if (isMainModule) {
  console.log('🏁 Starting standalone Monte Azur In-Process Notification Worker...');
  startNotificationWorker();
}
