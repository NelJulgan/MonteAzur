-- ============================================================================
-- MONTE AZUR — POSTGRESQL DATABASE SCHEMA (server/schema.sql)
-- ============================================================================
-- DEVELOPMENT STAGE:
-- - STAGE 1: FOUNDATION CODE (PostgreSQL Tables, Indices & Constraints)
--
-- WHY THIS CODE EXISTS:
-- Defines the authoritative relational schema for the Monte Azur staycation
-- property, persisting reservations, guest inquiries, price breakdowns, and
-- Stripe payment transaction states.
--
-- TRICKY LOGIC:
-- 1. `booking_status` enum guards against race conditions where two concurrent
--    requests attempt to book the same dates (status 'confirmed' vs 'pending').
-- 2. Check constraint `check_out > check_in` enforces strict date chronology
--    directly at the database engine level.
--
-- TODO:
-- - Optional multi-property partition when expanding beyond Monte Azur.
-- ============================================================================

-- STEP 1: Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- STEP 2: Create Enums for booking lifecycle and payment states
DO $$ BEGIN
    CREATE TYPE booking_status_enum AS ENUM ('pending', 'confirmed', 'cancelled', 'completed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE payment_status_enum AS ENUM ('unpaid', 'paid', 'refunded', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- STEP 3: Create Bookings Table
CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reference_id VARCHAR(16) NOT NULL UNIQUE,
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    adults INT NOT NULL DEFAULT 2 CHECK (adults >= 1),
    children INT NOT NULL DEFAULT 0 CHECK (children >= 0),
    guest_name VARCHAR(255) NOT NULL,
    guest_email VARCHAR(255) NOT NULL,
    guest_phone VARCHAR(64) NOT NULL,
    guest_notes TEXT,
    nights INT NOT NULL CHECK (nights >= 1),
    nightly_rate NUMERIC(10, 2) NOT NULL,
    accommodation_subtotal NUMERIC(10, 2) NOT NULL,
    cleaning_fee NUMERIC(10, 2) NOT NULL,
    service_fee NUMERIC(10, 2) NOT NULL,
    total_amount NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status booking_status_enum NOT NULL DEFAULT 'pending',
    payment_status payment_status_enum NOT NULL DEFAULT 'unpaid',
    stripe_session_id VARCHAR(255),
    stripe_payment_intent_id VARCHAR(255),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT valid_date_range CHECK (check_out > check_in)
);

-- STEP 4: High-Performance Indices for Availability Range Queries
CREATE INDEX IF NOT EXISTS idx_bookings_dates ON bookings (check_in, check_out) WHERE status IN ('pending', 'confirmed');
CREATE INDEX IF NOT EXISTS idx_bookings_reference ON bookings (reference_id);
CREATE INDEX IF NOT EXISTS idx_bookings_guest_email ON bookings (guest_email);
CREATE INDEX IF NOT EXISTS idx_bookings_stripe_session ON bookings (stripe_session_id);

-- STEP 5: Automatic updated_at Trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_bookings_updated_at ON bookings;
CREATE TRIGGER trigger_bookings_updated_at
BEFORE UPDATE ON bookings
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
