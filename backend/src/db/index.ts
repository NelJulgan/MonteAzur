/**
 * ============================================================================
 * MONTE AZUR DATABASE — DRIZZLE ORM & POOL INITIALIZATION (src/db/index.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (PostgreSQL Connection Pool & Drizzle Client)
 * - STAGE 2: CORE FUNCTIONALITY (Connection Healthcheck & Resilient In-Memory Schema)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Asia/Manila Property Seeds & Hold Awareness)
 *
 * WHY THIS CODE EXISTS:
 * Manages the connection lifecycle to PostgreSQL. If a live PostgreSQL server is
 * connected, it runs queries with transaction locking and GiST exclusion verification.
 * If PostgreSQL is offline during local developer testing, it provides an in-memory
 * resilient fallback so the API server never crashes on launch.
 *
 * TRICKY LOGIC:
 * - In dev fallback mode, all reservation records and availability states are held
 *   in high-performance memory matching Drizzle's relational schema semantics,
 *   including `holdExpiresAt` TTL expiration checks.
 *
 * TODO:
 * - Configure connection pooling parameters for AWS RDS / Supabase serverless pgBouncer.
 * ============================================================================
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as dotenv from 'dotenv';
import * as schema from './schema.js';

dotenv.config();

const { Pool } = pg;

// ============================================================================
// STAGE 1: FOUNDATION CODE — PostgreSQL Pool & Drizzle Instance
// ============================================================================

// STEP 1: Initialize pg.Pool with configurable environment parameters
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/staycation';

export const pool = new Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export const db = drizzle(pool, { schema });

// Track real database availability state
let isPostgresAvailable = false;

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Resilient In-Memory Fallback Store
// ============================================================================

// STEP 2: Seed deterministic default property record (Monte Azur Luxury Villa)
export const DEFAULT_PROPERTY_ID = process.env.PROPERTY_ID || 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

export interface InMemProperty {
  id: string;
  name: string;
  slug: string;
  nightlyRateCents: number;
  weekendRateCents: number;
  cleaningFeeCents: number;
  maxGuests: number;
  timeZone: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InMemBooking {
  id: string;
  propertyId: string;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  guests: number;
  checkInDate: string;
  checkOutDate: string;
  totalCents: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'maintenance';
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  holdExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Resilient memory cache used if PostgreSQL is offline
export const fallbackStore = {
  properties: new Map<string, InMemProperty>([
    [
      DEFAULT_PROPERTY_ID,
      {
        id: DEFAULT_PROPERTY_ID,
        name: 'Monte Azur Luxury Villa',
        slug: 'monte-azur',
        nightlyRateCents: 4850000, // ₱48,500.00 PHP
        weekendRateCents: 5500000, // ₱55,000.00 PHP
        cleaningFeeCents: 1450000, // ₱14,500.00 PHP
        maxGuests: 8,
        timeZone: 'Asia/Manila',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  ]),
  bookings: new Map<string, InMemBooking>(),
};

// ============================================================================
// STAGE 3: ENHANCEMENT / OPTIMIZATION — Startup Diagnostics & Health Check
// ============================================================================

// STEP 3: Verify PostgreSQL connection on startup without terminating server process
export async function verifyDatabaseConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      isPostgresAvailable = true;
      console.log('✅ [Database] PostgreSQL connected successfully via Drizzle ORM.');
      return true;
    } finally {
      client.release();
    }
  } catch (err: any) {
    isPostgresAvailable = false;
    console.warn('⚠️ [Database] PostgreSQL is currently offline or unreachable (' + (err.message || 'connection failed') + ').');
    console.warn('💡 [Database] Running in resilient in-memory mode. Property ID: ' + DEFAULT_PROPERTY_ID);
    return false;
  }
}

export function isDbLive(): boolean {
  return isPostgresAvailable;
}
