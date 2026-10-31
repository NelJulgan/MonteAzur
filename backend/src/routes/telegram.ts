/**
 * ============================================================================
 * MONTE AZUR ROUTES — TELEGRAM WEBHOOK COMMAND LISTENER (src/routes/telegram.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Fastify Webhook Endpoint & Chat Authorization)
 * - STAGE 2: CORE FUNCTIONALITY (Regex Command Parser & Atomic Maintenance Date Blocking)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Interactive Telegram Replies, /briefing & /status)
 *
 * WHY THIS CODE EXISTS:
 * Empowers villa owners and estate managers to control the property directly
 * from their smartphone via Telegram. Enables locking dates instantly for offline
 * guests (e.g. direct Instagram/WhatsApp inquiries) or urgent property maintenance,
 * automatically defending against double-booking and invalidating Redis caches.
 *
 * TRICKY LOGIC:
 * - Telegram requires webhook endpoints to always return HTTP 200 { ok: true } within
 *   a few seconds; returning a non-200 code causes Telegram to retry the message
 *   in an aggressive exponential backoff loop.
 * - Concurrency: Evaluates PostgreSQL `daterange` collision checks with `FOR UPDATE`
 *   to ensure administrative blocks cannot collide with simultaneous website guests.
 *
 * TODO:
 * - Add `/unblock <bookingId>` command to release maintenance blocks via chat.
 * ============================================================================
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { pool, isDbLive, fallbackStore, DEFAULT_PROPERTY_ID, InMemBooking } from '../db/index.js';
import { invalidateAvailabilityCache } from '../services/redis.js';
import { sendTelegramMessage, escapeTelegramMarkdown } from '../services/telegram.js';
import { sendDailyBriefingOnce } from '../services/cron.js';
import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// STAGE 1: FOUNDATION CODE — Authorization & Pattern Matchers
// ============================================================================

/**
 * Extracts and aggregates all authorized administrator chat IDs from environment variables.
 * Supports comma-separated ALLOWED_CHAT_IDS, ADMIN_TELEGRAM_ID, and TELEGRAM_CHAT_ID.
 */
function getAllowedAdminChatIds(): string[] {
  const rawList = [
    process.env.ALLOWED_CHAT_IDS,
    process.env.ADMIN_TELEGRAM_ID,
    process.env.TELEGRAM_CHAT_ID,
  ]
    .filter(Boolean)
    .join(',');

  return rawList
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

// Regex pattern matchers for management commands
const BLOCK_COMMAND_REGEX = /^\/block\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/i;
const UNBLOCK_COMMAND_REGEX = /^\/unblock\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/i;
const OCCUPANCY_COMMAND_REGEX = /^\/occupancy(?:\s+([a-zA-Z]+|\d{1,2}))?(?:\s+(\d{4}))?$/i;

/**
 * ============================================================================
 * STAGE 2: CORE FUNCTIONALITY — Shared Message Processor
 * ============================================================================
 * Handles command authorization, parsing, and execution across both
 * Webhook requests and Long Polling updates.
 */
export async function processTelegramMessage(message: any): Promise<void> {
  if (!message || !message.text) {
    return;
  }

  const chatId = String(message.chat?.id || '');
  const fromId = String(message.from?.id || '');
  const userText = message.text.trim();
  const senderName = message.from?.first_name || 'Manager';

  // Verify chat origin against authorized administrator whitelist (Fail closed if no IDs are configured)
  const allowedChatIds = getAllowedAdminChatIds();
  const isAuthorized =
    allowedChatIds.length > 0 &&
    allowedChatIds.some((allowed) => {
      const cleanAllowed = allowed.replace(/^-/, '');
      const cleanChat = chatId.replace(/^-/, '');
      const cleanFrom = fromId.replace(/^-/, '');
      return (
        allowed === chatId ||
        allowed === fromId ||
        cleanAllowed === cleanChat ||
        cleanAllowed === cleanFrom
      );
    });

  if (!isAuthorized) {
    console.warn(`⚠️ [Telegram] Message from unauthorized chat: ${chatId} (from: ${fromId})`);
    await sendTelegramMessage(
      '🚫 *Unauthorized:* This Telegram bot is restricted to Monte Azur estate management.',
      'Markdown',
      chatId
    );
    return;
  }

  console.log(`🤖 [Telegram Command] From ${senderName} (${chatId}): "${userText}"`);

  // COMMAND 1: /block YYYY-MM-DD to YYYY-MM-DD Reason
  const blockMatch = userText.match(BLOCK_COMMAND_REGEX);
  if (blockMatch) {
    const checkIn = blockMatch[1];
    const checkOut = blockMatch[2];
    const reason = blockMatch[3] ? blockMatch[3].trim() : `Manual Block by ${senderName}`;

    if (checkIn >= checkOut) {
      await sendTelegramMessage(
        '❌ *Invalid Date Range:*\nCheck-out date must be after check-in date.\nExample: `/block 2026-11-20 to 2026-11-24 Pool Cleaning`',
        'Markdown',
        chatId
      );
      return;
    }

    const bookingId = crypto.randomUUID();

    if (isDbLive()) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check for collision with existing confirmed or maintenance dates
        const conflictQuery = `
          SELECT id, guest_name, check_in_date, check_out_date FROM bookings
          WHERE property_id = $1
            AND (status = 'confirmed' OR status = 'maintenance' OR (status = 'pending' AND hold_expires_at > NOW()))
            AND daterange(check_in_date, check_out_date, '[)') && daterange($2::date, $3::date, '[)')
          FOR UPDATE
        `;

        const conflictRes = await client.query(conflictQuery, [
          DEFAULT_PROPERTY_ID,
          checkIn,
          checkOut,
        ]);

        if (conflictRes.rows.length > 0) {
          await client.query('ROLLBACK');
          const c = conflictRes.rows[0];
          await sendTelegramMessage(
            `⚠️ *Date Conflict Detected:*\nCannot block \`${checkIn}\` to \`${checkOut}\`.\n\n*Colliding Stay:* ${escapeTelegramMarkdown(c.guest_name)}\n*Dates:* \`${c.check_in_date}\` to \`${c.check_out_date}\``,
            'Markdown',
            chatId
          );
          return;
        }

        // Insert maintenance record
        await client.query(
          `INSERT INTO bookings (
            id, property_id, guest_name, guest_email, check_in_date, check_out_date,
            total_cents, status, stripe_session_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            bookingId,
            DEFAULT_PROPERTY_ID,
            reason,
            'concierge@monteazur.com',
            checkIn,
            checkOut,
            0,
            'maintenance',
            `tg_block_${Date.now()}`,
          ]
        );

        await client.query('COMMIT');
      } catch (dbErr: any) {
        await client.query('ROLLBACK');
        console.error('[Telegram] DB error on block:', dbErr);
        await sendTelegramMessage(`❌ *Database Error:* ${escapeTelegramMarkdown(dbErr.message)}`, 'Markdown', chatId);
        return;
      } finally {
        client.release();
      }
    } else {
      // In-memory fallback
      for (const existing of fallbackStore.bookings.values()) {
        const isConflict =
          existing.propertyId === DEFAULT_PROPERTY_ID &&
          (existing.status === 'confirmed' ||
            existing.status === 'maintenance' ||
            (existing.status === 'pending' &&
              existing.holdExpiresAt &&
              existing.holdExpiresAt > new Date()));

        if (isConflict && existing.checkInDate < checkOut && existing.checkOutDate > checkIn) {
          await sendTelegramMessage(
            `⚠️ *Date Conflict:* Selected dates overlap with an existing stay (${escapeTelegramMarkdown(existing.guestName)}: \`${existing.checkInDate}\` to \`${existing.checkOutDate}\`).`,
            'Markdown',
            chatId
          );
          return;
        }
      }

      const rec: InMemBooking = {
        id: bookingId,
        propertyId: DEFAULT_PROPERTY_ID,
        guestName: reason,
        guestEmail: 'concierge@monteazur.com',
        guestPhone: null,
        guests: 0,
        checkInDate: checkIn,
        checkOutDate: checkOut,
        totalCents: 0,
        status: 'maintenance',
        stripeSessionId: `tg_block_${Date.now()}`,
        stripePaymentIntentId: null,
        holdExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      fallbackStore.bookings.set(bookingId, rec);
    }

    // Invalidate Redis availability cache
    await invalidateAvailabilityCache(DEFAULT_PROPERTY_ID);

    const refId = bookingId.substring(0, 8).toUpperCase();
    const successMessage = [
      `🔒 *DATES BLOCKED SUCCESSFULLY*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🏡 *Property:* Monte Azur Luxury Sanctuary`,
      `📅 *Dates:* \`${checkIn}\` to \`${checkOut}\``,
      `🛠️ *Reason:* ${escapeTelegramMarkdown(reason)}`,
      `👤 *Initiated by:* ${escapeTelegramMarkdown(senderName)}`,
      `🆔 *Block ID:* \`MA-BLK-${refId}\``,
      ``,
      `✨ _Website availability calendar has been refreshed immediately._`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].join('\n');

    await sendTelegramMessage(successMessage, 'Markdown', chatId);
    return;
  }

  // COMMAND 2: /help or /start
  if (userText.startsWith('/help') || userText.startsWith('/start')) {
    const helpMessage = `
🛠️ *MONTE AZUR MANAGEMENT COMMANDS*

• \`/status\` - Quick villa occupancy and reservation overview.
• \`/briefing\` - Generate the current estate morning briefing report.
• \`/block YYYY-MM-DD to YYYY-MM-DD Reason\` - Lock dates for maintenance or personal stays.
• \`/unblock YYYY-MM-DD to YYYY-MM-DD\` - Remove a manual date block.
• \`/occupancy [Month] [Year]\` - View monthly occupancy rates.
    `.trim();

    await sendTelegramMessage(helpMessage, 'Markdown', chatId);
    return;
  }

  // COMMAND 3: /unblock YYYY-MM-DD to YYYY-MM-DD
  const unblockMatch = userText.match(UNBLOCK_COMMAND_REGEX);
  if (unblockMatch) {
    const checkIn = unblockMatch[1];
    const checkOut = unblockMatch[2];

    let unblockedCount = 0;
    if (isDbLive()) {
      try {
        const res = await pool.query(
          `UPDATE bookings 
           SET status = 'cancelled', updated_at = NOW() 
           WHERE property_id = $1 
             AND status = 'maintenance' 
             AND check_in_date = $2 
             AND check_out_date = $3
           RETURNING id`,
          [DEFAULT_PROPERTY_ID, checkIn, checkOut]
        );
        unblockedCount = res.rowCount || 0;
      } catch (err: any) {
        await sendTelegramMessage(`❌ *Database Error:* ${escapeTelegramMarkdown(err.message)}`, 'Markdown', chatId);
        return;
      }
    } else {
      for (const b of fallbackStore.bookings.values()) {
        if (
          b.propertyId === DEFAULT_PROPERTY_ID &&
          b.status === 'maintenance' &&
          b.checkInDate === checkIn &&
          b.checkOutDate === checkOut
        ) {
          b.status = 'cancelled';
          b.updatedAt = new Date();
          unblockedCount++;
        }
      }
    }

    if (unblockedCount === 0) {
      await sendTelegramMessage(
        `⚠️ *No Maintenance Block Found:*\nNo active manual block matches dates \`${checkIn}\` to \`${checkOut}\`.\nSend \`/status\` to view active blocks.`,
        'Markdown',
        chatId
      );
      return;
    }

    await invalidateAvailabilityCache(DEFAULT_PROPERTY_ID);
    const unblockMsg = [
      `🔓 *DATES UNBLOCKED SUCCESSFULLY*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🏡 *Property:* Monte Azur Luxury Sanctuary`,
      `📅 *Dates:* \`${checkIn}\` to \`${checkOut}\``,
      `✨ _Website availability calendar has been reopened immediately._`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].join('\n');

    await sendTelegramMessage(unblockMsg, 'Markdown', chatId);
    return;
  }

  // COMMAND 4: /occupancy [Month] [Year]
  const occMatch = userText.match(OCCUPANCY_COMMAND_REGEX);
  if (occMatch || userText.startsWith('/occupancy')) {
    const now = new Date();
    let targetYear = now.getUTCFullYear();
    let targetMonth = now.getUTCMonth() + 1;

    if (occMatch && occMatch[1]) {
      const rawM = occMatch[1].toLowerCase();
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const mIdx = months.findIndex((m) => rawM.startsWith(m));
      if (mIdx !== -1) {
        targetMonth = mIdx + 1;
      } else if (!isNaN(parseInt(rawM, 10))) {
        targetMonth = Math.min(12, Math.max(1, parseInt(rawM, 10)));
      }
    }
    if (occMatch && occMatch[2]) {
      targetYear = parseInt(occMatch[2], 10);
    }

    const monthStr = `${targetYear}-${String(targetMonth).padStart(2, '0')}`;
    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();

    let bookedDays = 0;
    let maintenanceDays = 0;

    const checkMonthOverlap = (startStr: string, endStr: string, status: string) => {
      const start = new Date(`${startStr}T00:00:00Z`);
      const end = new Date(`${endStr}T00:00:00Z`);
      const cur = new Date(start);
      while (cur < end) {
        const y = cur.getUTCFullYear();
        const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
        if (`${y}-${m}` === monthStr) {
          if (status === 'confirmed') bookedDays++;
          if (status === 'maintenance') maintenanceDays++;
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    };

    if (isDbLive()) {
      try {
        const res = await pool.query(
          `SELECT check_in_date, check_out_date, status FROM bookings 
           WHERE property_id = $1 AND status IN ('confirmed', 'maintenance')`,
          [DEFAULT_PROPERTY_ID]
        );
        for (const row of res.rows) {
          checkMonthOverlap(row.check_in_date, row.check_out_date, row.status);
        }
      } catch (err: any) {
        console.warn('[Telegram Occupancy] Query error:', err.message);
      }
    } else {
      for (const b of fallbackStore.bookings.values()) {
        if (b.propertyId === DEFAULT_PROPERTY_ID && (b.status === 'confirmed' || b.status === 'maintenance')) {
          checkMonthOverlap(b.checkInDate, b.checkOutDate, b.status);
        }
      }
    }

    const rate = Math.round((bookedDays / daysInMonth) * 100);
    const occMsg = [
      `📊 *MONTE AZUR — OCCUPANCY REPORT*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `📅 *Target Month:* \`${monthStr}\` (${daysInMonth} days)`,
      `🛎️ *Booked Guest Nights:* ${bookedDays} night${bookedDays !== 1 ? 's' : ''}`,
      `🛠️ *Maintenance Nights:* ${maintenanceDays} night${maintenanceDays !== 1 ? 's' : ''}`,
      `📈 *Guest Occupancy Rate:* *${rate}%*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ].join('\n');

    await sendTelegramMessage(occMsg, 'Markdown', chatId);
    return;
  }

  // COMMAND 5: /briefing — Triggers instant daily morning briefing
  if (userText.startsWith('/briefing')) {
    await sendTelegramMessage('⏳ Generating Monte Azur estate briefing report...', 'Markdown', chatId);
    await sendDailyBriefingOnce();
    return;
  }

  // COMMAND 6: /status — Quick occupancy audit
  if (userText.startsWith('/status')) {
    let confirmedCount = 0;
    let maintenanceCount = 0;

    if (isDbLive()) {
      try {
        const res = await pool.query(
          `SELECT status, COUNT(*) FROM bookings 
           WHERE status IN ('confirmed', 'maintenance') 
           GROUP BY status`
        );
        for (const row of res.rows) {
          if (row.status === 'confirmed') confirmedCount = parseInt(row.count, 10);
          if (row.status === 'maintenance') maintenanceCount = parseInt(row.count, 10);
        }
      } catch (err: any) {
        console.warn('[Telegram Status] Query error:', err.message);
      }
    } else {
      for (const b of fallbackStore.bookings.values()) {
        if (b.status === 'confirmed') confirmedCount++;
        if (b.status === 'maintenance') maintenanceCount++;
      }
    }

    const statusMsg = [
      `📊 *MONTE AZUR — ESTATE STATUS*`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🏡 *Property:* Monte Azur Luxury Sanctuary`,
      `✅ *Confirmed Reservations:* ${confirmedCount}`,
      `🛠️ *Active Maintenance Blocks:* ${maintenanceCount}`,
      `⚡ *Availability Engine:* Online (In-Memory / Fastify)`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `_Send \`/briefing\` for detailed guest schedules._`,
    ].join('\n');

    await sendTelegramMessage(statusMsg, 'Markdown', chatId);
    return;
  }

  // Unknown command hint
  await sendTelegramMessage(
    `ℹ️ Unrecognized command. Send \`/help\` for list of management actions or use:\n\`/block YYYY-MM-DD to YYYY-MM-DD Reason\``,
    'Markdown',
    chatId
  );
}

export default async function telegramRoutes(fastify: FastifyInstance) {
  // STEP 1: Register POST /api/webhooks/telegram
  fastify.post('/api/webhooks/telegram', async (req: FastifyRequest, reply: FastifyReply) => {
    // STAGE 1: FOUNDATION CODE — Webhook Secret Verification
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const incomingSecret = req.headers['x-telegram-bot-api-secret-token'];
      const secretStr = typeof incomingSecret === 'string' ? incomingSecret : '';

      const bufIncoming = Buffer.from(secretStr);
      const bufExpected = Buffer.from(expectedSecret);
      const isSecretValid =
        bufIncoming.length === bufExpected.length &&
        crypto.timingSafeEqual(bufIncoming, bufExpected);

      if (!isSecretValid) {
        console.warn('⚠️ [Telegram Webhook] Access denied: Invalid or missing X-Telegram-Bot-Api-Secret-Token header.');
        return reply.status(401).send({ error: 'Unauthorized: Invalid secret token' });
      }
    }

    const body = req.body as any;
    const message = body?.message || body?.edited_message;

    if (message) {
      await processTelegramMessage(message);
    }

    return reply.status(200).send({ ok: true });
  });
}

/**
 * ============================================================================
 * STAGE 3: ENHANCEMENT / OPTIMIZATION — Real-Time Local Polling Engine
 * ============================================================================
 * Automatically clears dead webhooks (like stale ngrok URLs) and runs Telegram
 * getUpdates long polling in the background during local development.
 */
let isPollingActive = false;

export async function startTelegramPolling(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.includes('placeholder')) {
    console.log('ℹ️ [Telegram Polling] Skipped: TELEGRAM_BOT_TOKEN not configured.');
    return;
  }

  if (isPollingActive) return;
  isPollingActive = true;

  try {
    // 1. Delete dead webhook so Telegram delivers pending updates via getUpdates
    const delRes = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: 'POST' });
    const delData = (await delRes.json()) as any;
    if (delData.ok) {
      console.log('⚡ [Telegram Polling] Stale webhook cleared. Real-time local long polling active.');
    }

    let offset = 0;

    const pollLoop = async () => {
      while (isPollingActive) {
        try {
          const res = await fetch(
            `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=20`,
            { signal: AbortSignal.timeout(30000) }
          );

          if (res.ok) {
            const data = (await res.json()) as any;
            if (data.ok && Array.isArray(data.result)) {
              for (const update of data.result) {
                offset = update.update_id + 1;
                const msg = update.message || update.edited_message;
                if (msg) {
                  await processTelegramMessage(msg);
                }
              }
            }
          }
        } catch (pollErr: any) {
          // Non-blocking backoff on network blips
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      }
    };

    pollLoop();
  } catch (err: any) {
    console.warn('[Telegram Polling] Polling setup error:', err.message);
  }
}
