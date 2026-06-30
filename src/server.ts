/**
 * Hono HTTP surface for the facilitator. Mirrors v1 (legacy/src/main.py) minus
 * the removed /fee/quote, and with the payment-record query API redesigned around
 * the on-chain authorization identity (no client-supplied payment id):
 *   GET  /health                                  — liveness, no auth/rate-limit
 *   GET  /supported
 *   POST /verify
 *   POST /settle                                  — rate limited; persists a settlement
 *   GET  /payments/tx/{hash}                       — lookup by settlement tx hash
 *   GET  /payments?network=&nonce=[&asset=&payer=] — lookup by authorization identity
 *   GET  /payments                                 — seller settlement feed (authenticated)
 *   GET  /metrics                                  — when monitoring shares the main port
 *   ALL  /mainnet/* | /nile/*                       — GasFree transparent proxy (HMAC)
 *
 * Middleware: Prometheus (outermost) -> CORS -> API-key auth. /settle adds the
 * dynamic rate limiter. Lookups are seller-scoped when the request is authenticated.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { x402Facilitator } from "@bankofai/x402-core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@bankofai/x402-core/types";
import { authMiddleware, currentApiKey, sellerIdForApiKey, type AuthVars } from "./auth.js";
import { rateLimit } from "./rate-limit.js";
import { metricsMiddleware, metricsHandler } from "./metrics.js";
import { registerGasFreeProxy, type GasFreeProxySettings } from "./gasfree-proxy.js";
import { extractPayerNonce } from "./settlement.js";
import {
  getSettlementsByAuthorization,
  getSettlementsBySeller,
  getSettlementsByTxHash,
  saveSettlement,
  type Settlement,
} from "./db/index.js";
import { logger } from "./logger.js";

export interface AppDeps {
  /** Dynamic rate-limit tiers for /settle. */
  rateLimit: { authenticated: string; anonymous: string };
  /** Current GasFree proxy settings (resolved at startup), or null if disabled. */
  gasfreeSettings: () => GasFreeProxySettings | null;
  /** Expose /metrics on the main app (true when monitoring shares the server port). */
  metricsOnMainPort: boolean;
  /** Metrics path (default /metrics). */
  metricsEndpoint: string;
}

type SettleBody = { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };

const FEED_DEFAULT_LIMIT = 50;
const FEED_MAX_LIMIT = 200;

/** Public JSON shape for a settlement row. */
function toResponse(s: Settlement) {
  return {
    network: s.network,
    scheme: s.scheme,
    asset: s.asset,
    payer: s.payer,
    nonce: s.nonce,
    amount: s.amount,
    txHash: s.txHash,
    status: s.status,
    errorReason: s.errorReason,
    createdAt: s.createdAt,
  };
}

/**
 * Create the Hono app for a configured facilitator.
 *
 * @param facilitator - The configured x402Facilitator.
 * @param deps - HTTP-layer dependencies (rate limits, GasFree settings, metrics).
 * @returns A Hono app instance.
 */
export function createApp(facilitator: x402Facilitator, deps: AppDeps): Hono<{ Variables: AuthVars }> {
  const app = new Hono<{ Variables: AuthVars }>();

  app.use("*", metricsMiddleware);
  app.use("*", cors({ origin: "*", allowMethods: ["*"], allowHeaders: ["*"], credentials: false }));
  app.use("*", authMiddleware);

  // Liveness probe.
  app.get("/health", (c) => c.json({ status: "ok" }));

  if (deps.metricsOnMainPort) {
    app.get(deps.metricsEndpoint, metricsHandler);
  }

  app.get("/supported", (c) => c.json(facilitator.getSupported()));

  app.post("/verify", async (c) => {
    let body: SettleBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ isValid: false, invalidReason: "invalid_json" }, 400);
    }
    if (!body.paymentPayload || !body.paymentRequirements) {
      return c.json({ isValid: false, invalidReason: "missing_parameters" }, 400);
    }
    try {
      const result = await facilitator.verify(body.paymentPayload, body.paymentRequirements);
      if (!result.isValid) logger.warn("verify invalid", { reason: result.invalidReason });
      return c.json(result);
    } catch (err) {
      logger.error("verify error", { err: String(err) });
      return c.json({ isValid: false, invalidReason: "internal_error" }, 500);
    }
  });

  // /settle: rate limited; settles first, then persists one settlement row keyed on
  // the authorization identity. Save failure never affects the response (v1 ordering).
  app.post("/settle", rateLimit(deps.rateLimit), async (c) => {
    let body: SettleBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, errorReason: "invalid_json" }, 400);
    }
    if (!body.paymentPayload || !body.paymentRequirements) {
      return c.json({ success: false, errorReason: "missing_parameters" }, 400);
    }

    const req = body.paymentRequirements;
    const accepted = body.paymentPayload.accepted;
    const network = req.network ?? accepted?.network ?? "";
    const scheme = req.scheme ?? accepted?.scheme ?? "";
    const asset = req.asset ?? accepted?.asset ?? null;
    const ids = extractPayerNonce(body.paymentPayload.payload);

    let result;
    try {
      result = await facilitator.settle(body.paymentPayload, body.paymentRequirements);
    } catch (err) {
      logger.error("settle error", { err: String(err), network, nonce: ids?.nonce });
      return c.json({ success: false, errorReason: "internal_error" }, 500);
    }

    const txHash = result.transaction || null;
    if (!result.success) {
      logger.warn("settle failed", { network, nonce: ids?.nonce, txHash, reason: result.errorReason });
    }
    try {
      const sellerId = sellerIdForApiKey(currentApiKey(c));
      await saveSettlement({
        sellerId,
        network,
        scheme,
        asset,
        payer: result.payer ?? ids?.payer ?? null,
        nonce: ids?.nonce ?? null,
        // Prefer the actually-settled amount (upto/batch); fall back to the
        // requirements amount (exact, where SettleResponse omits it).
        amount: result.amount ?? req.amount ?? null,
        txHash,
        status: result.success ? "success" : "failed",
        errorReason: result.errorReason ?? null,
      });
      logger.info("settlement saved", { sellerId, network, nonce: ids?.nonce, txHash });
    } catch (err) {
      logger.error("failed to save settlement (settle result still returned)", {
        err: String(err),
        network,
        nonce: ids?.nonce,
      });
    }

    return c.json(result);
  });

  // Lookup by settlement tx hash.
  app.get("/payments/tx/:hash", async (c) => {
    const sellerId = sellerIdForApiKey(currentApiKey(c));
    const rows = await getSettlementsByTxHash(c.req.param("hash"), sellerId);
    if (rows.length === 0) return c.json({ detail: "Settlement not found" }, 404);
    return c.json(rows.map(toResponse));
  });

  // Lookup by authorization identity (?network=&nonce=[&asset=&payer=]), or — with no
  // such params — the authenticated seller's settlement feed (?limit=&offset=).
  app.get("/payments", async (c) => {
    const sellerId = sellerIdForApiKey(currentApiKey(c));
    const network = c.req.query("network");
    const nonce = c.req.query("nonce");

    if (network && nonce) {
      const rows = await getSettlementsByAuthorization({
        network,
        nonce,
        asset: c.req.query("asset") ?? null,
        payer: c.req.query("payer") ?? null,
        sellerId,
      });
      if (rows.length === 0) return c.json({ detail: "Settlement not found" }, 404);
      return c.json(rows.map(toResponse));
    }

    if (!sellerId) {
      return c.json(
        { detail: "Provide ?network= and ?nonce=, or authenticate to list your settlements" },
        400,
      );
    }
    const limit = Math.min(FEED_MAX_LIMIT, Math.max(1, Number(c.req.query("limit")) || FEED_DEFAULT_LIMIT));
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const rows = await getSettlementsBySeller(sellerId, limit, offset);
    return c.json(rows.map(toResponse));
  });

  // GasFree transparent proxy (/mainnet, /nile).
  registerGasFreeProxy(app as unknown as Hono, deps.gasfreeSettings);

  return app;
}
