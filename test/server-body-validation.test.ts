/**
 * P1-07 regression: JSON body runtime validation on /verify and /settle.
 *
 * Verifies that null / array / primitive / unknown-field / missing-field bodies
 * all resolve to a stable JSON 4xx (never a 500), while a legitimate body keeps
 * its 200 semantics. Uses the SDK's own PaymentPayloadSchema / PaymentRequirementsSchema
 * via SettleBodySchema in src/server.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createApp, type AppDeps } from "../src/server.js";
import { setApiKeyCacheForTest } from "../src/auth.js";
import { resetRateLimitState } from "../src/rate-limit.js";

function buildDeps(): AppDeps {
  return {
    rateLimit: { authenticated: "1000/minute", anonymous: "1000/minute" },
    gasfreeSettings: () => null,
    metricsOnMainPort: false,
    metricsEndpoint: "/metrics",
    maxRequestBodyBytes: 1024 * 1024,
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

// A schema-legitimate V2 PaymentRequirements + PaymentPayload body
// (V2 is the only shape facilitator.verify/settle accept).
const V2_REQUIREMENTS = {
  scheme: "exact",
  network: "eip155:97",
  asset: "0xasset",
  amount: "1",
  payTo: "0xpayee",
  maxTimeoutSeconds: 60,
  extra: {},
};
// Mirrors the SDK HTTPFacilitatorClient wire format: x402Version is sent at
// the top level (mirrored from paymentPayload.x402Version) in addition to the
// payload/requirements. SettleBodySchema must accept this shape.
const VALID_BODY = {
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    payload: { authorization: { from: "0xp", nonce: "0x1" } },
    accepted: V2_REQUIREMENTS,
  },
  paymentRequirements: V2_REQUIREMENTS,
};

function post(app: Hono, route: string, raw: string) {
  return app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

describe("createApp JSON body validation (P1-07)", () => {
  beforeEach(() => {
    resetRateLimitState();
    setApiKeyCacheForTest([]);
  });
  afterEach(() => vi.restoreAllMocks());

  function makeApp() {
    return createApp(fakeFacilitator() as unknown as Hono, buildDeps());
  }

  describe("POST /verify", () => {
    it("rejects null body with 400", async () => {
      const res = await post(makeApp(), "/verify", "null");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ isValid: false });
    });

    it("rejects array body with 400", async () => {
      const res = await post(makeApp(), "/verify", "[1,2,3]");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ isValid: false });
    });

    it("rejects number body with 400", async () => {
      const res = await post(makeApp(), "/verify", "42");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ isValid: false });
    });

    it("rejects string body with 400", async () => {
      const res = await post(makeApp(), "/verify", '"hello"');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ isValid: false });
    });

    it("rejects unknown top-level field with 400", async () => {
      const res = await post(makeApp(), "/verify", JSON.stringify({ ...VALID_BODY, extra: 1 }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ isValid: false });
    });

    it("rejects missing paymentRequirements with 400", async () => {
      const res = await post(makeApp(), "/verify", JSON.stringify({ paymentPayload: VALID_BODY.paymentPayload }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ isValid: false });
    });

    it("accepts a legitimate body with 200", async () => {
      const res = await post(makeApp(), "/verify", JSON.stringify(VALID_BODY));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ isValid: true });
    });

    // Regression: the SDK's HTTPFacilitatorClient sends x402Version at the TOP
    // LEVEL of the request body (mirrored from paymentPayload.x402Version). A
    // `.strict()` wrapper that didn't allow it rejected these legitimate
    // requests with missing_parameters. VALID_BODY already carries the field;
    // this test pins the exact SDK wire shape explicitly.
    it("accepts the SDK wire format (top-level x402Version) without 400", async () => {
      const sdkBody = {
        x402Version: 2,
        paymentPayload: {
          x402Version: 2,
          payload: { authorization: { from: "0xpayer", nonce: "0xabc" } },
          accepted: V2_REQUIREMENTS,
        },
        paymentRequirements: V2_REQUIREMENTS,
      };
      const res = await post(makeApp(), "/verify", JSON.stringify(sdkBody));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ isValid: true });
    });
  });

  describe("POST /settle", () => {
    it("rejects null body with 400", async () => {
      const res = await post(makeApp(), "/settle", "null");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ success: false });
    });

    it("rejects array body with 400", async () => {
      const res = await post(makeApp(), "/settle", "[1,2,3]");
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ success: false });
    });

    it("rejects unknown top-level field with 400", async () => {
      const res = await post(makeApp(), "/settle", JSON.stringify({ ...VALID_BODY, surprise: true }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ success: false });
    });

    it("rejects paymentPayload=null with 400", async () => {
      const res = await post(
        makeApp(),
        "/settle",
        JSON.stringify({ paymentPayload: null, paymentRequirements: VALID_BODY.paymentRequirements }),
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ success: false });
    });

    it("accepts a legitimate body with 200", async () => {
      const res = await post(makeApp(), "/settle", JSON.stringify(VALID_BODY));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ success: true });
    });
  });
});
