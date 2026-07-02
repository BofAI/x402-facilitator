/**
 * Dynamic per-key rate limiting. Ports the slowapi setup in legacy/src/auth.py
 * onto `hono-rate-limiter`:
 *   - Authenticated requests keyed by `auth:<api_key>` at the authenticated limit.
 *   - Anonymous requests keyed by `anon:<ip>` at the anonymous limit.
 *
 * Each tier is its own `rateLimiter` instance (own window + count + store), and a
 * thin outer middleware dispatches by auth status — so the two tiers may use
 * different periods, matching v1's per-limit parsing. Limit strings use the
 * `N/period` form (period ∈ second|minute|hour|day).
 *
 * Storage defaults to the library's in-memory `MemoryStore` (single process, with
 * automatic window eviction). Set `RATE_LIMIT_STORE=redis` (+ `RATE_LIMIT_REDIS_URL`)
 * to share counters across replicas via `RedisStore` (needs the optional `ioredis`
 * dependency); see README. Anonymous keying uses the socket peer IP only — matching
 * v1's slowapi `get_remote_address`. X-Forwarded-For is client-controlled and is
 * ignored unless `TRUST_PROXY_FOR_RATELIMIT=true` (set only behind a trusted proxy
 * that overwrites XFF), otherwise a caller could mint a fresh bucket per request.
 */
import { createRequire } from "node:module";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { MemoryStore, RedisStore, rateLimiter, type RateLimitInfo, type Store } from "hono-rate-limiter";
import { isAuthenticated, currentApiKey, type AuthVars } from "./auth.js";
import { logger } from "./logger.js";

type RLEnv = { Variables: AuthVars };
type Ctx = Context<RLEnv>;

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

// In-memory stores created for the active middlewares; tracked so tests can reset.
const memoryStores: MemoryStore<RLEnv>[] = [];

/** Test/maintenance helper: clear all in-memory rate-limit windows. */
export function resetRateLimitState(): void {
  for (const store of memoryStores) void store.resetAll();
}

/**
 * Resolve the anonymous-tier client IP. Socket peer only by default (v1 semantics);
 * X-Forwarded-For is honored only when the deployment opts in via env, since it is
 * otherwise attacker-controlled and would let a caller bypass the limit.
 */
function clientIp(c: Ctx): string {
  let ip = "unknown";
  try {
    ip = getConnInfo(c).remote.address ?? "unknown";
  } catch {
    /* connInfo unavailable (e.g. tests) */
  }
  if (process.env.TRUST_PROXY_FOR_RATELIMIT === "true") {
    // Take the RIGHTMOST X-Forwarded-For entry, not the leftmost. The rightmost is the
    // address our trusted direct proxy appended; the leftmost is client-controlled —
    // appending proxies (e.g. nginx `$proxy_add_x_forwarded_for`) preserve a spoofed
    // leftmost value, which an attacker could vary per request to mint a fresh bucket.
    // Rightmost is fail-safe: correct for a single overwrite/append proxy, and it only
    // over-groups (never under-protects) when multiple proxies are chained.
    const fwd = c.req.header("x-forwarded-for");
    if (fwd) {
      const parts = fwd.split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length > 0) ip = parts[parts.length - 1];
    }
  }
  return ip;
}

/**
 * Build a RedisStore from `ioredis`, adapting it to the 4-method client the library
 * expects. `ioredis` is an optional dependency, loaded only when Redis is selected.
 *
 * NOTE: the adapter below is coupled to hono-rate-limiter's internal RedisClient
 * contract (scriptLoad/evalsha/decr/del). hono-rate-limiter is pinned to an exact
 * version in package.json so this contract can't shift on install; re-verify this
 * mapping when bumping it.
 */
function makeRedisStore(prefix: string): Store<RLEnv> {
  const url = process.env.RATE_LIMIT_REDIS_URL ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error('RATE_LIMIT_STORE="redis" requires RATE_LIMIT_REDIS_URL (or REDIS_URL)');
  }
  const require = createRequire(import.meta.url);
  let IORedis: { default?: unknown } & Record<string, unknown>;
  try {
    IORedis = require("ioredis");
  } catch {
    throw new Error('RATE_LIMIT_STORE="redis" needs the optional "ioredis" dependency (npm i ioredis)');
  }
  const RedisCtor = (IORedis.default ?? IORedis) as new (url: string) => {
    on?(event: string, cb: (err: unknown) => void): void;
    script(cmd: string, arg: string): Promise<string>;
    evalsha(sha1: string, numkeys: number, ...rest: unknown[]): Promise<unknown>;
    decr(key: string): Promise<number>;
    del(key: string): Promise<number>;
  };
  const client = new RedisCtor(url);
  client.on?.("error", (err) => logger.error("rate-limit redis error", { err: String(err) }));
  return new RedisStore<RLEnv>({
    prefix,
    client: {
      scriptLoad: (script: string) => client.script("LOAD", script),
      evalsha: (sha1: string, keys: string[], args: unknown[]) =>
        client.evalsha(sha1, keys.length, ...keys, ...args) as Promise<never>,
      decr: (key: string) => client.decr(key),
      del: (key: string) => client.del(key),
    },
  });
}

/** Create the configured store for a tier (default in-memory, or shared Redis). */
function makeStore(prefix: string): Store<RLEnv> | undefined {
  const kind = (process.env.RATE_LIMIT_STORE ?? "memory").toLowerCase();
  if (kind === "memory") {
    const store = new MemoryStore<RLEnv>();
    memoryStores.push(store);
    return store;
  }
  if (kind === "redis") return makeRedisStore(prefix);
  throw new Error(`Unknown RATE_LIMIT_STORE "${kind}" (expected "memory" or "redis")`);
}

/** Build a single-tier limiter (own window/count/store/key). */
function buildTier(
  limitStr: string,
  tier: "auth" | "anon",
  keyGenerator: (c: Ctx) => string,
): MiddlewareHandler<{ Variables: AuthVars }> {
  const { count, windowSeconds } = parseLimit(limitStr);
  return rateLimiter<RLEnv>({
    windowMs: windowSeconds * 1000,
    limit: count,
    standardHeaders: false,
    keyGenerator,
    store: makeStore(`rl:${tier}:`),
    handler: (c) => {
      // requestPropertyName is left at its default ("rateLimit").
      const info = (c.get as (k: string) => RateLimitInfo | undefined)("rateLimit");
      const retryAfter = info?.resetTime
        ? Math.max(1, Math.ceil((info.resetTime.getTime() - Date.now()) / 1000))
        : windowSeconds;
      logger.warn("rate limit exceeded", { tier });
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limit_exceeded" }, 429);
    },
  });
}

export interface RateLimitOptions {
  authenticated: string;
  anonymous: string;
}

/**
 * Build a rate-limit middleware. Apply selectively (v1 limits only /settle).
 *
 * @param opts - Authenticated and anonymous limit strings.
 * @returns A hono middleware enforcing the dynamic, per-tier limit.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<{ Variables: AuthVars }> {
  const authLimiter = buildTier(opts.authenticated, "auth", (c) => `auth:${currentApiKey(c) ?? "unknown"}`);
  const anonLimiter = buildTier(opts.anonymous, "anon", (c) => `anon:${clientIp(c)}`);
  return (c, next) => (isAuthenticated(c) ? authLimiter : anonLimiter)(c, next);
}
