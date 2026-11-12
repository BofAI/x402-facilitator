/**
 * API-key authentication:
 *   - In-memory cache of active API keys, refreshed periodically from the DB.
 *   - Per-request middleware that sets auth state for rate limiting and seller lookup.
 *   - Constant-time key comparison to mitigate timing attacks.
 *
 * Auth is advisory (gates the rate-limit tier and seller scoping), not a hard
 * gate — matching v1, anonymous requests are allowed at the anonymous rate.
 */
import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getActiveApiKeyAuth } from "./db/index.js";
import { logger } from "./logger.js";

/** Hono context variables set by the auth middleware. */
export interface AuthVars {
  isAuthenticated: boolean;
  apiKey: string | null;
  sellerId: string | null;
  apiKeyCacheUnavailable: boolean;
}

let apiKeyCache: Set<string> = new Set();
let sellerByKey: Map<string, string> = new Map();
let lastRefreshAt = 0;
let maxCacheAgeMs = Infinity;
let refreshInFlight: Promise<boolean> | null = null;
let refresherTimer: ReturnType<typeof setInterval> | null = null;

/** Constant-time membership check against the cache (mirrors v1 _constant_time_key_check). */
function constantTimeKeyCheck(apiKey: string): boolean {
  const candidate = Buffer.from(apiKey);
  let found = false;
  for (const cached of apiKeyCache) {
    const cachedBuf = Buffer.from(cached);
    if (cachedBuf.length === candidate.length && timingSafeEqual(cachedBuf, candidate)) {
      found = true;
    }
  }
  return found;
}

async function loadApiKeys(): Promise<boolean> {
  try {
    const rows = await getActiveApiKeyAuth();
    apiKeyCache = new Set(rows.map((r) => r.key));
    sellerByKey = new Map(rows.map((r) => [r.key, r.sellerId]));
    lastRefreshAt = performance.now();
    logger.info("API key cache refreshed", { count: apiKeyCache.size });
    return true;
  } catch (err) {
    // Drizzle wraps pg errors. Keep diagnostic codes without exposing connection details.
    const cause = err instanceof Error && err.cause ? err.cause : err;
    const code = cause instanceof Error && "code" in cause && typeof cause.code === "string"
      && /^[A-Z0-9_]{1,32}$/.test(cause.code) ? cause.code : undefined;
    logger.error("Failed to refresh API key cache", { code });
    return false;
  }
}

/** Coalesce concurrent refreshes so a delayed read cannot overwrite newer keys. */
export function refreshApiKeysCache(): Promise<boolean> {
  refreshInFlight ??= loadApiKeys().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

/** Load the initial DevCenter snapshot before serving, then refresh periodically. */
export async function startApiKeyRefresher(intervalSeconds: number): Promise<void> {
  if (!(await refreshApiKeysCache())) {
    throw new Error("Unable to load API keys from the configured DevCenter database");
  }
  maxCacheAgeMs = intervalSeconds * 3 * 1000;
  refresherTimer = setInterval(() => {
    void refreshApiKeysCache();
  }, intervalSeconds * 1000);
  // Don't keep the event loop alive solely for the refresher.
  refresherTimer.unref?.();
}

/** Stop the periodic refresher (used on shutdown / in tests). */
export function stopApiKeyRefresher(): void {
  if (refresherTimer) {
    clearInterval(refresherTimer);
    refresherTimer = null;
  }
}

/** Test/seed helper: replace the cache contents directly. */
export function setApiKeyCacheForTest(keys: Iterable<string>): void {
  apiKeyCache = new Set(keys);
  sellerByKey = new Map();
}

/** Capture both auth and seller scope from the same cache snapshot for the request. */
export const authMiddleware: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  const apiKey = c.req.header("X-API-KEY");
  const unavailable = Boolean(apiKey) && performance.now() - lastRefreshAt >= maxCacheAgeMs;
  const authenticatedKey = apiKey && !unavailable && constantTimeKeyCheck(apiKey) ? apiKey : null;

  c.set("apiKeyCacheUnavailable", unavailable);
  c.set("isAuthenticated", authenticatedKey !== null);
  c.set("apiKey", authenticatedKey);
  c.set("sellerId", authenticatedKey ? sellerByKey.get(authenticatedKey) ?? null : null);
  await next();
};

/** Whether the current request is authenticated. */
export const isAuthenticated = (c: Context<{ Variables: AuthVars }>): boolean =>
  c.get("isAuthenticated") === true;

/** The authenticated API key for the current request, or null. */
export const currentApiKey = (c: Context<{ Variables: AuthVars }>): string | null =>
  c.get("apiKey") ?? null;
