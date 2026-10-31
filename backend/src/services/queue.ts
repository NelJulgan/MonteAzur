/**
 * ============================================================================
 * MONTE AZUR SERVICES — ASYNC NOTIFICATION DISPATCHER (src/services/queue.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Payload Interface & Handler Registry)
 * - STAGE 2: CORE FUNCTIONALITY (Asynchronous In-Process Job Dispatching via setImmediate)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Backwards Compatibility & Lifecycle Safety)
 *
 * WHY THIS CODE EXISTS:
 * Dispatches post-booking side-effects (Resend confirmation emails, Google Calendar sync,
 * Telegram management alerts) asynchronously without blocking the Stripe webhook or
 * HTTP reservation responses. Replaces BullMQ and Redis with lightweight Node.js event-loop
 * asynchronous execution for concept mode.
 *
 * TRICKY LOGIC:
 * - Using `setImmediate()` ensures HTTP response headers are flushed immediately to the
 *   client before background tasks (like third-party API calls) begin executing.
 * - Retains the existing function signatures and export names (`enqueueBookingNotification`,
 *   `sendBookingConfirmation`, `registerFallbackProcessor`) to preserve compatibility.
 *
 * TODO:
 * - When scaling to multiple worker servers, swap this implementation with an SQS or
 *   RabbitMQ adapter.
 * ============================================================================
 */

import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// STAGE 1: FOUNDATION CODE — Types and In-Process Handler Registry
// ============================================================================

// STEP 1: Define strongly typed notification payload structure
export interface BookingNotificationPayload {
  bookingId: string;
  guestName?: string;
  guestEmail?: string;
  propertyName?: string;
  checkIn?: string;
  checkOut?: string;
  totalPrice?: number;
  paymentMethod?: string;
}

export const NOTIFICATION_QUEUE_NAME = 'booking-notifications-in-process';

// STEP 2: Processor registry for asynchronous dispatch
type JobHandler = (payload: BookingNotificationPayload) => Promise<void>;
let activeNotificationHandler: JobHandler | null = null;

/**
 * Registers the background processor function (called by worker.ts).
 */
export function registerFallbackProcessor(handler: JobHandler): void {
  activeNotificationHandler = handler;
}

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Asynchronous In-Process Enqueueing
// ============================================================================

// STEP 3: Dispatch notification job without blocking the HTTP event loop
export async function enqueueBookingNotification(
  bookingId: string,
  metadata: Partial<BookingNotificationPayload> = {}
): Promise<void> {
  const payload: BookingNotificationPayload = {
    bookingId,
    ...metadata,
  };

  console.log(`📥 [Notification Dispatcher] Queued asynchronous notification for booking: ${bookingId}`);

  // STEP 4: Yield to event loop; execute task right after the current poll cycle ends
  setImmediate(async () => {
    if (activeNotificationHandler) {
      try {
        await activeNotificationHandler(payload);
      } catch (err: any) {
        console.error(`❌ [Notification Dispatcher] Job execution failed for booking ${bookingId}:`, err.message);
      }
    } else {
      console.log(`ℹ️ [Notification Dispatcher] Simulating notification for booking ${bookingId} (no worker registered).`);
    }
  });
}

// ============================================================================
// STAGE 3: ENHANCEMENT / OPTIMIZATION — Backwards Compatibility Helpers
// ============================================================================

// STEP 5: Compatibility stub for legacy BullMQ queue accessor
export function initBullMQQueue(): null {
  // Returns null: BullMQ disabled for concept mode
  return null;
}

// STEP 6: Backwards-compatible alias for existing webhook callers
export const sendBookingConfirmation = (data: any) => enqueueBookingNotification(data.bookingId, data);
