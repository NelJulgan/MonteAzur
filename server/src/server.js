/**
 * ============================================================================
 * MONTE AZUR — EXPRESS REST API SERVER ENTRY (server/src/server.js)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 2: CORE FUNCTIONALITY (Express Application, CORS, Webhooks & Bootstrap)
 *
 * WHY THIS MODULE EXISTS:
 * Starts the Node.js backend server, mounts API routes under `/api/v1`,
 * sets up CORS headers, and verifies database connectivity on boot.
 *
 * TRICKY LOGIC:
 * Stripe webhooks require the raw unparsed request buffer (`express.raw()`)
 * to compute cryptographic signatures (`stripe-signature`). Mounting the
 * webhook route BEFORE `express.json()` ensures signature validation never fails.
 *
 * TODO:
 * - Mount Swagger / OpenAPI docs endpoint at `/api/docs`.
 * ============================================================================
 */

import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initDb } from './db.js';
import { bookingRouter } from './routes/bookings.js';
import { stripeService } from './stripe.js';
import { bookingService } from './services/bookingService.js';

const app = express();

// STEP 1: Global Security & CORS Middleware
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow local development ports (Vite 5173, etc.) and configured CLIENT_URL
      if (!origin || origin.startsWith('http://localhost:') || origin === config.clientUrl) {
        callback(null, true);
      } else {
        callback(null, true); // Permissive in development
      }
    },
    credentials: true,
  })
);

// STEP 2: Raw Body Webhook Route for Stripe Signature Verification
app.post(
  '/api/v1/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return res.status(400).send('Missing stripe-signature header');
    }

    try {
      const event = stripeService.constructWebhookEvent(req.body, signature);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        await bookingService.handleStripeSessionCompleted(session);
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error('❌ [Webhook Error]', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

// STEP 3: Standard JSON Body Parsing for all other routes
app.use(express.json());

// STEP 4: Mount Application Routes
app.use('/api/v1/bookings', bookingRouter);

// Healthcheck & Metadata Endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    property: config.pricing.propertyName,
    environment: config.nodeEnv,
    stripeConfigured: stripeService.isConfigured(),
    timestamp: new Date().toISOString(),
  });
});

// STEP 5: Start Server & Initialize Database
async function bootstrap() {
  await initDb();

  const server = app.listen(config.port, () => {
    console.log(`\n======================================================`);
    console.log(`🌟 Monte Azur Booking Backend Server Active`);
    console.log(`📡 URL: http://localhost:${config.port}`);
    console.log(`🔌 Healthcheck: http://localhost:${config.port}/health`);
    console.log(`📅 Availability API: http://localhost:${config.port}/api/v1/bookings/availability`);
    console.log(`======================================================\n`);
  });

  const handleShutdown = () => {
    console.log('\n🛑 Gracefully shutting down Monte Azur backend...');
    server.close(() => {
      console.log('✅ HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', handleShutdown);
  process.on('SIGINT', handleShutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
