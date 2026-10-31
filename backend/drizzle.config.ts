/**
 * ============================================================================
 * MONTE AZUR BACKEND — DRIZZLE ORM CONFIGURATION (drizzle.config.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Drizzle Kit CLI & Migration Dialect Configuration)
 * - STAGE 2: CORE FUNCTIONALITY (PostgreSQL Connection URL & Schema Targeting)
 * - STAGE 3: ENHANCEMENT / ANIMATION / OPTIMIZATION (Strict Type Check & GIST Constraints)
 *
 * WHY THIS CODE EXISTS:
 * Configures Drizzle Kit CLI for automated schema generation, migration tracking,
 * and database introspection against PostgreSQL.
 *
 * TRICKY LOGIC:
 * - Uses `postgresql` dialect and reads `DATABASE_URL` with a local fallback so
 *   CLI commands run predictably in Docker or host developer environments.
 *
 * TODO:
 * - Run `npm run db:generate` to generate SQL snapshots when altering schema columns.
 * ============================================================================
 */

import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';

// STEP 1: Load environment variables from backend .env
dotenv.config();

// STEP 2: Export Drizzle configuration definition
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/staycation',
  },
  verbose: true,
  strict: true,
});
