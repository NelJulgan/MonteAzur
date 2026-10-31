/**
 * ============================================================================
 * MONTE AZUR — BOOKINGS REST API ROUTES (server/src/routes/bookings.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 2: CORE FUNCTIONALITY (REST Endpoints for Availability, Quotes & Checkout)
 *
 * WHY THIS MODULE EXISTS:
 * Exposes clean, validated HTTP endpoints under `/api/v1/bookings` consumed
 * by `src/api/booking.js`.
 *
 * TRICKY LOGIC:
 * Automatically handles both JSON body requests and returns standard HTTP status
 * codes (200, 201, 400, 404, 409, 500) with descriptive JSON error payloads.
 *
 * TODO:
 * - Add rate limiting via `express-rate-limit` for DDoS prevention.
 * ============================================================================
 */

import { Router } from 'express';
import { bookingService } from '../services/bookingService.js';

export const bookingRouter = Router();

/**
 * GET /api/v1/bookings/availability
 * Returns live booked dates array and authoritative pricing constants.
 */
bookingRouter.get('/availability', async (req, res) => {
  try {
    const data = await bookingService.getAvailability();
    res.json(data);
  } catch (err) {
    console.error('Error in GET /availability:', err);
    res.status(500).json({ error: 'Failed to retrieve availability', message: err.message });
  }
});

/**
 * POST /api/v1/bookings/quote
 * Calculates authoritative quote and validates minimum night stay rules.
 */
bookingRouter.post('/quote', async (req, res) => {
  try {
    const { checkIn, checkOut, adults, children } = req.body;
    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: 'Check-in and check-out dates are required' });
    }

    const quote = await bookingService.calculateQuote(checkIn, checkOut, adults, children);
    res.json({ quote });
  } catch (err) {
    res.status(400).json({ error: 'Quote calculation failed', message: err.message });
  }
});

/**
 * POST /api/v1/bookings/checkout-session
 * Creates pending reservation record and returns Stripe checkout URL or concierge confirmation.
 */
bookingRouter.post('/checkout-session', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.checkIn || !payload.checkOut) {
      return res.status(400).json({ error: 'Check-in and check-out dates are required' });
    }

    const reservation = await bookingService.createReservation({
      ...payload,
      userAgent: req.headers['user-agent'] || 'unknown',
    });

    res.status(201).json(reservation);
  } catch (err) {
    console.error('Error in POST /checkout-session:', err);
    const isConflict = err.message.includes('available');
    res.status(isConflict ? 409 : 400).json({
      error: 'Failed to create reservation',
      message: err.message,
    });
  }
});

/**
 * GET /api/v1/bookings/:referenceId
 * Look up booking by reference code (e.g., 'MA-8K2M19').
 */
bookingRouter.get('/:referenceId', async (req, res) => {
  try {
    const { referenceId } = req.params;
    const booking = await bookingService.getBookingByReference(referenceId.toUpperCase());
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Sanitize sensitive metadata before returning to public client
    const safeData = {
      referenceId: booking.referenceId,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      adults: booking.adults,
      children: booking.children,
      guestName: booking.guestName,
      nights: booking.nights,
      totalAmount: booking.totalAmount,
      currency: booking.currency,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      createdAt: booking.createdAt,
    };

    res.json({ booking: safeData });
  } catch (err) {
    res.status(500).json({ error: 'Failed to look up booking', message: err.message });
  }
});

/**
 * POST /api/v1/bookings/clear
 * DELETE /api/v1/bookings
 * Clears all reservations from the database and calendar.
 */
bookingRouter.post('/clear', async (req, res) => {
  try {
    const result = await bookingService.clearAllReservations();
    res.json({ message: 'All reservations cleared successfully', ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear reservations', message: err.message });
  }
});

bookingRouter.delete('/', async (req, res) => {
  try {
    const result = await bookingService.clearAllReservations();
    res.json({ message: 'All reservations cleared successfully', ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear reservations', message: err.message });
  }
});
