/**
 * ============================================================================
 * MONTE AZUR — SERVER CONFIGURATION & PRICING ENGINE (server/src/config.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Environment Loading & Configuration Constants)
 *
 * WHY THIS MODULE EXISTS:
 * Centralizes all runtime environment configurations, database URLs, Stripe credentials,
 * and authoritative pricing rules for the Monte Azur backend.
 *
 * TRICKY LOGIC:
 * All monetary calculations use integer cents ($1 = 100 cents) when communicating
 * with Stripe to eliminate JavaScript IEEE-754 floating point rounding drift.
 *
 * TODO:
 * - Add seasonal holiday rate multipliers (e.g. Christmas / New Year peak rates).
 * ============================================================================
 */

import dotenv from 'dotenv';
dotenv.config();

export const config = Object.freeze({
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // Database
  databaseUrl: process.env.DATABASE_URL || '',

  // Stripe
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

  // Client URL for redirects
  clientUrl: (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/+$/, ''),

  // Authoritative Property Pricing Rules
  pricing: Object.freeze({
    propertyName: 'Monte Azur Architectural Villa',
    baseNightlyRate: 850,     // USD per night
    cleaningFee: 250,         // USD one-time prep fee
    serviceFeeRate: 0.08,     // 8% concierge & maintenance fee
    minNights: 2,             // Minimum stay requirement
    maxGuests: 8,             // Villa capacity limit
    currency: 'USD',
  }),
});
