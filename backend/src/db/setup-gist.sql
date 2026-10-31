-- ============================================================================
-- MONTE AZUR DATABASE — EXTENSION & SCHEMA SETUP (setup-gist.sql)
-- ============================================================================
-- DEVELOPMENT STAGE:
-- - STAGE 1: FOUNDATION CODE (PostgreSQL btree_gist Extension & Properties Table)
-- - STAGE 2: CORE FUNCTIONALITY (Bookings Table & Half-Open GiST Exclusion Constraint)
-- - STAGE 3: ENHANCEMENT / OPTIMIZATION (Composite Indexes & Status Guards)
--
-- WHY THIS CODE EXISTS:
-- Implements mathematical double-booking defense directly inside PostgreSQL.
-- Uses `btree_gist` to evaluate equality (=) on `property_id` combined with
-- range intersection (&&) on `daterange(check_in_date, check_out_date, '[)')`.
--
-- TRICKY LOGIC:
-- 1. `daterange(..., '[)')`: Half-open range (inclusive start, exclusive end).
--    If Guest A checks out on Nov 15 and Guest B checks in on Nov 15,
--    Guest A's range is [Nov 12, Nov 15) and Guest B's is [Nov 15, Nov 18).
--    The mathematical intersection [Nov 12, Nov 15) && [Nov 15, Nov 18) is EMPTY.
--    This allows same-day villa turnarounds (morning departure, afternoon arrival)
--    without triggering a false positive double-booking violation.
-- 2. `WHERE (status IN ('confirmed', 'pending'))`:
--    Both confirmed stays AND active pending checkout holds are defended against collisions.
--    Cancelled bookings are excluded, immediately releasing their dates.
--
-- TODO:
-- - Execute via: `psql -d $DATABASE_URL -f setup-gist.sql`
-- ============================================================================

-- STEP 1: Enable the btree_gist extension required for combined UUID equality and daterange overlaps
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- STEP 2: Create properties table with rates in cents and Asia/Manila default timezone
CREATE TABLE IF NOT EXISTS properties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    nightly_rate_cents INTEGER NOT NULL,          -- Rate in cents (e.g., 85000 = $850.00)
    weekend_rate_cents INTEGER NOT NULL,          -- Weekend rate in cents (e.g., 95000 = $950.00)
    cleaning_fee_cents INTEGER NOT NULL,          -- Cleaning fee in cents (e.g., 25000 = $250.00)
    max_guests INTEGER NOT NULL DEFAULT 8,        -- Maximum capacity constraint
    time_zone VARCHAR(50) NOT NULL DEFAULT 'Asia/Manila', -- Staycation local timezone
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- STEP 3: Create bookings table with GiST exclusion constraint
CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    guest_name VARCHAR(255) NOT NULL,
    guest_email VARCHAR(255) NOT NULL,
    guest_phone VARCHAR(50),
    guests INTEGER NOT NULL DEFAULT 2,
    check_in_date DATE NOT NULL,
    check_out_date DATE NOT NULL,
    total_cents INTEGER NOT NULL,                 -- Total price in cents
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'confirmed', 'cancelled'
    stripe_session_id VARCHAR(255),
    stripe_payment_intent_id VARCHAR(255),
    hold_expires_at TIMESTAMP WITH TIME ZONE,     -- Temporary hold TTL for pending reservations
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Date logic integrity check
    CONSTRAINT check_valid_date_range CHECK (check_out_date > check_in_date),

    -- Status enum constraint (includes administrative/channel maintenance blocks)
    CONSTRAINT check_booking_status CHECK (status IN ('pending', 'confirmed', 'cancelled', 'maintenance')),

    -- Mathematical exclusion constraint preventing double booking
    CONSTRAINT no_overlapping_bookings 
    EXCLUDE USING gist (
        property_id WITH =,
        daterange(check_in_date, check_out_date, '[)') WITH &&
    ) WHERE (status IN ('confirmed', 'pending', 'maintenance'))
);

-- STEP 4: Create performance indexes for high-throughput availability checks
CREATE INDEX IF NOT EXISTS idx_bookings_property_dates 
ON bookings (property_id, check_in_date, check_out_date);

CREATE INDEX IF NOT EXISTS idx_bookings_status_hold 
ON bookings (status, hold_expires_at);

CREATE INDEX IF NOT EXISTS idx_bookings_stripe_session 
ON bookings (stripe_session_id);
