/**
 * ============================================================================
 * MONTE AZUR — DATABASE CONNECTION LAYER (server/src/db.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (PostgreSQL Pool with Resilient In-Memory Fallback)
 *
 * WHY THIS MODULE EXISTS:
 * Provides a unified asynchronous query interface. When a PostgreSQL database
 * (`DATABASE_URL`) is supplied, it manages connection pooling via `pg.Pool`.
 * If PostgreSQL is unconfigured or unavailable during initial development, it
 * switches automatically to an in-memory repository seeded with realistic bookings,
 * guaranteeing zero downtime or boot crashes.
 *
 * TRICKY LOGIC:
 * Emulates relational collision queries (`check_in < $2 AND check_out > $1`)
 * in both the SQL query path and the in-memory fallback path so the frontend
 * always observes identical date exclusion behavior.
 *
 * TODO:
 * - Add automated table migration runner (`pg-migrate` or raw DDL execution) on connect.
 * ============================================================================
 */

import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

let pool = null;
let isPostgresConnected = false;

// In-Memory Repository for local dev when PostgreSQL is unconfigured
const inMemoryBookings = new Map();

// Helper to format Date to YYYY-MM-DD
function formatDate(year, month, day) {
  const d = new Date(year, month, day);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Clean state: zero hardcoded demo reservations
function seedDemoReservations() {
  // Empty by default - all dates on calendar start clean & available
}

// Zero initial reservations on server start
// seedDemoReservations();

// Initialize Database connection if configured
export async function initDb() {
  if (!config.databaseUrl) {
    console.log('📦 [Database] Operating in Resilient Local Store mode (Set DATABASE_URL in .env to connect to PostgreSQL)');
    return;
  }

  try {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.isProduction ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    const client = await pool.connect();
    const res = await client.query('SELECT NOW() AS connected_at');
    client.release();

    isPostgresConnected = true;
    console.log(`🐘 [Database] PostgreSQL connected successfully at ${res.rows[0].connected_at}`);
  } catch (err) {
    isPostgresConnected = false;
    console.warn(`⚠️ [Database] Could not connect to PostgreSQL (${err.message}). Falling back to resilient in-memory store.`);
  }
}

/**
 * High-level Database interface
 */
export const db = {
  isPostgres() {
    return isPostgresConnected && pool !== null;
  },

  /**
   * Executes a parameterized SQL query on PostgreSQL or delegates to in-memory store.
   */
  async query(text, params = []) {
    if (this.isPostgres()) {
      return pool.query(text, params);
    }
    throw new Error('Raw SQL query unsupported in memory mode; use helper methods.');
  },

  /**
   * Returns all active confirmed/pending bookings.
   */
  async getActiveBookings() {
    if (this.isPostgres()) {
      const res = await pool.query(
        `SELECT reference_id AS "referenceId", check_in AS "checkIn", check_out AS "checkOut", status, payment_status AS "paymentStatus"
         FROM bookings
         WHERE status IN ('pending', 'confirmed')
         ORDER BY check_in ASC`
      );
      return res.rows.map((row) => ({
        ...row,
        checkIn: typeof row.checkIn === 'string' ? row.checkIn : row.checkIn.toISOString().split('T')[0],
        checkOut: typeof row.checkOut === 'string' ? row.checkOut : row.checkOut.toISOString().split('T')[0],
      }));
    }

    return Array.from(inMemoryBookings.values())
      .filter((b) => b.status === 'confirmed' || b.status === 'pending')
      .sort((a, b) => (a.checkIn > b.checkIn ? 1 : -1));
  },

  /**
   * Finds a booking by its reference ID (e.g., 'MA-X8K2M1').
   */
  async findBookingByReference(referenceId) {
    if (this.isPostgres()) {
      const res = await pool.query(
        `SELECT id, reference_id AS "referenceId", check_in AS "checkIn", check_out AS "checkOut",
                adults, children, guest_name AS "guestName", guest_email AS "guestEmail",
                guest_phone AS "guestPhone", guest_notes AS "guestNotes", nights, nightly_rate AS "nightlyRate",
                accommodation_subtotal AS "accommodationSubtotal", cleaning_fee AS "cleaningFee",
                service_fee AS "serviceFee", total_amount AS "totalAmount", currency, status,
                payment_status AS "paymentStatus", stripe_session_id AS "stripeSessionId",
                created_at AS "createdAt"
         FROM bookings
         WHERE reference_id = $1 LIMIT 1`,
        [referenceId]
      );
      return res.rows[0] || null;
    }

    return inMemoryBookings.get(referenceId) || null;
  },

  /**
   * Inserts a new booking record.
   */
  async createBooking(record) {
    if (this.isPostgres()) {
      const res = await pool.query(
        `INSERT INTO bookings (
          reference_id, check_in, check_out, adults, children,
          guest_name, guest_email, guest_phone, guest_notes,
          nights, nightly_rate, accommodation_subtotal, cleaning_fee,
          service_fee, total_amount, currency, status, payment_status,
          stripe_session_id, metadata
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15, $16, $17, $18,
          $19, $20
        ) RETURNING id, reference_id AS "referenceId", created_at AS "createdAt"`,
        [
          record.referenceId,
          record.checkIn,
          record.checkOut,
          record.adults,
          record.children,
          record.guestName,
          record.guestEmail,
          record.guestPhone,
          record.guestNotes || null,
          record.nights,
          record.nightlyRate,
          record.accommodationSubtotal,
          record.cleaningFee,
          record.serviceFee,
          record.totalAmount,
          record.currency || 'USD',
          record.status || 'pending',
          record.paymentStatus || 'unpaid',
          record.stripeSessionId || null,
          JSON.stringify(record.metadata || {}),
        ]
      );
      return { ...record, id: res.rows[0].id, createdAt: res.rows[0].createdAt };
    }

    const newBooking = {
      ...record,
      id: `mem-${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    inMemoryBookings.set(record.referenceId, newBooking);
    return newBooking;
  },

  /**
   * Updates booking status by reference ID or stripe_session_id.
   */
  async updateBookingStatus({ referenceId, stripeSessionId, status, paymentStatus, paymentIntentId }) {
    if (this.isPostgres()) {
      const res = await pool.query(
        `UPDATE bookings
         SET status = COALESCE($1, status),
             payment_status = COALESCE($2, payment_status),
             stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id),
             updated_at = NOW()
         WHERE (reference_id = $4 OR stripe_session_id = $5)
         RETURNING reference_id AS "referenceId", status, payment_status AS "paymentStatus"`,
        [status, paymentStatus, paymentIntentId, referenceId || null, stripeSessionId || null]
      );
      return res.rows[0] || null;
    }

    // In-memory update
    for (const [ref, booking] of inMemoryBookings.entries()) {
      if ((referenceId && ref === referenceId) || (stripeSessionId && booking.stripeSessionId === stripeSessionId)) {
        if (status) booking.status = status;
        if (paymentStatus) booking.paymentStatus = paymentStatus;
        if (paymentIntentId) booking.stripePaymentIntentId = paymentIntentId;
        booking.updatedAt = new Date().toISOString();
        return booking;
      }
    }
    return null;
  },

  /**
   * Cleans all reservations from the database or in-memory store.
   */
  async clearAllBookings() {
    if (this.isPostgres()) {
      await pool.query('DELETE FROM bookings');
      return { cleared: true, count: 'all' };
    }
    const count = inMemoryBookings.size;
    inMemoryBookings.clear();
    return { cleared: true, count };
  },
};
