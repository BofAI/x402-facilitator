/**
 * Body-limit integration test for createApp: verifies that oversized request
 * bodies are rejected with 413 before reaching the facilitator, and that a
 * normal-size body is accepted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createApp, type AppDeps } from "../src/server.js";
import { setApiKeyCacheForTest } from "../src/auth.js";
import { resetRateLimitState } from "../src/rate-limit.js";

const KB = 1024;

function buildDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    rateLimit: { authenticated: "1000/minute", anonymous: "1000/minute" },
    gasfreeSettings: () => null,
    metricsOnMainPort: false,
    metricsEndpoint: "/metrics",
    maxRequestBodyBytes: 8 * KB,
    ...overrides,
  };
}

// Minimal facilitator stub: verify/settle always succeed; getSupported returns {}.
function fakeFacilitator() {
  return {
    verify: vi.fn(async () => ({ isValid: true })),
    settle: vi.fn(async () => ({ success: true, transaction: "0xtx" })),
    getSupported: vi.fn(() => ({})),
    register: vi.fn(),
    registerExtension: vi.fn(),
  };
}

describe("createApp body limit", () => {
  beforeEach(() => {
    resetRateLimitState();
    setApiKeyCacheForTest([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeApp() {
    return createApp(fakeFacilitator() as unknown as Hono, buildDeps());
  }

  it("rejects an oversized POST /verify body with 413", async () => {
    const app = makeApp();
    const big = { padding: "x".repeat(16 * KB) };
    const res = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(big),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: "body_too_large", message: "Request body too large" });
  });

  it("accepts a normal-size POST /verify body", async () => {
    const app = makeApp();
    const req = {
      scheme: "exact",
      network: "eip155:97",
      asset: "0xasset",
      amount: "1",
      payTo: "0xpayee",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const body = {
      paymentPayload: { x402Version: 2, payload: { authorization: { from: "0xp", nonce: "0x1" } }, accepted: req },
      paymentRequirements: req,
    };
    const res = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  });

  it("does not reject GET requests (no body)", async () => {
    const app = makeApp();
    const res = await app.request("/supported", { method: "GET" });
    expect(res.status).toBe(200);
  });
});
