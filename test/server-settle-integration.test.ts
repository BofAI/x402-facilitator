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
let lockUnavailable = false;
let authorizationLocked = false;

vi.mock("../src/db/index.js", () => ({
  getPermit2LockPool: () => {
    if (lockUnavailable) throw new Error("DB unavailable");
    return { connect: async () => ({
      on: () => {},
      off: () => {},
      query: async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          const acquired = !authorizationLocked;
          if (acquired) authorizationLocked = true;
          return { rows: [{ acquired }] };
        }
        if (sql.includes("pg_advisory_unlock")) authorizationLocked = false;
        return { rows: [{ released: true }] };
      },
      release: () => {},
    }) };
  },
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
    lockUnavailable = false;
    authorizationLocked = false;
  });
  afterEach(() => vi.restoreAllMocks());

  function makeApp(facilitator: unknown) {
    return createApp(facilitator as unknown as Hono, buildDeps());
  }

  const permit2Body = () => ({ ...V2_BODY, paymentPayload: { ...V2_BODY.paymentPayload,
    payload: { permit2Authorization: { from: "0x1111111111111111111111111111111111111111", nonce: "1" } } } });
  const settleRequest = (app: ReturnType<typeof makeApp>) => app.request("/settle", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(permit2Body()),
  });

  it("rejects a concurrent Permit2 authorization before running a second settlement", async () => {
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let broadcasts = 0;
    const app = makeApp({ settle: async () => { broadcasts++; entered(); if (broadcasts === 1) await waiting;
      return { success: true, transaction: "tx", network: "eip155:97" }; } });
    const first = settleRequest(app);
    await started;
    const second = await settleRequest(app);
    release();
    await first;
    expect(second.status).toBe(503);
    expect(second.headers.get("Retry-After")).toBe("15");
    expect(await second.json()).toMatchObject({ success: false, errorReason: "permit2_authorization_busy" });
    expect(broadcasts).toBe(1);
  });

  it("fails closed before settlement when the Permit2 lock database is unavailable", async () => {
    lockUnavailable = true;
    let broadcasts = 0;
    const app = makeApp({ settle: async () => { broadcasts++; return { success: true }; } });
    const response = await settleRequest(app);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ errorReason: "permit2_storage_unavailable" });
    expect(broadcasts).toBe(0);
  });

  it("releases the Permit2 lock before saving, including a one-connection pool", async () => {
    const app = makeApp({ settle: async () => ({ success: true, transaction: "tx", network: "eip155:97" }) });
    const save = vi.mocked((await import("../src/db/index.js")).saveSettlement);
    save.mockImplementationOnce(async input => {
      expect(authorizationLocked).toBe(false);
      return input as never;
    });
    expect((await settleRequest(app)).status).toBe(200);
  });

  it.each([
    ["permit2_nonce_consumed", 200],
    ["permit2_invalid_authorization", 400],
    ["permit2_nonce_check_unavailable", 503],
    ["permit2_storage_unavailable", 503],
  ])("returns the protocol failure for SDK guard abort %s", async (reason, status) => {
    const app = makeApp({ settle: async () => { throw new Error(`Settlement aborted: ${reason}`); } });
    const response = await settleRequest(app);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ success: false, errorReason: reason, transaction: "" });
    expect(response.headers.get("Retry-After")).toBe(status === 503 ? "15" : null);
    expect(authorizationLocked).toBe(false);
    expect(saveCallCount).toBe(0);
  });

  it("rejects malformed Permit2 identity before entering the SDK", async () => {
    let broadcasts = 0;
    const app = makeApp({ settle: async () => { broadcasts++; return { success: true }; } });
    const body = permit2Body();
    body.paymentPayload.payload.permit2Authorization.nonce = "-1";
    const response = await app.request("/settle", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, errorReason: "permit2_invalid_authorization" });
    expect(broadcasts).toBe(0);
  });

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
