/**
 * ============================================================================
 * MONTE AZUR DATABASE — DRIZZLE ORM SCHEMA DEFINITION (schema.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Properties & Bookings Relational Tables)
 * - STAGE 2: CORE FUNCTIONALITY (Currency Cents, Timezones & Hold Expirations)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Foreign Key Cascades & TypeScript Types)
 *
 * WHY THIS CODE EXISTS:
 * Defines the authoritative Drizzle ORM schema mapping for PostgreSQL tables.
 * Stores monetary rates strictly in integer cents (eliminating floating point rounding errors)
 * and sets 'Asia/Manila' as the primary property timezone.
 *
 * TRICKY LOGIC:
 * - Dates use `date(..., { mode: 'string' })` returning `YYYY-MM-DD` strings, avoiding
 *   timezone drift across client/server UTC conversions.
 * - `holdExpiresAt` provides TTL awareness for pending reservations awaiting Stripe payment.
 *
 * TODO:
 * - Implement recurring seasonal rate adjustment tables in Phase 2.
 * ============================================================================
 */

import { pgTable, uuid, varchar, integer, date, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ============================================================================
// STAGE 1: FOUNDATION CODE — Properties Table Definition
// ============================================================================

// STEP 1: Define properties table with rates in integer cents and timezone
export const properties = pgTable('properties', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  nightlyRateCents: integer('nightly_rate_cents').notNull(),
  weekendRateCents: integer('weekend_rate_cents').notNull(),
  cleaningFeeCents: integer('cleaning_fee_cents').notNull(),
  maxGuests: integer('max_guests').default(8).notNull(),
  timeZone: varchar('time_zone', { length: 50 }).default('Asia/Manila').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Bookings Table Definition
// ============================================================================

// STEP 2: Define bookings table with double-booking defense attributes
export const bookings = pgTable('bookings', {
  id: uuid('id').defaultRandom().primaryKey(),
  propertyId: uuid('property_id')
    .notNull()
    .references(() => properties.id, { onDelete: 'cascade' }),
  guestName: varchar('guest_name', { length: 255 }).notNull(),
  guestEmail: varchar('guest_email', { length: 255 }).notNull(),
  guestPhone: varchar('guest_phone', { length: 50 }),
  guests: integer('guests').default(2).notNull(),
  checkInDate: date('check_in_date', { mode: 'string' }).notNull(),
  checkOutDate: date('check_out_date', { mode: 'string' }).notNull(),
  totalCents: integer('total_cents').notNull(),
  status: varchar('status', { length: 50 }).default('pending').notNull(), // 'pending', 'confirmed', 'cancelled'
  stripeSessionId: varchar('stripe_session_id', { length: 255 }),
  stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }),
  holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// STAGE 3: ENHANCEMENT / OPTIMIZATION — Relations & TypeScript Types
// ============================================================================

// STEP 3: Define relational associations
export const propertiesRelations = relations(properties, ({ many }) => ({
  bookings: many(bookings),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
  property: one(properties, {
    fields: [bookings.propertyId],
    references: [properties.id],
  }),
}));

// STEP 4: Infer TypeScript static types
export type Property = typeof properties.$inferSelect;
export type NewProperty = typeof properties.$inferInsert;

export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;
