/**
 * API-key authentication. Faithful port of legacy/src/auth.py:
 *   - In-memory cache of active API keys, refreshed periodically from the DB.
 *   - Per-request middleware that sets auth state for rate limiting and seller lookup.
 *   - Constant-time key comparison to mitigate timing attacks.
 *
 * Auth is advisory (gates the rate-limit tier and seller scoping), not a hard
 * gate — matching v1, anonymous requests are allowed at the anonymous rate.
 */
import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getAllApiKeys } from "./db/index.js";
import { logger } from "./logger.js";

/** Hono context variables set by the auth middleware. */
export interface AuthVars {
  isAuthenticated: boolean;
  apiKey: string | null;
}

let apiKeyCache: Set<string> = new Set();
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

/** Refresh the API-key cache from the database (best-effort; logs on failure). */
export async function refreshApiKeysCache(): Promise<void> {
  try {
    const keys = await getAllApiKeys();
    apiKeyCache = new Set(keys);
    logger.info("API key cache refreshed", { count: apiKeyCache.size });
  } catch (err) {
    logger.error("Failed to refresh API key cache", { err: String(err) });
  }
}

/** Start the periodic refresher (returns immediately after the first load). */
export async function startApiKeyRefresher(intervalSeconds: number): Promise<void> {
  await refreshApiKeysCache();
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
}

/** Middleware that resolves auth state from the X-API-KEY header. */
export const authMiddleware: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  c.set("isAuthenticated", false);
  c.set("apiKey", null);

  const apiKey = c.req.header("X-API-KEY");
  if (apiKey && constantTimeKeyCheck(apiKey)) {
    c.set("isAuthenticated", true);
    c.set("apiKey", apiKey);
  }
  await next();
};

/** Whether the current request is authenticated. */
export const isAuthenticated = (c: Context<{ Variables: AuthVars }>): boolean =>
  c.get("isAuthenticated") === true;

/** The authenticated API key for the current request, or null. */
export const currentApiKey = (c: Context<{ Variables: AuthVars }>): string | null =>
  c.get("apiKey") ?? null;
