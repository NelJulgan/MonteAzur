/**
 * ============================================================================
 * MONTE AZUR SERVICES — STRIPE PAYMENT GATEWAY INTEGRATION (src/services/stripe.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Stripe SDK Initialization & Environment Guards)
 * - STAGE 2: CORE FUNCTIONALITY (Hosted Checkout Session Generation with Itemized Breakdown)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Cryptographic Webhook Signature Verification)
 *
 * WHY THIS CODE EXISTS:
 * Handles secure, PCI-compliant payment collection for luxury stays via Stripe Checkout.
 * Encapsulates checkout session creation, line-item tax/fee calculations, and signature validation.
 *
 * TRICKY LOGIC:
 * - Stripe amounts are in cents (integer multiply by 100).
 * - If running with placeholder developer keys (`sk_test_placeholder`), generates a safe
 *   mock checkout response so the UI reservation flow can be thoroughly tested locally.
 *
 * TODO:
 * - Enable Stripe Klarna / Apple Pay automatic payment methods in Phase 2.
 * ============================================================================
 */

import Stripe from 'stripe';
import * as dotenv from 'dotenv';

dotenv.config();

const stripeApiKey = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder';
const isStripeConfigured = stripeApiKey && !stripeApiKey.includes('placeholder');

// STEP 1: Initialize Stripe instance with official API version
export const stripe = new Stripe(stripeApiKey, {
  apiVersion: '2024-06-20' as any,
  typescript: true,
});

export interface CreateCheckoutParams {
  bookingId: string;
  propertyId: string;
  propertyName: string;
  guestEmail: string;
  guestName: string;
  guestPhone?: string;
  guests?: number;
  checkIn: string;
  checkOut: string;
  nights: number;
  nightlyRateCents?: number;
  weekendRateCents?: number;
  cleaningFeeCents?: number;
  serviceFeeCents?: number;
  totalCents?: number;
  nightlyRate?: number;     // Fallback
  cleaningFee?: number;     // Fallback
  serviceFee?: number;      // Fallback
  totalPrice?: number;      // Fallback
}

// STEP 2: Create Stripe Checkout Session
export async function createStripeCheckoutSession(params: CreateCheckoutParams) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

  // Resilient fallback for local test runs without live Stripe credentials
  if (!isStripeConfigured) {
    console.log(`ℹ️ [Stripe] Simulating checkout session for booking ${params.bookingId} (${params.guestEmail})`);
    return {
      id: `cs_simulated_${params.bookingId}`,
      url: `${frontendUrl}/success.html?session_id=cs_simulated_${params.bookingId}&reference=${params.bookingId}`,
      payment_status: 'unpaid',
      customer_email: params.guestEmail,
    };
  }

  const nightlyCents = params.nightlyRateCents ?? ((params.nightlyRate ?? 850) * 100);
  const cleaningCents = params.cleaningFeeCents ?? ((params.cleaningFee ?? 250) * 100);
  const serviceCents = params.serviceFeeCents ?? ((params.serviceFee ?? 204) * 100);

  // STEP 3: Build itemized Stripe line items in centavos (PHP)
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price_data: {
        currency: 'php',
        product_data: {
          name: `${params.propertyName} — Luxury Stay (${params.nights} nights)`,
          description: `Check-in: ${params.checkIn} | Check-out: ${params.checkOut}`,
        },
        unit_amount: nightlyCents,
      },
      quantity: params.nights,
    },
    {
      price_data: {
        currency: 'php',
        product_data: {
          name: 'Professional Sanitization & Preparation Fee',
          description: 'One-time villa turnover, linen service, and welcome prep',
        },
        unit_amount: cleaningCents,
      },
      quantity: 1,
    },
    {
      price_data: {
        currency: 'php',
        product_data: {
          name: 'Concierge & Hospitality Fee (8%)',
          description: '24/7 dedicated guest concierge, security, and amenities access',
        },
        unit_amount: serviceCents,
      },
      quantity: 1,
    },
  ];

  // STEP 4: Create hosted Stripe checkout session (expires in 30 minutes)
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    customer_email: params.guestEmail,
    client_reference_id: params.bookingId,
    line_items: lineItems,
    mode: 'payment',
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60 + 10, // 30 minutes + 10s clock buffer
    success_url: `${frontendUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&reference=${params.bookingId}`,
    cancel_url: `${frontendUrl}/?booking=cancelled`,
    metadata: {
      bookingId: params.bookingId,
      propertyId: params.propertyId,
      checkIn: params.checkIn,
      checkOut: params.checkOut,
      guestName: params.guestName,
      guestEmail: params.guestEmail,
      guestPhone: params.guestPhone || '',
      guests: String(params.guests || 2),
    },
  });

  return session;
}

// STEP 5: Verify cryptographic Stripe webhook signature using raw body buffer
export function constructWebhookEvent(rawPayload: string | Buffer, signature: string) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder';
  return stripe.webhooks.constructEvent(rawPayload, signature, webhookSecret);
}
