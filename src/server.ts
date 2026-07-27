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
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { x402Facilitator } from "@bankofai/x402-core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@bankofai/x402-core/types";
import { PaymentPayloadV2Schema, PaymentRequirementsV2Schema } from "@bankofai/x402-core/schemas";
import { z } from "zod";
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
  /** Max request body size in bytes (default 1 MiB). */
  maxRequestBodyBytes: number;
  /** Optional canonical network -> lowercase token contract allowlist. */
  allowedAssets?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Top-level request body for /verify and /settle. The SDK's HTTPFacilitatorClient
 * sends `x402Version` at the top level alongside paymentPayload/paymentRequirements,
 * so it is an allowed (optional) field; everything else unknown is rejected by
 * `.strict()`. Inner payload/requirements use the SDK schemas (strip) so
 * protocol-legitimate requests stay accepted.
 */
const SettleBodySchema = z
  .object({
    // Protocol version the SDK mirrors from paymentPayload.x402Version; we don't
    // branch on it (the SDK schema below enforces the payload's own version),
    // but it must be accepted to match HTTPFacilitatorClient's wire format.
    x402Version: z.number().optional(),
    paymentPayload: z.unknown(),
    paymentRequirements: z.unknown(),
  })
  .strict();

/** Validate and narrow a request body into typed PaymentPayload/Requirements. */
function parseSettleBody(raw: unknown):
  | { success: true; paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements }
  | { success: false } {
  if (!SettleBodySchema.safeParse(raw).success) return { success: false };
  const obj = raw as { paymentPayload: unknown; paymentRequirements: unknown };
  const pp = PaymentPayloadV2Schema.safeParse(obj.paymentPayload);
  const pr = PaymentRequirementsV2Schema.safeParse(obj.paymentRequirements);
  if (!pp.success || !pr.success) return { success: false };
  return {
    success: true,
    // Schemas are runtime-verified to the V2 shape the facilitator accepts;
    // the cast bridges the SDK's slightly looser inferred types (optional extra).
    paymentPayload: pp.data as PaymentPayload,
    paymentRequirements: pr.data as PaymentRequirements,
  };
}

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
 * Unified non-protocol error envelope. Protocol responses (/verify, /settle) keep
 * the SDK contract (invalidReason / errorReason); all other errors use this shape
 * so clients get a stable `code` + `message` pair (P2-03).
 */
function errorResponse(c: Context, status: 400 | 404 | 413, code: string, message: string): Response {
  return c.json({ code, message }, status);
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
  app.use("*", bodyLimit({
    maxSize: deps.maxRequestBodyBytes,
    onError: (c: Context) => errorResponse(c, 413, "body_too_large", "Request body too large"),
  }));

  // Liveness probe.
  app.get("/health", (c) => c.json({ status: "ok" }));

  if (deps.metricsOnMainPort) {
    app.get(deps.metricsEndpoint, metricsHandler);
  }

  app.get("/supported", (c) => c.json(facilitator.getSupported()));

  app.post("/verify", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ isValid: false, invalidReason: "invalid_json" }, 400);
    }
    const parsed = parseSettleBody(raw);
    if (!parsed.success) {
      logger.warn("verify body rejected");
      return c.json({ isValid: false, invalidReason: "missing_parameters" }, 400);
    }
    if (!assetAllowed(parsed.paymentRequirements, deps.allowedAssets)) {
      return c.json({ isValid: false, invalidReason: "asset_not_allowed" }, 400);
    }
    try {
      const result = await facilitator.verify(parsed.paymentPayload, parsed.paymentRequirements);
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
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ success: false, errorReason: "invalid_json" }, 400);
    }
    const parsed = parseSettleBody(raw);
    if (!parsed.success) {
      logger.warn("settle body rejected");
      return c.json({ success: false, errorReason: "missing_parameters" }, 400);
    }
    const { paymentPayload, paymentRequirements } = parsed;
    if (!assetAllowed(paymentRequirements, deps.allowedAssets)) {
      return c.json({ success: false, errorReason: "asset_not_allowed" }, 400);
    }

    const requirements = paymentRequirements;
    const accepted = paymentPayload.accepted;
    const network = requirements.network ?? accepted?.network ?? "";
    const scheme = requirements.scheme ?? accepted?.scheme ?? "";
    const asset = requirements.asset ?? accepted?.asset ?? null;
    const payerNonce = extractPayerNonce(paymentPayload.payload);

    let result;
    try {
      result = await facilitator.settle(paymentPayload, paymentRequirements);
    } catch (err) {
      logger.error("settle error", { err: String(err), network, nonce: payerNonce?.nonce });
      return c.json({ success: false, errorReason: "internal_error" }, 500);
    }

    const txHash = result.transaction || null;
    if (!result.success) {
      logger.warn("settle failed", { network, nonce: payerNonce?.nonce, txHash, reason: result.errorReason });
    }
    try {
      const sellerId = sellerIdForApiKey(currentApiKey(c));
      await saveSettlement({
        sellerId,
        network,
        scheme,
        asset,
        payer: result.payer ?? payerNonce?.payer ?? null,
        nonce: payerNonce?.nonce ?? null,
        // Prefer the actually-settled amount (upto/batch); fall back to the
        // requirements amount (exact, where SettleResponse omits it).
        amount: result.amount ?? requirements.amount ?? null,
        txHash,
        status: result.success ? "success" : "failed",
        errorReason: result.errorReason ?? null,
      });
      logger.info("settlement saved", { sellerId, network, nonce: payerNonce?.nonce, txHash });
    } catch (err) {
      logger.error("failed to save settlement (settle result still returned)", {
        err: String(err),
        network,
        nonce: payerNonce?.nonce,
      });
    }

    return c.json(result);
  });

  // Lookup by settlement tx hash.
  app.get("/payments/tx/:hash", async (c) => {
    const sellerId = sellerIdForApiKey(currentApiKey(c));
    const rows = await getSettlementsByTxHash(c.req.param("hash"), sellerId);
    if (rows.length === 0) return errorResponse(c, 404, "not_found", "Settlement not found");
    return c.json(rows.map(toResponse));
  });

  // Lookup by authorization identity (?network=&nonce=[&asset=&payer=]), or — with no
  // such params — the authenticated seller's settlement feed (?limit=&offset=).
  app.get("/payments", async (c) => {
    const sellerId = sellerIdForApiKey(currentApiKey(c));
    const network = c.req.query("network");
    const nonce = c.req.query("nonce");
    const asset = c.req.query("asset");
    const payer = c.req.query("payer");

    if (network && nonce) {
      const rows = await getSettlementsByAuthorization({
        network,
        nonce,
        asset: asset ?? null,
        payer: payer ?? null,
        sellerId,
      });
      if (rows.length === 0) return errorResponse(c, 404, "not_found", "Settlement not found");
      return c.json(rows.map(toResponse));
    }

    // Partial identity params (any of network/nonce/asset/payer without the
    // required network+nonce pair) never degrade into the seller feed — return
    // 400 so the caller can correct the query rather than receive over-broad data.
    if (network || nonce || asset || payer) {
      return errorResponse(c, 400, "invalid_identity_query", "Identity lookup requires both ?network= and ?nonce=");
    }

    if (!sellerId) {
      return errorResponse(c, 400, "missing_identity_or_auth", "Provide ?network= and ?nonce=, or authenticate to list your settlements");
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

function assetAllowed(
  requirements: PaymentRequirements,
  allowlists: AppDeps["allowedAssets"],
): boolean {
  const allowed = allowlists?.[requirements.network];
  if (!allowed) return true;
  return allowed.includes(requirements.asset.toLowerCase());
}
