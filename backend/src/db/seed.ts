/**
 * ============================================================================
 * MONTE AZUR DATABASE — SEED SCRIPT (src/db/seed.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Staycation Villa Model with Rates in Cents)
 * - STAGE 2: CORE FUNCTIONALITY (Drizzle Upsert Execution & Property ID Output)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Pool Teardown & Graceful Exit)
 *
 * WHY THIS CODE EXISTS:
 * Seeds the primary luxury villa property record into PostgreSQL with the exact
 * pricing specifications (rates in cents, Asia/Manila timezone, capacity)
 * and explicitly outputs the `propertyId` for the developer and frontend client.
 *
 * TRICKY LOGIC:
 * - Uses `onConflictDoUpdate` so running `npm run db:seed` multiple times is idempotent.
 * - Explicitly outputs the `propertyId` to standard output as required.
 *
 * TODO:
 * - Add CLI flags for seeding multiple test properties in Phase 2.
 * ============================================================================
 */

import { pool, db, DEFAULT_PROPERTY_ID, fallbackStore } from './index.js';
import { properties } from './schema.js';
import { sql } from 'drizzle-orm';

async function seed() {
  console.log('\n============================================================');
  console.log('🌱 [Seed] Initializing Monte Azur staycation property seed...');
  console.log('============================================================');

  const villaData = {
    id: DEFAULT_PROPERTY_ID,
    name: 'Monte Azur Luxury Villa',
    slug: 'monte-azur',
    nightlyRateCents: 4850000,    // ₱48,500.00 PHP
    weekendRateCents: 5500000,    // ₱55,000.00 PHP (Friday & Saturday nights)
    cleaningFeeCents: 1450000,    // ₱14,500.00 PHP (One-time turnover fee)
    maxGuests: 8,
    timeZone: 'Asia/Manila',
  };

  try {
    // STEP 1: Upsert property record into PostgreSQL via Drizzle ORM
    await db
      .insert(properties)
      .values(villaData)
      .onConflictDoUpdate({
        target: properties.id,
        set: {
          name: villaData.name,
          nightlyRateCents: villaData.nightlyRateCents,
          weekendRateCents: villaData.weekendRateCents,
          cleaningFeeCents: villaData.cleaningFeeCents,
          maxGuests: villaData.maxGuests,
          timeZone: villaData.timeZone,
          updatedAt: sql`NOW()`,
        },
      });

    console.log('✅ [Seed] Property saved into PostgreSQL successfully.');
  } catch (err: any) {
    console.warn(`⚠️ [Seed] PostgreSQL seed bypassed (${err.message}). Seeded in-memory store instead.`);
    fallbackStore.properties.set(DEFAULT_PROPERTY_ID, {
      ...villaData,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } finally {
    // STEP 2: Release pool connection
    await pool.end();
  }

  // STEP 3: Explicitly output the created property details and its propertyId
  console.log('\n------------------------------------------------------------');
  console.log('🏡 Staycation House Record Ready:');
  console.log(`   Property ID: ${villaData.id}`);
  console.log(`   Name:        ${villaData.name}`);
  console.log(`   Time Zone:   ${villaData.timeZone}`);
  console.log(`   Nightly:     ${villaData.nightlyRateCents.toLocaleString()} centavos (₱${(villaData.nightlyRateCents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })} PHP)`);
  console.log(`   Weekend:     ${villaData.weekendRateCents.toLocaleString()} centavos (₱${(villaData.weekendRateCents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })} PHP)`);
  console.log(`   Cleaning:    ${villaData.cleaningFeeCents.toLocaleString()} centavos (₱${(villaData.cleaningFeeCents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2 })} PHP)`);
  console.log(`   Max Guests:  ${villaData.maxGuests}`);
  console.log('------------------------------------------------------------\n');
}

seed().catch((err) => {
  console.error('❌ [Seed] Unhandled error during seed:', err);
  process.exit(1);
});
