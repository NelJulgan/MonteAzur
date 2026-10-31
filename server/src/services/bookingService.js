/**
 * ============================================================================
 * MONTE AZUR — BOOKING DOMAIN LOGIC (server/src/services/bookingService.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 2: CORE FUNCTIONALITY (Collision Detection, Quotes & Reservation Orchestration)
 *
 * WHY THIS SERVICE EXISTS:
 * Enforces authoritative business rules for property availability, minimum night
 * restrictions, guest capacity, pricing calculations, and transaction records.
 *
 * TRICKY LOGIC:
 * 1. Checks availability over the half-open interval `[checkIn, checkOut)`.
 *    Because check-out happens in the morning (11:00 AM) and check-in in the
 *    afternoon (3:00 PM), one guest's check-out date can safely be the next guest's
 *    check-in date without collision.
 * 2. Generates human-friendly reference IDs (e.g., `MA-8K2M19`) that exclude
 *    ambiguous characters (0, O, 1, I).
 *
 * TODO:
 * - Add automated guest email confirmation via Resend / SendGrid.
 * ============================================================================
 */

import { config } from '../config.js';
import { db } from '../db.js';
import { stripeService } from '../stripe.js';

function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function generateReferenceId() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let result = 'MA-';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export const bookingService = {
  /**
   * Returns list of all individual booked dates (`YYYY-MM-DD`) and ranges.
   */
  async getAvailability() {
    const activeBookings = await db.getActiveBookings();
    const bookedDates = new Set();
    const bookedRanges = [];

    for (const b of activeBookings) {
      const start = parseDate(b.checkIn);
      const end = parseDate(b.checkOut);
      bookedRanges.push({ checkIn: b.checkIn, checkOut: b.checkOut });

      const cur = new Date(start);
      while (cur < end) {
        bookedDates.add(formatDate(cur));
        cur.setDate(cur.getDate() + 1);
      }
    }

    return {
      bookedDates: Array.from(bookedDates).sort(),
      bookedRanges,
      pricing: config.pricing,
    };
  },

  /**
   * Verifies if a proposed date range is entirely vacant.
   */
  async isRangeAvailable(checkInStr, checkOutStr) {
    const start = parseDate(checkInStr);
    const end = parseDate(checkOutStr);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
      return false;
    }

    const { bookedDates } = await this.getAvailability();
    const bookedSet = new Set(bookedDates);

    const cur = new Date(start);
    while (cur < end) {
      if (bookedSet.has(formatDate(cur))) {
        return false;
      }
      cur.setDate(cur.getDate() + 1);
    }

    return true;
  },

  /**
   * Calculates stay nights between check-in and check-out.
   */
  calculateNights(checkInStr, checkOutStr) {
    const start = parseDate(checkInStr);
    const end = parseDate(checkOutStr);
    const diffMs = end.getTime() - start.getTime();
    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  },

  /**
   * Validates dates and returns an authoritative quote.
   */
  async calculateQuote(checkIn, checkOut, adults = 2, children = 0) {
    const nights = this.calculateNights(checkIn, checkOut);
    if (nights <= 0) {
      throw new Error('Check-out date must be after check-in date.');
    }

    if (nights < config.pricing.minNights) {
      throw new Error(`Minimum stay requirement is ${config.pricing.minNights} nights.`);
    }

    const totalGuests = Number(adults) + Number(children);
    if (totalGuests > config.pricing.maxGuests) {
      throw new Error(`Maximum property capacity is ${config.pricing.maxGuests} guests.`);
    }

    const isAvailable = await this.isRangeAvailable(checkIn, checkOut);
    if (!isAvailable) {
      throw new Error('The selected dates are no longer available. Please select different dates.');
    }

    const accommodationSubtotal = nights * config.pricing.baseNightlyRate;
    const cleaningFee = config.pricing.cleaningFee;
    const serviceFee = Math.round(accommodationSubtotal * config.pricing.serviceFeeRate);
    const totalAmount = accommodationSubtotal + cleaningFee + serviceFee;

    return {
      nights,
      nightlyRate: config.pricing.baseNightlyRate,
      accommodationSubtotal,
      cleaningFee,
      serviceFee,
      totalAmount,
      currency: config.pricing.currency,
      adults: Number(adults),
      children: Number(children),
      totalGuests,
    };
  },

  /**
   * Creates a new booking reservation and Stripe Checkout Session.
   */
  async createReservation(payload) {
    const { checkIn, checkOut, adults = 2, children = 0, guest = {} } = payload;

    if (!guest.name || !guest.email || !guest.phone) {
      throw new Error('Guest name, email, and phone number are required.');
    }

    // Authoritatively re-calculate quote on the server to prevent client-side price tampering
    const quote = await this.calculateQuote(checkIn, checkOut, adults, children);

    const referenceId = generateReferenceId();

    const bookingRecord = {
      referenceId,
      checkIn,
      checkOut,
      adults: quote.adults,
      children: quote.children,
      guestName: guest.name.trim(),
      guestEmail: guest.email.trim().toLowerCase(),
      guestPhone: guest.phone.trim(),
      guestNotes: guest.notes ? guest.notes.trim() : '',
      nights: quote.nights,
      nightlyRate: quote.nightlyRate,
      accommodationSubtotal: quote.accommodationSubtotal,
      cleaningFee: quote.cleaningFee,
      serviceFee: quote.serviceFee,
      totalAmount: quote.totalAmount,
      currency: quote.currency,
      status: stripeService.isConfigured() ? 'pending' : 'confirmed',
      paymentStatus: stripeService.isConfigured() ? 'unpaid' : 'paid',
      metadata: {
        source: 'direct_website',
        userAgent: payload.userAgent || 'unknown',
      },
    };

    // Generate Stripe Session if configured
    let stripeSession = null;
    try {
      stripeSession = await stripeService.createCheckoutSession(bookingRecord);
      bookingRecord.stripeSessionId = stripeSession.sessionId;
    } catch (stripeErr) {
      console.warn('[BookingService] Stripe checkout initialization error:', stripeErr.message);
    }

    // Persist to database
    const saved = await db.createBooking(bookingRecord);

    return {
      status: saved.status,
      referenceId: saved.referenceId,
      checkoutUrl: stripeSession ? stripeSession.url : null,
      isSimulated: stripeSession ? stripeSession.isSimulated : true,
      quote,
      guest: {
        name: saved.guestName,
        email: saved.guestEmail,
      },
    };
  },

  /**
   * Looks up a booking by reference ID.
   */
  async getBookingByReference(referenceId) {
    const booking = await db.findBookingByReference(referenceId);
    if (!booking) return null;
    return booking;
  },

  /**
   * Cleans all reservations from the database and availability calendar.
   */
  async clearAllReservations() {
    return await db.clearAllBookings();
  },

  /**
   * Handles Stripe Webhook confirmation
   */
  async handleStripeSessionCompleted(session) {
    const referenceId = session.client_reference_id;
    const stripeSessionId = session.id;
    const paymentIntentId = session.payment_intent;

    console.log(`🎉 [BookingService] Payment received for booking ref: ${referenceId}`);

    return await db.updateBookingStatus({
      referenceId,
      stripeSessionId,
      status: 'confirmed',
      paymentStatus: 'paid',
      paymentIntentId,
    });
  },
};
