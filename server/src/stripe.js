/**
 * ============================================================================
 * MONTE AZUR — STRIPE PAYMENT SERVICE (server/src/stripe.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 2: CORE FUNCTIONALITY (Stripe Checkout Session & Webhook Verification)
 *
 * WHY THIS MODULE EXISTS:
 * Integrates Stripe Checkout for secure credit card and digital wallet payments.
 * Converts quotes into exact itemized line items (Accommodation, Cleaning Fee,
 * and Concierge Fee) in integer cents.
 *
 * TRICKY LOGIC:
 * Stripe requires monetary amounts in the currency's smallest unit (cents for USD:
 * $850.00 = 85000). Math.round() guarantees no fractional cents.
 *
 * TODO:
 * - Support multi-currency checkout (EUR, GBP) with dynamic FX rates.
 * ============================================================================
 */

import Stripe from 'stripe';
import { config } from './config.js';

let stripeClient = null;

if (config.stripeSecretKey) {
  stripeClient = new Stripe(config.stripeSecretKey, {
    apiVersion: '2023-10-16',
    appInfo: {
      name: 'Monte Azur Staycation',
      version: '1.0.0',
    },
  });
  console.log('💳 [Stripe] Stripe SDK initialized with live/test secret key.');
} else {
  console.log('💳 [Stripe] Operating in Concierge Simulation mode (Set STRIPE_SECRET_KEY in .env to enable real Stripe Checkout).');
}

export const stripeService = {
  isConfigured() {
    return stripeClient !== null;
  },

  /**
   * Generates a Stripe Checkout Session for a booking request.
   * @param {Object} booking - Booking entity containing quote, dates, and guest details
   */
  async createCheckoutSession(booking) {
    if (!this.isConfigured()) {
      return {
        sessionId: `sim_cs_${Math.random().toString(36).substring(2, 10)}`,
        url: null,
        isSimulated: true,
      };
    }

    const { referenceId, checkIn, checkOut, nights, nightlyRate, cleaningFee, serviceFee, guestName, guestEmail } = booking;

    const lineItems = [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${config.pricing.propertyName} — ${nights} Nights Stay`,
            description: `Check-in: ${checkIn} | Check-out: ${checkOut} (Guest: ${guestName})`,
          },
          unit_amount: Math.round(nightlyRate * 100),
        },
        quantity: nights,
      },
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Architectural Sanitization & Property Preparation Fee',
            description: 'One-time professional housekeeping, fresh Italian linens, and pre-arrival prep.',
          },
          unit_amount: Math.round(cleaningFee * 100),
        },
        quantity: 1,
      },
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Concierge Hospitality & Facility Maintenance (8%)',
            description: '24/7 dedicated local host, heated pool utilities, and amenities access.',
          },
          unit_amount: Math.round(serviceFee * 100),
        },
        quantity: 1,
      },
    ];

    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: guestEmail,
      client_reference_id: referenceId,
      line_items: lineItems,
      success_url: `${config.clientUrl}/?booking=confirmed&ref=${referenceId}&session_id={CHECKOUT_SESSION_ID}#booking`,
      cancel_url: `${config.clientUrl}/?booking=cancelled&ref=${referenceId}#booking`,
      metadata: {
        referenceId,
        checkIn,
        checkOut,
        guestName,
      },
    });

    return {
      sessionId: session.id,
      url: session.url,
      isSimulated: false,
    };
  },

  /**
   * Verifies Stripe Webhook signature and returns the parsed Stripe event.
   */
  constructWebhookEvent(rawBody, signature) {
    if (!this.isConfigured() || !config.stripeWebhookSecret) {
      throw new Error('STRIPE_WEBHOOK_NOT_CONFIGURED');
    }
    return stripeClient.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  },
};
