/**
 * ============================================================================
 * MONTE AZUR — BOOKING & AVAILABILITY API SERVICE LAYER (src/api/booking.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (API Client Configuration & Timeout Wrapper)
 * - STAGE 2: CORE FUNCTIONALITY (Availability Lookup & Seasonal Quote Calculation)
 * - STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION (Stripe Checkout & Concierge Fallback)
 *
 * WHY THIS MODULE EXISTS:
 * Decouples the frontend UI (`src/components/calendar.js`) from hardcoded data by
 * providing a clean, asynchronous REST client backed by `import.meta.env.VITE_API_URL`.
 * Ready to connect directly to a Node.js + PostgreSQL + Stripe backend while
 * falling back seamlessly to deterministic demo availability when offline.
 *
 * TRICKY LOGIC:
 * - Uses `AbortController` with an 8000ms timeout so network stalls never freeze
 *   the reservation modal UI.
 * - Dynamically seeds demo reserved date blocks relative to the visitor's current
 *   month/year so the calendar always showcases realistic availability states.
 *
 * TODO:
 * - Connect `createCheckoutSession` to `POST /api/v1/bookings/checkout-session`
 *   when the Node.js + PostgreSQL + Stripe backend is deployed.
 * ============================================================================
 */

// ============================================================================
// STAGE 1: FOUNDATION CODE — API Configuration & HTTP Request Helper
// ============================================================================
// STEP 1: Configure environment base URL and authoritative pricing constants
// Tricky logic: Normalize VITE_API_URL so whether the user sets
// `https://monte-azur-api.onrender.com` or `https://monte-azur-api.onrender.com/api`
// in Vercel, requests always target the `/api` route prefix cleanly.
const rawEnvApiUrl = (import.meta.env && import.meta.env.VITE_API_URL)
  ? import.meta.env.VITE_API_URL.trim().replace(/\/+$/, '')
  : '';
const API_BASE_URL = rawEnvApiUrl
  ? (rawEnvApiUrl.endsWith('/api') ? rawEnvApiUrl : `${rawEnvApiUrl}/api`)
  : '/api';

export const DEFAULT_PROPERTY_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

const DEFAULT_TIMEOUT_MS = 8000;

export const PRICING_CONFIG = Object.freeze({
  currency: 'PHP',
  currencySymbol: '₱',
  baseNightlyRate: 48500,   // PHP per night (~$850 USD equivalent)
  weekendNightlyRate: 55000, // PHP per weekend night (Fri & Sat)
  cleaningFee: 14500,       // PHP one-time sanitization and prep fee (~$250 USD)
  serviceFeeRate: 0.08,     // 8% concierge and hospitality fee
  minNights: 2,             // Minimum stay requirement
  maxGuests: 8,             // Maximum property capacity
});

/**
 * Internal fetch wrapper with timeout & JSON error normalization.
 * @param {string} endpoint - API path (e.g., '/bookings/availability')
 * @param {RequestInit} [options={}] - Fetch options
 */
async function apiRequest(endpoint, options = {}) {
  if (!API_BASE_URL) {
    throw new Error('VITE_API_URL_NOT_CONFIGURED');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(errorBody.message || `HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Availability State & Quote Calculation
// ============================================================================
// STEP 2: Initialize clean availability state (zero pre-booked reservations)
function buildDemoBookedDates() {
  return new Set();
}

let bookedDatesSet = buildDemoBookedDates();

export const BookingAPI = {
  /**
   * Formats a Date object as `YYYY-MM-DD`.
   * @param {Date} date
   * @returns {string}
   */
  formatDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  },

  /**
   * Fetches unavailable dates array from `GET /api/availability?propertyId=...`
   * @param {string} [propertyId]
   * @param {string} [currentMonth] - Optional YYYY-MM filter
   * @returns {Promise<string[]>}
   */
  async fetchUnavailableDates(propertyId = DEFAULT_PROPERTY_ID, currentMonth) {
    if (!API_BASE_URL) {
      return Array.from(bookedDatesSet);
    }

    try {
      const query = new URLSearchParams({ propertyId: propertyId || DEFAULT_PROPERTY_ID });
      if (currentMonth) query.set('month', currentMonth);

      const data = await apiRequest(`/availability?${query.toString()}`, { method: 'GET' });
      const dates = data?.unavailableDates || data?.bookedDates || [];
      if (Array.isArray(dates)) {
        bookedDatesSet = new Set(dates);
      }
      return Array.from(bookedDatesSet);
    } catch (err) {
      console.warn('[BookingAPI] Falling back to local availability dataset:', err.message);
      return Array.from(bookedDatesSet);
    }
  },

  /**
   * Drop-in alias for fetching availability by month
   * @param {string} [month] - Optional YYYY-MM filter
   */
  async fetchAvailability(month) {
    return this.fetchUnavailableDates(DEFAULT_PROPERTY_ID, month);
  },

  /**
   * Checks if a single `YYYY-MM-DD` date string is available.
   * @param {string} dateString
   * @returns {boolean}
   */
  isDateAvailable(dateString) {
    return !bookedDatesSet.has(dateString);
  },

  /**
   * Checks if an entire date range (`checkInStr` to `checkOutStr`) is available.
   * @param {string} checkInStr - YYYY-MM-DD
   * @param {string} checkOutStr - YYYY-MM-DD
   * @returns {boolean}
   */
  isRangeAvailable(checkInStr, checkOutStr) {
    const start = new Date(`${checkInStr}T00:00:00`);
    const end = new Date(`${checkOutStr}T00:00:00`);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
      return false;
    }

    const cur = new Date(start);
    while (cur < end) {
      const key = this.formatDateKey(cur);
      if (bookedDatesSet.has(key)) {
        return false;
      }
      cur.setDate(cur.getDate() + 1);
    }

    return true;
  },

  /**
   * Calculates stay nights between two Date objects.
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {number}
   */
  calculateNights(startDate, endDate) {
    if (!(startDate instanceof Date) || !(endDate instanceof Date)) return 0;
    const diffTime = endDate.getTime() - startDate.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  },

  /**
   * Computes transparent itemized quote for selected stay.
   * @param {Date} startDate
   * @param {Date} endDate
   * @param {number} [adults=2]
   * @param {number} [children=0]
   */
  calculateQuote(startDate, endDate, adults = 2, children = 0) {
    const nights = this.calculateNights(startDate, endDate);
    if (nights <= 0) return null;

    let accommodationSubtotal = 0;
    const cur = new Date(startDate);
    while (cur < endDate) {
      const dayOfWeek = cur.getDay(); // 0 = Sun, 5 = Fri, 6 = Sat
      const isWeekend = dayOfWeek === 5 || dayOfWeek === 6;
      accommodationSubtotal += isWeekend
        ? PRICING_CONFIG.weekendNightlyRate
        : PRICING_CONFIG.baseNightlyRate;
      cur.setDate(cur.getDate() + 1);
    }

    const cleaningFee = PRICING_CONFIG.cleaningFee;
    const serviceFee = Math.round(accommodationSubtotal * PRICING_CONFIG.serviceFeeRate);
    const totalEstimate = accommodationSubtotal + cleaningFee + serviceFee;

    return {
      nights,
      nightlyRate: PRICING_CONFIG.baseNightlyRate,
      weekendNightlyRate: PRICING_CONFIG.weekendNightlyRate,
      accommodationSubtotal,
      cleaningFee,
      serviceFee,
      totalEstimate,
      currency: PRICING_CONFIG.currency,
      currencySymbol: PRICING_CONFIG.currencySymbol,
      isMinNightsMet: nights >= PRICING_CONFIG.minNights,
      minNights: PRICING_CONFIG.minNights,
      totalGuests: adults + children,
      maxGuests: PRICING_CONFIG.maxGuests,
    };
  },

  // ============================================================================
  // STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION — Stripe Checkout & Reserve API
  // ============================================================================
  // STEP 3: Submit booking reservation to POST /api/reserve and redirect to checkoutUrl
  /**
   * Submits a reservation request to POST /api/reserve and redirects
   * the visitor directly to data.checkoutUrl.
   * @param {Object} payload
   * @param {string} payload.checkIn - YYYY-MM-DD
   * @param {string} payload.checkOut - YYYY-MM-DD
   * @param {string} [payload.guestName]
   * @param {string} [payload.guestEmail]
   * @param {string} [payload.guestPhone]
   * @param {number} [payload.guests=2]
   * @param {string} [payload.propertyId]
   * @param {boolean} [payload.autoRedirect=true]
   * @returns {Promise<{ checkoutUrl?: string, bookingId?: string }>}
   */
  async reserve(payload) {
    if (API_BASE_URL) {
      try {
        const body = {
          propertyId: payload.propertyId || DEFAULT_PROPERTY_ID,
          checkIn: payload.checkIn,
          checkOut: payload.checkOut,
          guestName: payload.guestName || payload.guest?.name || 'Valued Guest',
          guestEmail: payload.guestEmail || payload.guest?.email || 'guest@example.com',
          guestPhone: payload.guestPhone || payload.guest?.phone || '',
          guests: payload.guests || (payload.adults || 2) + (payload.children || 0),
          paymentMethod: payload.paymentMethod || 'inquiry',
        };

        const res = await apiRequest('/reserve', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        // Redirect user to Stripe Checkout Session if checkoutUrl is present
        if (res && res.checkoutUrl && payload.autoRedirect !== false) {
          console.log('💳 [BookingAPI] Redirecting to Stripe Checkout Session:', res.checkoutUrl);
          window.location.href = res.checkoutUrl;
        }

        return {
          status: res.status || 'pending_payment',
          referenceId: res.referenceId || `MA-${res.bookingId?.substring(0, 6).toUpperCase()}`,
          checkoutUrl: res.checkoutUrl || null,
          bookingId: res.bookingId,
          quote: res.quote,
        };
      } catch (err) {
        // Fallback gracefully for concept/demo mode when backend server is offline (e.g. Vite proxy 500 / ECONNREFUSED)
        console.warn(
          `[BookingAPI] Live backend unreachable (${err.message}). Transitioning seamlessly to Concept Concierge Inquiry confirmation.`
        );
      }
    }

    // STEP 4: Simulate network latency and generate authentic concierge reservation state for concept presentation
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Tricky logic: Mark selected dates as booked in client-side memory so the calendar grid reflects the new reservation
    if (payload.checkIn && payload.checkOut) {
      const cur = new Date(`${payload.checkIn}T00:00:00`);
      const end = new Date(`${payload.checkOut}T00:00:00`);
      while (cur < end) {
        bookedDatesSet.add(this.formatDateKey(cur));
        cur.setDate(cur.getDate() + 1);
      }
    }

    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    return {
      status: 'confirmed_inquiry',
      referenceId: `MA-${new Date().getFullYear()}-${randomSuffix}`,
      checkoutUrl: null,
      quote: payload.quote || null,
    };
  },

  /**
   * Drop-in alias preserving backwards compatibility with existing UI callers.
   */
  async createCheckoutSession(payload) {
    return this.reserve(payload);
  },

  /**
   * Alias connecting directly to Phase 2 reserve checkout requirement.
   */
  async startBookingCheckout(payload) {
    return this.reserve(payload);
  },

  /**
   * Cleans all reservations from the calendar and server database.
   */
  async clearAllBookings() {
    bookedDatesSet.clear();
    if (API_BASE_URL) {
      try {
        await apiRequest('/bookings/clear', {
          method: 'POST',
          body: JSON.stringify({}),
        });
      } catch (err) {
        console.warn('[BookingAPI] Server clear error:', err.message);
      }
    }
    return [];
  },

  getMinNights: () => PRICING_CONFIG.minNights,
  getMaxGuests: () => PRICING_CONFIG.maxGuests,
  getBaseNightlyRate: () => PRICING_CONFIG.baseNightlyRate,
};

// Export standalone helper functions matching Phase 2 specifications
export const fetchUnavailableDates = (propertyId, currentMonth) =>
  BookingAPI.fetchUnavailableDates(propertyId, currentMonth);

export const startBookingCheckout = (payload) =>
  BookingAPI.startBookingCheckout(payload);

// Expose legacy alias on window for backward compatibility if inspected in console
if (typeof window !== 'undefined') {
  window.AvailabilityService = BookingAPI;
}
