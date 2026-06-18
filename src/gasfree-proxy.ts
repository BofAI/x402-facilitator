/**
 * Transparent proxy to the GasFree Open API. Byte-faithful port of
 * legacy/src/gasfree_open_proxy/ (mapping.py, signing.py, router.py):
 *
 *   /mainnet/...  ->  <upstream_mainnet>/tron/...   (HMAC signed)
 *   /nile/...     ->  <upstream_nile>/nile/...      (HMAC signed)
 *
 * The HMAC signature covers method + upstream path + timestamp (no query, no body).
 * Request headers are default-deny whitelisted; the client's Authorization is never
 * forwarded — the proxy injects its own ApiKey credentials server-side.
 */
import { createHmac } from "node:crypto";
import type { Hono } from "hono";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Settings (port of state.py / lifecycle.py)
// ---------------------------------------------------------------------------

export interface GasFreeProxySettings {
  nileCreds: { key: string; secret: string } | null;
  mainnetCreds: { key: string; secret: string } | null;
  upstreamNile: string;
  upstreamMainnet: string;
}

// ---------------------------------------------------------------------------
// HMAC signing (port of signing.py)
// ---------------------------------------------------------------------------

/** HMAC-SHA256(method + path + timestamp), Base64 digest. */
export function generateApiSignature(
  method: string,
  path: string,
  timestamp: number,
  apiSecret: string,
): string {
  const message = `${method.toUpperCase()}${path}${timestamp}`;
  return createHmac("sha256", apiSecret).update(message, "utf8").digest("base64");
}

/** GasFree HMAC auth headers only (Content-Type is not signed). */
export function buildAuthHeaders(
  method: string,
  path: string,
  apiKey: string,
  apiSecret: string,
  timestamp?: number,
): Record<string, string> {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const sig = generateApiSignature(method, path, ts, apiSecret);
  return {
    Timestamp: String(ts),
    Authorization: `ApiKey ${apiKey}:${sig}`,
  };
}

// ---------------------------------------------------------------------------
// Path mapping (port of mapping.py)
// ---------------------------------------------------------------------------

export type Profile = "mainnet" | "nile";

function collapsePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const out = "/" + parts.join("/");
  if (out === "/tron") return "/tron/";
  if (out === "/nile") return "/nile/";
  return out;
}

/**
 * Map a client path (/mainnet, /nile) to (upstreamBase, upstreamPath, profile),
 * or null if it is not under /mainnet or /nile. upstreamPath is used for both the
 * request URL and HMAC signing (no query).
 */
export function resolveUpstream(
  clientPath: string,
  upstreamMainnet: string,
  upstreamNile: string,
): { base: string; path: string; profile: Profile } | null {
  const raw = clientPath.startsWith("/") ? clientPath : `/${clientPath}`;
  const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;

  if (path === "/mainnet" || path.startsWith("/mainnet/")) {
    const rest = path.slice("/mainnet".length);
    const upstreamPath = !rest ? "/tron/" : collapsePath("/tron" + (rest.startsWith("/") ? rest : `/${rest}`));
    return { base: upstreamMainnet.replace(/\/+$/, ""), path: upstreamPath, profile: "mainnet" };
  }

  if (path === "/nile" || path.startsWith("/nile/")) {
    const rest = path.slice("/nile".length);
    const upstreamPath = !rest ? "/nile/" : collapsePath("/nile" + (rest.startsWith("/") ? rest : `/${rest}`));
    return { base: upstreamNile.replace(/\/+$/, ""), path: upstreamPath, profile: "nile" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Header policy (port of router.py)
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "x-request-id",
  "traceparent",
  "tracestate",
]);

const METHODS_TYPICALLY_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const RESPONSE_STRIP_NAMES = new Set([
  "transfer-encoding",
  "connection",
  "content-length",
  "content-encoding",
]);

/** Collect the whitelisted request headers the client may send upstream. */
function collectAllowedRequestHeaders(
  headers: Headers,
  method: string,
  hasBody: boolean,
): Record<string, string> {
  const forwardContentType = hasBody && METHODS_TYPICALLY_WITH_BODY.has(method.toUpperCase());
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === "host" || lk === "content-length") return;
    if (!ALLOWED_REQUEST_HEADERS.has(lk)) return;
    if (lk === "content-type" && !forwardContentType) return;
    out[key] = value;
  });
  return out;
}

/** Non-empty body must be application/json for GasFree; preserve client charset if already JSON. */
function ensureJsonContentType(pairs: Record<string, string>, hasBody: boolean): void {
  if (!hasBody) return;
  let clientCt: string | undefined;
  for (const [k, v] of Object.entries(pairs)) {
    if (k.toLowerCase() === "content-type") {
      clientCt = v;
      delete pairs[k];
    }
  }
  if (clientCt && clientCt.split(";")[0].trim().toLowerCase() === "application/json") {
    pairs["Content-Type"] = clientCt;
  } else {
    pairs["Content-Type"] = "application/json";
  }
}

/** Auth headers override same-named client headers (case-insensitive). */
function mergeRequestHeaders(
  allowed: Record<string, string>,
  auth: Record<string, string>,
): Record<string, string> {
  const authKeysLower = new Set(Object.keys(auth).map((k) => k.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(allowed)) {
    if (!authKeysLower.has(k.toLowerCase())) out[k] = v;
  }
  return { ...out, ...auth };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function proxyRequest(req: Request, path: string, settings: GasFreeProxySettings | null): Promise<Response> {
  if (settings === null) {
    return json(503, { detail: "gasfree_open_proxy not initialized" });
  }

  const resolved = resolveUpstream(path, settings.upstreamMainnet, settings.upstreamNile);
  if (resolved === null) {
    return json(404, {
      error: "unknown_prefix",
      message: "Use /mainnet/... or /nile/... (maps to official /tron/... and /nile/...)",
    });
  }

  const creds = resolved.profile === "mainnet" ? settings.mainnetCreds : settings.nileCreds;
  if (creds === null) {
    return json(503, {
      detail:
        "GasFree API credentials not configured for this environment (tron:mainnet or tron:nile)",
    });
  }

  const auth = buildAuthHeaders(req.method, resolved.path, creds.key, creds.secret);

  const reqUrl = new URL(req.url);
  let upstreamUrl = `${resolved.base}${resolved.path}`;
  if (reqUrl.search) upstreamUrl += reqUrl.search;

  const bodyBytes = METHODS_TYPICALLY_WITH_BODY.has(req.method.toUpperCase())
    ? new Uint8Array(await req.arrayBuffer())
    : new Uint8Array(0);
  const hasBody = bodyBytes.byteLength > 0;

  const allowed = collectAllowedRequestHeaders(req.headers, req.method, hasBody);
  const headers = mergeRequestHeaders(allowed, auth);
  ensureJsonContentType(headers, hasBody);

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: hasBody ? bodyBytes : undefined,
    });
  } catch (err) {
    logger.warn("GasFree open proxy upstream error", { err: String(err) });
    return json(502, { detail: "Bad gateway: upstream request failed" });
  }

  // undici decompresses gzip/br when the body is read; strip framing/encoding headers.
  const respBody = new Uint8Array(await upstreamResp.arrayBuffer());
  const outHeaders = new Headers();
  upstreamResp.headers.forEach((value, key) => {
    if (!RESPONSE_STRIP_NAMES.has(key.toLowerCase())) outHeaders.append(key, value);
  });

  const status = upstreamResp.status;
  const bodyless = status < 200 || status === 204 || status === 304;
  return new Response(bodyless ? null : respBody, { status, headers: outHeaders });
}

/**
 * Register the GasFree transparent-proxy routes on a hono app.
 *
 * @param app - The hono app.
 * @param getSettings - Returns current proxy settings (resolved at startup), or null if uninitialized.
 */
export function registerGasFreeProxy(app: Hono, getSettings: () => GasFreeProxySettings | null): void {
  const handler = (c: { req: { raw: Request; path: string } }) =>
    proxyRequest(c.req.raw, c.req.path, getSettings());
  for (const prefix of ["/mainnet", "/nile"]) {
    app.all(prefix, (c) => handler(c));
    app.all(`${prefix}/*`, (c) => handler(c));
  }
}
