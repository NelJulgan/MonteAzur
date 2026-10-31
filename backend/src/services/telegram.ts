/**
 * ============================================================================
 * MONTE AZUR SERVICES — TELEGRAM BOT SERVICE (src/services/telegram.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Telegram Bot Token & Native Fetch Wrapper)
 * - STAGE 2: CORE FUNCTIONALITY (Rich Markdown Booking & Payment Alert Cards)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Development Simulation & Escaped Markdown)
 *
 * WHY THIS CODE EXISTS:
 * Enables real-time mobile alerting for villa management and staff. Sends instant
 * payment notifications directly to management's private Telegram group the exact
 * millisecond Stripe confirms payment, without requiring third-party SDK dependencies.
 *
 * TRICKY LOGIC:
 * - Telegram Markdown V1 requires escaping special characters like `_`, `*`, `[`, `]`, `` ` ``
 *   inside dynamic user strings (such as guest names or notes) to prevent message parse drops.
 * - When running locally without a bot token, it logs alerts cleanly to stdout
 *   instead of throwing unhandled network exceptions.
 *
 * TODO:
 * - Support interactive inline keyboard buttons for 1-click booking confirmation.
 * ============================================================================
 */

import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// STAGE 1: FOUNDATION CODE — Telegram Configuration & Native Fetch Wrapper
// ============================================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const isTelegramConfigured =
  TELEGRAM_BOT_TOKEN &&
  TELEGRAM_CHAT_ID &&
  !TELEGRAM_BOT_TOKEN.includes('placeholder') &&
  !TELEGRAM_CHAT_ID.includes('placeholder');

/**
 * Escapes characters that break Telegram Markdown V1 parsing in user-provided text.
 */
export function escapeTelegramMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([_*\[\]`])/g, '\\$1');
}

/**
 * Sends a message to the management Telegram group or specified chat ID.
 * @param {string} text - Message content (Markdown or HTML)
 * @param {'Markdown' | 'HTML'} [parseMode='Markdown']
 * @param {string} [customChatId] - Optional custom chat ID override
 * @returns {Promise<boolean>} True if sent successfully or simulated
 */
export async function sendTelegramMessage(
  text: string,
  parseMode: 'Markdown' | 'HTML' = 'Markdown',
  customChatId?: string
): Promise<boolean> {
  const chatId = customChatId || TELEGRAM_CHAT_ID;

  if (!isTelegramConfigured && !customChatId) {
    console.log(`\n💬 [Telegram Simulation] Message to Chat (${chatId || 'DEMO_CHAT'}):\n${text}\n`);
    return true;
  }

  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[Telegram] Cannot send message: TELEGRAM_BOT_TOKEN is not configured.');
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    const data = (await response.json()) as any;

    if (!data.ok) {
      console.error(`❌ [Telegram] API error (${data.error_code}): ${data.description}`);
      return false;
    }

    console.log(`📱 [Telegram] Message successfully dispatched to chat ${chatId}.`);
    return true;
  } catch (err: any) {
    console.error(`❌ [Telegram] Network request failed: ${err.message}`);
    return false;
  }
}

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Rich Booking & Payment Alert Card
// ============================================================================

export interface BookingAlertData {
  id: string;
  guestName: string;
  guestEmail: string;
  guestPhone?: string | null;
  guests: number;
  checkInDate: string;
  checkOutDate: string;
  totalPrice: number;
  propertyName?: string;
  paymentMethod?: string | null;
  stripePaymentIntentId?: string | null;
  stripeSessionId?: string | null;
}

/**
 * Formats and dispatches a rich Markdown alert card to management upon payment confirmation.
 * @param {BookingAlertData} booking
 * @returns {Promise<boolean>}
 */
export async function sendTelegramBookingAlert(booking: BookingAlertData): Promise<boolean> {
  // Calculate nights
  const start = new Date(`${booking.checkInDate}T00:00:00Z`);
  const end = new Date(`${booking.checkOutDate}T00:00:00Z`);
  const nights = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));

  const cleanGuest = escapeTelegramMarkdown(booking.guestName);
  const cleanEmail = escapeTelegramMarkdown(booking.guestEmail);
  const cleanPhone = escapeTelegramMarkdown(booking.guestPhone || 'Not provided');
  const property = escapeTelegramMarkdown(booking.propertyName || 'Monte Azur Luxury Sanctuary');
  const refId = booking.id.substring(0, 8).toUpperCase();

  const paymentLabel = booking.paymentMethod === 'gcash'
    ? 'GCash Express (Mock Simulation)'
    : booking.paymentMethod === 'credit_card' || booking.paymentMethod === 'card'
    ? 'Visa / Mastercard (Mock Simulation)'
    : 'Direct Concierge (Concept Demo)';

  const message = [
    `✨ *NEW RESERVATION INQUIRY* ✨`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🏡 *Property:* ${property}`,
    `🆔 *Booking Ref:* \`MA-${refId}\``,
    ``,
    `👤 *Guest:* ${cleanGuest}`,
    `📞 *Phone:* ${cleanPhone}`,
    `📧 *Email:* ${cleanEmail}`,
    `👥 *Party:* ${booking.guests} Guest${booking.guests > 1 ? 's' : ''}`,
    ``,
    `📅 *Check-In:* \`${booking.checkInDate}\` (3:00 PM PHT)`,
    `📅 *Check-Out:* \`${booking.checkOutDate}\` (11:00 AM PHT)`,
    `🌙 *Duration:* ${nights} Night${nights > 1 ? 's' : ''}`,
    ``,
    `💰 *Estimated Total:* *₱${booking.totalPrice.toLocaleString()} PHP*`,
    `💳 *Payment Preference:* ${paymentLabel}`,
    `ℹ️ *Billing Status:* Concept Placeholder (Zero Charges Incurred)`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n');

  return sendTelegramMessage(message, 'Markdown');
}
