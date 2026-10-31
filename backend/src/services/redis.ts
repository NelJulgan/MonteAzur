/**
 * ============================================================================
 * MONTE AZUR SERVICES — IN-MEMORY CACHE (src/services/redis.ts)
 * ============================================================================
 * DEVELOPMENT STAGE:
 * - STAGE 1: FOUNDATION CODE (In-Memory Key-Value Storage & TTL Store)
 * - STAGE 2: CORE FUNCTIONALITY (Availability Query Caching & Expiration Engine)
 * - STAGE 3: ENHANCEMENT / OPTIMIZATION (Atomic Cache Eviction & Concept Mode Toggle)
 *
 * WHY THIS CODE EXISTS:
 * Replaces external Redis network infrastructure with an in-process, high-speed
 * memory cache for concept and development mode. This eliminates external Redis
 * server dependencies while keeping the exact same cache API contract across the app.
 *
 * TRICKY LOGIC:
 * - Maintains backwards-compatible function signatures (`getAvailabilityCache`,
 *   `setAvailabilityCache`, `invalidateAvailabilityCache`, `isRedisLive`) so zero
 *   calling routes break.
 * - Simulates Redis TTL expiration automatically on get/set checks.
 *
 * TODO:
 * - If deploying to a multi-instance Kubernetes cluster in production, re-enable
 *   ioredis client via an environment flag `ENABLE_REDIS=true`.
 * ============================================================================
 */

import * as dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// STAGE 1: FOUNDATION CODE — In-Memory Store & State Structure
// ============================================================================

// STEP 1: Define cached entry schema with absolute expiration timestamp
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

// STEP 2: Dedicated in-process storage map (Redis disabled for concept mode)
const memoryCacheStore = new Map<string, CacheEntry<any>>();

console.log('⚡ [Cache Engine] In-memory cache initialized. Redis disabled for concept mode.');

// ============================================================================
// STAGE 2: CORE FUNCTIONALITY — Availability Read & Write Caching
// ============================================================================

// STEP 3: Retrieve cached dates for a property & month (avail:${propertyId}:${month})
export async function getAvailabilityCache(
  propertyId: string,
  month: string
): Promise<string[] | null> {
  const cacheKey = `avail:${propertyId}:${month}`;
  const entry = memoryCacheStore.get(cacheKey);

  if (!entry) {
    return null;
  }

  // Check TTL expiration
  if (Date.now() > entry.expiresAt) {
    memoryCacheStore.delete(cacheKey);
    return null;
  }

  return entry.data as string[];
}

// STEP 4: Store dates in memory with configurable TTL (default: 60 seconds)
export async function setAvailabilityCache(
  propertyId: string,
  month: string,
  dates: string[],
  ttlSeconds = 60
): Promise<void> {
  const cacheKey = `avail:${propertyId}:${month}`;

  memoryCacheStore.set(cacheKey, {
    data: dates,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

// ============================================================================
// STAGE 3: ENHANCEMENT / OPTIMIZATION — Atomic Cache Invalidation & Lifecycle
// ============================================================================

// STEP 5: Invalidate all cache keys matching propertyId on booking/hold mutations
export async function invalidateAvailabilityCache(propertyId: string): Promise<void> {
  let invalidatedCount = 0;

  for (const key of memoryCacheStore.keys()) {
    if (key.startsWith(`avail:${propertyId}:`) || key.startsWith(`availability:${propertyId}:`)) {
      memoryCacheStore.delete(key);
      invalidatedCount++;
    }
  }

  if (invalidatedCount > 0) {
    console.log(`🧹 [Cache] Invalidated ${invalidatedCount} in-memory cache key(s) for property ${propertyId}`);
  }
}

// STEP 6: Health status probe indicating whether Redis is active
export function isRedisLive(): boolean {
  // Permanently false in concept mode to inform health probes and callers
  return false;
}

// STEP 7: Legacy client proxy export for backwards compatibility
export const redis = {
  status: 'disabled',
  get: async (key: string) => {
    const entry = memoryCacheStore.get(key);
    return entry && entry.expiresAt > Date.now() ? JSON.stringify(entry.data) : null;
  },
  setex: async (key: string, ttl: number, value: string) => {
    memoryCacheStore.set(key, { data: JSON.parse(value), expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  },
  del: async (...keys: string[]) => {
    keys.forEach((k) => memoryCacheStore.delete(k));
    return keys.length;
  },
};
