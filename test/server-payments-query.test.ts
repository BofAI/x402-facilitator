/**
 * P1-11 regression: /payments query-parameter branch table.
 *
 * Identity lookup requires BOTH ?network= and ?nonce=. Any partial identity
 * combo must return 400 and never degrade into the seller feed. The table below
 * covers full-identity, every partial combo, the seller feed, and the anonymous
 * no-params 400.
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
function fakeFacilitator() {
  return {
    verify: vi.fn(async () => ({ isValid: true })),
    settle: vi.fn(async () => ({ success: true, transaction: "0xtx" })),
    getSupported: vi.fn(() => ({})),
    register: vi.fn(),
    registerExtension: vi.fn(),
  };
}

// Track which db query ran so we can assert branch routing.
let authCalls = 0;
let sellerCalls = 0;
const AUTH_ROW = {
  network: "eip155:97",
  scheme: "exact",
  asset: "0xa",
  payer: "0xp",
  nonce: "0x1",
  amount: "1",
  txHash: "0xt",
  status: "success",
  errorReason: null,
  createdAt: "2026-01-01",
  sellerId: "AUTH",
};
const SELLER_ROW = {
  network: "eip155:56",
  scheme: "exact",
  asset: "0xb",
  payer: "0xp2",
  nonce: "0x2",
  amount: "2",
  txHash: "0xt2",
  status: "success",
  errorReason: null,
  createdAt: "2026-01-02",
  sellerId: "SELLER1",
};

vi.mock("../src/db/index.js", () => ({
  getSettlementsByAuthorization: vi.fn(async () => {
    authCalls++;
    return [AUTH_ROW];
  }),
  getSettlementsBySeller: vi.fn(async () => {
    sellerCalls++;
    return [SELLER_ROW];
  }),
  getSettlementsByTxHash: vi.fn(async () => []),
  getActiveApiKeyAuth: vi.fn(async () => [{ key: "k1", sellerId: "SELLER1" }]),
}));

describe("createApp /payments query branches (P1-11)", () => {
  beforeEach(async () => {
    resetRateLimitState();
    await refreshApiKeysCache();
    authCalls = 0;
    sellerCalls = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  function makeApp() {
    return createApp(fakeFacilitator() as unknown as Hono, buildDeps());
  }
  async function get(query: string, authed: boolean) {
    const app = makeApp();
    const headers: Record<string, string> = {};
    if (authed) headers["X-API-KEY"] = "k1";
    return app.request(`/payments${query}`, { method: "GET", headers });
  }

  it("full identity (?network=&nonce=) -> 200 identity query", async () => {
    const res = await get("?network=eip155:97&nonce=0x1", true);
    expect(res.status).toBe(200);
    expect(authCalls).toBe(1);
    expect(sellerCalls).toBe(0);
  });

  it("full identity works anonymously (seller-scoped via null sellerId)", async () => {
    const res = await get("?network=eip155:97&nonce=0x1", false);
    expect(res.status).toBe(200);
    expect(authCalls).toBe(1);
  });

  const partialCombos: Array<[string, string]> = [
    ["network only", "?network=eip155:97"],
    ["nonce only", "?nonce=0x1"],
    ["asset only", "?asset=0xa"],
    ["payer only", "?payer=0xp"],
    ["network+asset (missing nonce)", "?network=eip155:97&asset=0xa"],
    ["nonce+payer (missing network)", "?nonce=0x1&payer=0xp"],
  ];
  for (const [name, query] of partialCombos) {
    it(`partial identity (${name}) -> 400, never seller feed (authed)`, async () => {
      const res = await get(query, true);
      expect(res.status).toBe(400);
      expect(authCalls).toBe(0);
      expect(sellerCalls).toBe(0);
      expect(await res.json()).toMatchObject({
        code: "invalid_identity_query",
        message: "Identity lookup requires both ?network= and ?nonce=",
      });
    });

    it(`partial identity (${name}) -> 400 (anonymous)`, async () => {
      const res = await get(query, false);
      expect(res.status).toBe(400);
      expect(sellerCalls).toBe(0);
    });
  }

  it("no params + authed -> 200 seller feed", async () => {
    const res = await get("", true);
    expect(res.status).toBe(200);
    expect(sellerCalls).toBe(1);
    expect(authCalls).toBe(0);
  });

  it("no params + anonymous -> 400 (must authenticate or supply identity)", async () => {
    const res = await get("", false);
    expect(res.status).toBe(400);
    expect(sellerCalls).toBe(0);
  });
});
