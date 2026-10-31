/**
 * ============================================================================
 * MONTE AZUR SERVICES — EXPIRED HOLD CLEANUP CRON (src/services/cron.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Cron Interval Configuration & Safety Guards)
 * - STAGE 2: CORE FUNCTIONALITY (Atomic SQL Cancellation & In-Memory Purge)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Redis Availability Cache Invalidation & Auditing)
 *
 * WHY THIS CODE EXISTS:
 * When guests initiate a checkout, a 30-minute pending hold is placed on the villa
 * to prevent double-booking while they enter payment details. If a guest abandons
 * the checkout session, this cron worker automatically marks the hold as 'cancelled'
 * and busts the Redis cache so other guests can immediately reserve those dates.
 *
 * TRICKY LOGIC:
 * - Uses `RETURNING id, property_id` in PostgreSQL to extract exactly which properties
 *   had holds released, preventing needless cache eviction across unaffected listings.
 * - Supports both active PostgreSQL connection pools and development in-memory stores.
 *
 * TODO:
 * - Implement abandoned cart recovery emails 15 minutes into pending holds in Phase 3.
 * ============================================================================
 */

import { pool, isDbLive, fallbackStore } from '../db/index.js';
import { invalidateAvailabilityCache } from './redis.js';
import cron, { ScheduledTask } from 'node-cron';
import { sendTelegramMessage, escapeTelegramMarkdown } from './telegram.js';

// ============================================================================
// STAGE 1: FOUNDATION CODE — Cron Configuration & State Tracking
// ============================================================================
// STEP 1: Set default interval (2 minutes) and manage active timer handle
const DEFAULT_CLEANUP_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
let cleanupTimer: NodeJS.Timeout | null = null;
let isCleanupRunning = false;

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Atomic Cancellation Execution
// ============================================================================
// STEP 2: Execute single cleanup pass across PostgreSQL or fallbackStore
/**
 * Performs a single check-and-release pass for expired holds.
 * Can be triggered directly by tests or periodically by the cron interval.
 * @returns {Promise<number>} Number of released bookings
 */
export async function cleanExpiredHoldsOnce(): Promise<number> {
  if (isCleanupRunning) {
    return 0; // Prevent overlapping execution cycles
  }

  isCleanupRunning = true;
  let releasedCount = 0;
  const affectedPropertyIds = new Set<string>();

  try {
    if (isDbLive()) {
      // Production PostgreSQL execution with atomic update and RETURNING clause
      const result = await pool.query(
        `UPDATE bookings 
         SET status = 'cancelled', 
             hold_expires_at = NULL,
             updated_at = NOW() 
         WHERE status = 'pending' 
           AND hold_expires_at IS NOT NULL 
           AND hold_expires_at <= NOW()
         RETURNING id, property_id`
      );

      releasedCount = result.rowCount || 0;
      for (const row of result.rows) {
        if (row.property_id) {
          affectedPropertyIds.add(row.property_id);
        }
      }
    } else {
      // Local development fallback store check
      const now = new Date();
      for (const booking of fallbackStore.bookings.values()) {
        if (
          booking.status === 'pending' &&
          booking.holdExpiresAt &&
          booking.holdExpiresAt <= now
        ) {
          booking.status = 'cancelled';
          booking.holdExpiresAt = null;
          booking.updatedAt = new Date();
          releasedCount++;
          affectedPropertyIds.add(booking.propertyId);
        }
      }
    }

    // ============================================================================
    // STAGE 3: ENHANCEMENT / OPTIMIZATION — Redis Invalidation & Audit Logging
    // ============================================================================
    // STEP 3: If any holds were released, invalidate cache for affected properties
    if (releasedCount > 0) {
      console.log(`⌛ [Cron Cleanup] Automatically released ${releasedCount} expired pending hold(s).`);

      for (const propertyId of affectedPropertyIds) {
        await invalidateAvailabilityCache(propertyId);
        console.log(`🧹 [Cron Cleanup] Redis availability cache busted for property ${propertyId}. Dates reopened.`);
      }
    }
  } catch (err: any) {
    console.error(`❌ [Cron Cleanup] Error during expired hold cleanup cycle: ${err.message}`);
  } finally {
    isCleanupRunning = false;
  }

  return releasedCount;
}

/**
 * Starts the background interval worker.
 * @param {number} [intervalMs=120000] Interval in milliseconds (default: 2 minutes)
 */
export function startExpiredHoldCleanupCron(intervalMs: number = DEFAULT_CLEANUP_INTERVAL_MS): void {
  if (cleanupTimer) {
    console.log('ℹ️ [Cron Cleanup] Cron worker is already active.');
    return;
  }

  console.log(`⏱️ [Cron Cleanup] Initializing Expired Hold Cleaner (interval: ${intervalMs / 1000}s).`);

  // Run initial pass after brief 5-second startup grace period
  setTimeout(() => {
    cleanExpiredHoldsOnce().catch((err) => {
      console.error('[Cron Cleanup] Initial pass failed:', err.message);
    });
  }, 5000);

  // Set recurring interval
  cleanupTimer = setInterval(() => {
    cleanExpiredHoldsOnce().catch((err) => {
      console.error('[Cron Cleanup] Recurring pass failed:', err.message);
    });
  }, intervalMs);

  // Unref timer so it doesn't block graceful Node.js process shutdown
  if (cleanupTimer && typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }
}

/**
 * Stops the background interval worker.
 */
export function stopExpiredHoldCleanupCron(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('🛑 [Cron Cleanup] Expired Hold Cleaner stopped.');
  }
}

// ============================================================================
// STAGE 3: ENHANCEMENT / OPTIMIZATION — Daily 7:00 AM Morning Briefing Cron
// ============================================================================

let dailyBriefingTask: ScheduledTask | null = null;

interface GuestBriefingItem {
  id: string;
  guestName: string;
  guestPhone: string;
  guests: number;
  checkInDate: string;
  checkOutDate: string;
  status: string;
}

/**
 * Compiles and sends the Daily Morning Briefing report to management's Telegram chat.
 * Can be called manually (e.g. from `/briefing` Telegram command) or by scheduled cron.
 */
export async function sendDailyBriefingOnce(): Promise<void> {
  // Get today's local date in Asia/Manila (YYYY-MM-DD)
  const now = new Date();
  const manilaDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now);

  console.log(`🌅 [Daily Briefing] Generating morning briefing for ${manilaDateStr}...`);

  const checkIns: GuestBriefingItem[] = [];
  const checkOuts: GuestBriefingItem[] = [];
  const staying: GuestBriefingItem[] = [];
  const maintenance: GuestBriefingItem[] = [];

  if (isDbLive()) {
    try {
      const res = await pool.query(
        `SELECT id, guest_name, guest_phone, guests, check_in_date, check_out_date, status
         FROM bookings
         WHERE status IN ('confirmed', 'maintenance')
           AND (check_in_date = $1 OR check_out_date = $1 OR (check_in_date < $1 AND check_out_date > $1))
         ORDER BY check_in_date ASC`,
        [manilaDateStr]
      );

      for (const row of res.rows) {
        const item: GuestBriefingItem = {
          id: row.id,
          guestName: row.guest_name,
          guestPhone: row.guest_phone || 'None',
          guests: row.guests,
          checkInDate: row.check_in_date,
          checkOutDate: row.check_out_date,
          status: row.status,
        };

        if (row.status === 'maintenance') {
          maintenance.push(item);
        } else if (row.check_in_date === manilaDateStr) {
          checkIns.push(item);
        } else if (row.check_out_date === manilaDateStr) {
          checkOuts.push(item);
        } else {
          staying.push(item);
        }
      }
    } catch (err: any) {
      console.error(`[Daily Briefing] Database query failed: ${err.message}`);
    }
  } else {
    // In-memory fallback
    for (const b of fallbackStore.bookings.values()) {
      if (b.status === 'confirmed' || b.status === 'maintenance') {
        const item: GuestBriefingItem = {
          id: b.id,
          guestName: b.guestName,
          guestPhone: b.guestPhone || 'None',
          guests: b.guests,
          checkInDate: b.checkInDate,
          checkOutDate: b.checkOutDate,
          status: b.status,
        };

        if (b.status === 'maintenance') {
          if (b.checkInDate <= manilaDateStr && b.checkOutDate > manilaDateStr) {
            maintenance.push(item);
          }
        } else if (b.checkInDate === manilaDateStr) {
          checkIns.push(item);
        } else if (b.checkOutDate === manilaDateStr) {
          checkOuts.push(item);
        } else if (b.checkInDate < manilaDateStr && b.checkOutDate > manilaDateStr) {
          staying.push(item);
        }
      }
    }
  }

  // Format guest lists
  const formatList = (items: GuestBriefingItem[], emptyText: string) => {
    if (items.length === 0) return `  _• ${emptyText}_`;
    return items
      .map(
        (i) =>
          `  • *${escapeTelegramMarkdown(i.guestName)}* (${i.guests} guests)\n    📞 \`${escapeTelegramMarkdown(i.guestPhone)}\` | Stays until \`${i.checkOutDate}\``
      )
      .join('\n');
  };

  const message = [
    `🌅 *MONTE AZUR — DAILY MORNING BRIEFING*`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📅 *Date:* \`${manilaDateStr}\` (7:00 AM PHT)`,
    `🏡 *Property:* Monte Azur Luxury Sanctuary`,
    ``,
    `🛎️ *CHECK-INS TODAY (From 3:00 PM):*`,
    formatList(checkIns, 'No check-ins scheduled today'),
    ``,
    `🚪 *CHECK-OUTS TODAY (Until 11:00 AM):*`,
    formatList(checkOuts, 'No check-outs scheduled today'),
    ``,
    `🛌 *CURRENTLY IN RESIDENCE:*`,
    formatList(staying, 'Villa currently vacant for maintenance'),
    ``,
    maintenance.length > 0
      ? `🛠️ *ACTIVE BLOCKS / MAINTENANCE:*\n` +
        maintenance.map((m) => `  • _${escapeTelegramMarkdown(m.guestName)}_ (Until \`${m.checkOutDate}\`)`).join('\n') +
        '\n'
      : '',
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `💡 _Use \`/block YYYY-MM-DD to YYYY-MM-DD Reason\` to lock dates._`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendTelegramMessage(message, 'Markdown');
  console.log(`✅ [Daily Briefing] Dispatched 7:00 AM morning briefing report to Telegram.`);
}

/**
 * Starts the 7:00 AM daily cron schedule (Asia/Manila).
 */
export function startDailyBriefingCron(): void {
  if (dailyBriefingTask) return;

  console.log('⏰ [Daily Briefing] Scheduling 7:00 AM PHT morning briefing cron (0 7 * * *)...');

  // Schedule daily at 7:00 AM Manila Time
  dailyBriefingTask = cron.schedule(
    '0 7 * * *',
    async () => {
      console.log('🔔 [Daily Briefing] 7:00 AM trigger fired. Executing briefing...');
      await sendDailyBriefingOnce();
    },
    {
      timezone: 'Asia/Manila',
    }
  );
}

/**
 * Stops the daily briefing cron schedule.
 */
export function stopDailyBriefingCron(): void {
  if (dailyBriefingTask) {
    dailyBriefingTask.stop();
    dailyBriefingTask = null;
    console.log('🛑 [Daily Briefing] 7:00 AM morning briefing cron stopped.');
  }
}
