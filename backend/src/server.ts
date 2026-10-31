/**
 * ============================================================================
 * MONTE AZUR BACKEND — FASTIFY APPLICATION SERVER (src/server.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (Fastify Server & Security Middleware Plugins)
 * - STAGE 2: CORE FUNCTIONALITY (Route Mounting & Database Lifecycle Probe)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Graceful Shutdown & Process Diagnostics)
 *
 * WHY THIS FILE EXISTS:
 * Serves as the primary entry point for the standalone booking backend.
 * Configures enterprise security (Helmet), CORS for the Vite frontend, rate limiting,
 * raw body ingestion for Stripe webhooks, and manages server lifecycle.
 *
 * TRICKY LOGIC:
 * - `fastify-raw-body` MUST be registered before routes so that the untransformed
 *   HTTP request buffer is preserved for Stripe signature HMAC verification.
 *
 * TODO:
 * - Add OpenTelemetry instrumentation / Prometheus metrics exporter in Phase 2.
 * ============================================================================
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyRawBody from 'fastify-raw-body';
import * as dotenv from 'dotenv';
import { verifyDatabaseConnection, isDbLive, pool } from './db/index.js';
import { isRedisLive } from './services/redis.js';
import availabilityRoutes from './routes/availability.js';
import reserveRoutes from './routes/reserve.js';
import webhookRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';
import icalRoutes from './routes/ical.js';
import telegramRoutes, { startTelegramPolling } from './routes/telegram.js';
import {
  startExpiredHoldCleanupCron,
  stopExpiredHoldCleanupCron,
  startDailyBriefingCron,
  stopDailyBriefingCron,
} from './services/cron.js';
import { startNotificationWorker } from './services/worker.js';
import { startIcalSyncCron, stopIcalSyncCron } from './services/ical.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

// ============================================================================
// STAGE 1: FOUNDATION CODE — Server Initialization & Middleware Plugins
// ============================================================================

// STEP 1: Instantiate Fastify application with clean structured logging
const server = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'info',
  },
});

async function buildServer() {
  // STEP 2: Register raw-body plugin FIRST for Stripe webhooks
  await server.register(fastifyRawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  });

  // STEP 3: Register security headers with Helmet (strict CSP & HSTS in production)
  const isProduction = process.env.NODE_ENV === 'production';
  await server.register(helmet, {
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://challenges.cloudflare.com', 'https://js.stripe.com'],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            frameSrc: ["'self'", 'https://challenges.cloudflare.com', 'https://js.stripe.com'],
            connectSrc: ["'self'", 'https://challenges.cloudflare.com', 'https://api.stripe.com', FRONTEND_URL],
          },
        }
      : false,
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });

  // STEP 4: Register CORS whitelist supporting production FRONTEND_URL, ALLOWED_ORIGINS, and Vercel preview/prod domains
  const customOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const allowedOriginsSet = new Set([
    FRONTEND_URL,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    ...customOrigins,
  ]);

  await server.register(cors, {
    origin: (origin, cb) => {
      // Allow server-to-server requests, healthchecks, and webhooks with no Origin header
      if (!origin) return cb(null, true);
      const cleanOrigin = origin.replace(/\/+$/, '');
      if (
        allowedOriginsSet.has(cleanOrigin) ||
        cleanOrigin.endsWith('.vercel.app')
      ) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // STEP 5: Register rate limiting (100 requests per minute per IP)
  await server.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // ============================================================================
  // STAGE 2: CORE FUNCTIONALITY — Routes & Healthchecks
  // ============================================================================

  // Healthcheck endpoints
  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: isDbLive() ? 'connected' : 'dev_store',
    cache: 'in_memory (redis disabled)',
    redis: isRedisLive() ? 'connected' : 'disabled (concept_mode)',
  }));

  server.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: isDbLive() ? 'connected' : 'dev_store',
    cache: 'in_memory (redis disabled)',
    redis: isRedisLive() ? 'connected' : 'disabled (concept_mode)',
  }));

  // Register business domain routes
  await server.register(availabilityRoutes);
  await server.register(reserveRoutes);
  await server.register(webhookRoutes);
  await server.register(adminRoutes);
  await server.register(icalRoutes);
  await server.register(telegramRoutes);

  return server;
}

// ============================================================================
// STAGE 3: ENHANCEMENT / OPTIMIZATION — Server Boot & Graceful Teardown
// ============================================================================

async function start() {
  try {
    const app = await buildServer();

    // Probe PostgreSQL connection
    await verifyDatabaseConnection();

    // Start listening on configured host and port
    await app.listen({ port: PORT, host: HOST });
    console.log(`\n🚀 [Server] Fastify booking backend running at: http://localhost:${PORT}`);
    console.log(`📡 [Server] Healthcheck: http://localhost:${PORT}/health`);
    console.log(`📅 [Server] Availability: http://localhost:${PORT}/api/availability\n`);

    // STEP 6: Initialize background services (Cron cleanup, Notification worker, iCal sync, Morning Briefing, Telegram Polling)
    startExpiredHoldCleanupCron();
    startNotificationWorker();
    startIcalSyncCron();
    startDailyBriefingCron();
    startTelegramPolling();
  } catch (err: any) {
    console.error('❌ [Server] Fatal startup error:', err);
    process.exit(1);
  }
}

// Graceful shutdown handlers
const shutdown = async (signal: string) => {
  console.log(`\n🛑 [Server] Received ${signal}. Commencing graceful teardown...`);
  try {
    stopExpiredHoldCleanupCron();
    stopDailyBriefingCron();
    stopIcalSyncCron();
    await server.close();
    await pool.end();
    console.log('✅ [Server] Connections terminated cleanly.');
    process.exit(0);
  } catch (err) {
    console.error('❌ [Server] Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
