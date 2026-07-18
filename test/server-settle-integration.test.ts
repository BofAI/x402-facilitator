/**
 * P2-04: /settle HTTP + repository integration.
 *
 * Covers the end-to-end settle path through createApp: the route parses the body,
 * calls the facilitator, persists the settlement, and returns the SDK result. The
 * v1 ordering invariant — DB save failure never affects the response — is asserted
 * against a failing saveSettlement mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createApp, type AppDeps } from "../src/server.js";
import { refreshApiKeysCache } from "../src/auth.js";
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

let saved: unknown = null;
let saveCallCount = 0;
let saveShouldFail = false;

vi.mock("../src/db/index.js", () => ({
  getSettlementsByAuthorization: vi.fn(async () => []),
  getSettlementsBySeller: vi.fn(async () => []),
  getSettlementsByTxHash: vi.fn(async () => []),
  getActiveApiKeyAuth: vi.fn(async () => [{ key: "k1", sellerId: "SELLER1" }]),
  saveSettlement: vi.fn(async (input: unknown) => {
    saveCallCount++;
    saved = input;
    if (saveShouldFail) throw new Error("DB write failed");
    return input;
  }),
}));

const V2_REQ = {
  scheme: "exact",
  network: "eip155:97",
  asset: "0xasset",
  amount: "1000",
  payTo: "0xpayee",
  maxTimeoutSeconds: 60,
  extra: {},
};
const V2_BODY = {
  paymentPayload: {
    x402Version: 2,
    payload: { authorization: { from: "0xpayer", nonce: "0xabc" } },
    accepted: V2_REQ,
  },
  paymentRequirements: V2_REQ,
};

describe("createApp /settle integration (P2-04)", () => {
  beforeEach(async () => {
    resetRateLimitState();
    await refreshApiKeysCache();
    saved = null;
    saveCallCount = 0;
    saveShouldFail = false;
  });
  afterEach(() => vi.restoreAllMocks());

  function makeApp(facilitator: unknown) {
    return createApp(facilitator as unknown as Hono, buildDeps());
  }

  it("persists the settlement row and returns the SDK result on success", async () => {
    const facilitator = {
      verify: vi.fn(),
      settle: vi.fn(async () => ({
        success: true,
        transaction: "0xtxhash",
        network: "eip155:97",
        payer: "0xpayer",
        amount: "1000",
      })),
      getSupported: vi.fn(() => ({})),
      register: vi.fn(),
      registerExtension: vi.fn(),
    };
    const app = makeApp(facilitator);
    const res = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": "k1" },
      body: JSON.stringify(V2_BODY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, transaction: "0xtxhash" });
    expect(saveCallCount).toBe(1);
    expect(saved).toMatchObject({
      sellerId: "SELLER1",
      network: "eip155:97",
      scheme: "exact",
      asset: "0xasset",
      payer: "0xpayer",
      nonce: "0xabc",
      amount: "1000",
      txHash: "0xtxhash",
      status: "success",
    });
  });

  it("returns the SDK result even when DB save fails (v1 ordering)", async () => {
    saveShouldFail = true;
    const facilitator = {
      verify: vi.fn(),
      settle: vi.fn(async () => ({
        success: true,
        transaction: "0xtxhash",
        network: "eip155:97",
      })),
      getSupported: vi.fn(() => ({})),
      register: vi.fn(),
      registerExtension: vi.fn(),
    };
    const app = makeApp(facilitator);
    const res = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": "k1" },
      body: JSON.stringify(V2_BODY),
    });

    // The settle itself succeeded; save failure must not turn a 200 into a 500.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, transaction: "0xtxhash" });
    expect(saveCallCount).toBe(1);
  });

  it("persists a failed-settlement row with errorReason when settle fails", async () => {
    const facilitator = {
      verify: vi.fn(),
      settle: vi.fn(async () => ({
        success: false,
        transaction: "",
        network: "eip155:97",
        errorReason: "insufficient_balance",
      })),
      getSupported: vi.fn(() => ({})),
      register: vi.fn(),
      registerExtension: vi.fn(),
    };
    const app = makeApp(facilitator);
    const res = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": "k1" },
      body: JSON.stringify(V2_BODY),
    });

    expect(res.status).toBe(200);
    expect(saved).toMatchObject({ status: "failed", errorReason: "insufficient_balance" });
  });
});
