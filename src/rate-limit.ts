/**
 * Dynamic per-key rate limiting. Port of the slowapi setup in legacy/src/auth.py:
 *   - Authenticated requests keyed by `auth:<api_key>` at the authenticated limit.
 *   - Anonymous requests keyed by `anon:<ip>` at the anonymous limit.
 *
 * Implemented as a fixed-window in-memory counter (single-process), matching the
 * v1 default slowapi storage. Limit strings use the `N/period` form
 * (period ∈ second|minute|hour|day).
 */
import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isAuthenticated, currentApiKey, type AuthVars } from "./auth.js";
import { logger } from "./logger.js";

const PERIOD_SECONDS: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
};

export interface ParsedLimit {
  count: number;
  windowSeconds: number;
}

/** Parse a `N/period` limit string (e.g. "1000/minute"). */
export function parseLimit(limit: string): ParsedLimit {
  const [countStr, periodRaw] = limit.split("/");
  const count = Number.parseInt(countStr.trim(), 10);
  const period = (periodRaw ?? "minute").trim().toLowerCase().replace(/s$/, "");
  const windowSeconds = PERIOD_SECONDS[period];
  if (!Number.isFinite(count) || count <= 0 || !windowSeconds) {
    throw new Error(`Invalid rate limit string: ${limit}`);
  }
  return { count, windowSeconds };
}

interface WindowState {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, WindowState>();

/** Test/maintenance helper: clear all rate-limit windows. */
export function resetRateLimitState(): void {
  buckets.clear();
}

/**
 * Consume one unit for `key` under `limit`. Returns whether the request is allowed
 * and seconds until the window resets.
 */
function consume(key: string, limit: ParsedLimit, now: number): { allowed: boolean; retryAfter: number } {
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowSeconds * 1000 });
    return { allowed: true, retryAfter: limit.windowSeconds };
  }
  const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  if (existing.count >= limit.count) {
    return { allowed: false, retryAfter };
  }
  existing.count += 1;
  return { allowed: true, retryAfter };
}

export interface RateLimitOptions {
  authenticated: string;
  anonymous: string;
}

/**
 * Build a rate-limit middleware. Apply selectively (v1 limits only /settle).
 *
 * @param opts - Authenticated and anonymous limit strings.
 * @returns A hono middleware enforcing the dynamic limit.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<{ Variables: AuthVars }> {
  const authLimit = parseLimit(opts.authenticated);
  const anonLimit = parseLimit(opts.anonymous);

  return async (c, next) => {
    const now = Date.now();
    let key: string;
    let limit: ParsedLimit;

    if (isAuthenticated(c)) {
      key = `auth:${currentApiKey(c) ?? "unknown"}`;
      limit = authLimit;
    } else {
      let ip = "unknown";
      try {
        ip = getConnInfo(c).remote.address ?? "unknown";
      } catch {
        /* connInfo unavailable (e.g. tests) */
      }
      const fwd = c.req.header("x-forwarded-for");
      if (fwd) ip = fwd.split(",")[0].trim();
      key = `anon:${ip}`;
      limit = anonLimit;
    }

    const { allowed, retryAfter } = consume(key, limit, now);
    if (!allowed) {
      logger.warn("rate limit exceeded", { key });
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limit_exceeded" }, 429);
    }
    await next();
  };
}
