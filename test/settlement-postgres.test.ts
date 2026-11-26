import { randomBytes } from "node:crypto";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentRequirements, SettleResponse } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disposeDatabase, getDatabasePool, initDatabase } from "../src/db/index.js";
import { createApp } from "../src/server.js";

const url = process.env.SPONSORING_TEST_DATABASE_URL;
if (process.env.SPONSORING_REQUIRE_POSTGRES === "1" && !url) throw new Error("SPONSORING_TEST_DATABASE_URL required");
if (url) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/sponsoring_test") {
    throw new Error("Only the localhost sponsoring_test database is permitted");
  }
}

const requirements: PaymentRequirements = {
  network: "eip155:84532", scheme: "exact", amount: "1", maxTimeoutSeconds: 60,
  asset: "0x2222222222222222222222222222222222222222",
  payTo: "0x3333333333333333333333333333333333333333", extra: {},
};
const payer = "0x1111111111111111111111111111111111111111";
const fixtureHash = () => `0x${randomBytes(32).toString("hex")}`;

function settle(terms: PaymentRequirements, payload: Record<string, unknown>, result: SettleResponse) {
  const facilitator = new x402Facilitator().register(terms.network, {
    scheme: terms.scheme, caipFamily: "eip155", getSigners: () => [payer],
    verify: async () => ({ isValid: result.success }), settle: async () => result,
  });
  const app = createApp(facilitator, {
    rateLimit: { authenticated: "1000/minute", anonymous: "1000/minute" }, gasfreeSettings: () => null,
    metricsOnMainPort: false, metricsEndpoint: "/metrics", maxRequestBodyBytes: 1024 * 1024,
  });
  return app.request("/settle", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      paymentPayload: { x402Version: 2, accepted: terms, payload }, paymentRequirements: terms,
    }),
  });
}

describe.skipIf(!url)("PostgreSQL settlement records", () => {
  beforeAll(async () => {
    await initDatabase({ url: url!, poolSize: 1, maxOverflow: 0, maxLifeTime: 60, sslMode: "disable",
      apiKeyDatabase: { url: url!, sslMode: "disable" } });
  });
  afterAll(disposeDatabase);

  it("stores a rejected settlement with oversized addresses as NULL and preserves its nonce", async () => {
    const nonce = fixtureHash();
    const oversizedAddress = "x".repeat(129);
    const result = { success: false, network: requirements.network, transaction: "", errorReason: "invalid_payload" };
    const response = await settle({ ...requirements, asset: oversizedAddress }, {
      authorization: { from: oversizedAddress, nonce },
    }, result);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    const { rows } = await getDatabasePool().query(
      "SELECT asset, payer, nonce, tx_hash, status, error_reason FROM settlements WHERE nonce = $1", [nonce]);
    expect(rows).toEqual([{ asset: null, payer: null, nonce, tx_hash: null, status: "failed", error_reason: "invalid_payload" }]);
  });

  it("uses the batch channel payer when unrelated authorization fields are present", async () => {
    const terms = { ...requirements, scheme: "batch-settlement", amount: BigInt(fixtureHash()).toString() };
    const result = { success: false, network: terms.network, transaction: "", errorReason: "invalid_payload" };
    const response = await settle(terms, {
      type: "refund", channelConfig: { payer }, authorization: { from: "x".repeat(129), nonce: "x".repeat(81) },
    }, result);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    const { rows } = await getDatabasePool().query(
      "SELECT payer, nonce, status FROM settlements WHERE scheme = $1 AND amount = $2", [terms.scheme, terms.amount]);
    expect(rows).toEqual([{ payer, nonce: null, status: "failed" }]);
  });

  it("persists the full identity and transaction for a normal settlement", async () => {
    const nonce = fixtureHash();
    const transaction = fixtureHash();
    const result = { success: true, network: requirements.network, transaction };
    const response = await settle(requirements, { authorization: { from: payer, nonce } }, result);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    const { rows } = await getDatabasePool().query(
      "SELECT asset, payer, nonce, amount, status, error_reason FROM settlements WHERE tx_hash = $1", [transaction]);
    expect(rows).toEqual([{ asset: requirements.asset, payer, nonce, amount: "1", status: "success", error_reason: null }]);
  });
});
