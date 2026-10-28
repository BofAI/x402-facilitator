/** Published SDK 2.1 mechanism + official Core + actual Facilitator HTTP surface.
 * Only database and chain I/O are replaced. Signatures are real TIP-712 signatures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { TronWeb, utils } from "tronweb";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { normalizeAddressForSigning, type ClientTronSigner, type FacilitatorTronSigner } from "@bankofai/x402-tron";
import { UptoTronScheme as UptoClient } from "@bankofai/x402-tron/upto/client";
import { UptoTronScheme } from "@bankofai/x402-tron/upto/facilitator";
import { BatchSettlementTronScheme } from "@bankofai/x402-tron/batch-settlement/facilitator";
import { createBatchSettlementPermit2DepositPayload, signVoucher } from "@bankofai/x402-tron/batch-settlement/client";
import { computeChannelId, type ChannelConfig } from "@bankofai/x402-tron/batch-settlement";
import { createApp, type AppDeps } from "../src/server.js";
import { refreshApiKeysCache } from "../src/auth.js";
import { resetRateLimitState } from "../src/rate-limit.js";
import { registerPermit2ReplayGuard } from "../src/permit2-replay.js";

const db = vi.hoisted(() => ({ saved: [] as Array<Record<string, unknown>>, locks: 0, unlocks: 0 }));
vi.mock("../src/db/index.js", () => ({
  getActiveApiKeyAuth: async () => [{ key: "sdk21-test-key", sellerId: "sdk21-seller" }],
  getSettlementsByAuthorization: async () => [],
  getSettlementsBySeller: async () => [],
  getSettlementsByTxHash: async () => [],
  saveSettlement: async (row: Record<string, unknown>) => { db.saved.push(row); return row; },
  getPermit2LockPool: () => ({ connect: async () => ({
    on: () => {}, off: () => {}, release: () => {},
    query: async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) { db.locks++; return { rows: [{ acquired: true }] }; }
      db.unlocks++;
      return { rows: [{ released: true }] };
    },
  }) }),
}));

const network = "tron:3448148188";
const asset = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const payerKey = "1".repeat(64); // Public test identities, never funded.
const receiverKey = "2".repeat(64);
const facilitatorKey = "3".repeat(64);
const addressFor = (key: string) => TronWeb.address.fromPrivateKey(key) as string;
const payer = addressFor(payerKey), receiver = addressFor(receiverKey), facilitatorAddress = addressFor(facilitatorKey);
const transaction = "ab".repeat(32);
const deps: AppDeps = { rateLimit: { authenticated: "1000/minute", anonymous: "1000/minute" },
  gasfreeSettings: () => null, metricsOnMainPort: false, metricsEndpoint: "/metrics", maxRequestBodyBytes: 1_000_000 };

function signing(key: string): ClientTronSigner["signTypedData"] {
  return async ({ domain, types, message }) => utils.typedData.signTypedData(
    domain, Object.fromEntries(Object.entries(types).map(([name, fields]) => [name, [...fields]])), message, key,
  ) as `0x${string}`;
}
const payerSigner: ClientTronSigner = { address: payer, network, signTypedData: signing(payerKey), ensureAllowance: async () => true };
const channel: ChannelConfig = { payer, payerAuthorizer: payer, receiver, receiverAuthorizer: receiver,
  token: asset, withdrawDelay: 900, salt: `0x${"12".repeat(32)}` };
const channelId = computeChannelId(channel, network);

function requirements(scheme: "upto" | "batch-settlement", timeout = 300): PaymentRequirements {
  return { scheme, network, asset, amount: "1000", payTo: receiver, maxTimeoutSeconds: timeout,
    extra: scheme === "upto"
      ? { assetTransferMethod: "permit2", permit2FacilitatorAddress: facilitatorAddress }
      : { assetTransferMethod: "permit2", receiverAuthorizer: receiver, withdrawDelay: 900 } };
}
function payment(payload: Record<string, unknown>, accepted = requirements("batch-settlement")): PaymentPayload {
  return { x402Version: 2, accepted, payload };
}

function fixture(scheme: "upto" | "batch-settlement") {
  const state = { balance: 10_000n, claimed: 0n, refundNonce: 0n, receiverClaimed: 4000n,
    receiverSettled: 0n, consumed: false, writeError: false, receipt: "success" as "success" | "reverted" | "pending" };
  const writes: Array<{ functionName: string; args: readonly unknown[] }> = [];
  const authorizations: Array<{ primaryType: string; signature: string }> = [];
  const hooks: string[] = [];
  const signer: FacilitatorTronSigner = {
    getAddresses: () => [facilitatorAddress],
    readContract: async ({ functionName }) => {
      switch (functionName) {
        case "allowance": case "balanceOf": return 1_000_000n;
        case "nonceBitmap": return state.consumed ? (1n << 256n) - 1n : 0n;
        case "channels": return [state.balance, state.claimed];
        case "pendingWithdrawals": return [0n, 0n];
        case "refundNonce": return state.refundNonce;
        case "receivers": return [state.receiverClaimed, state.receiverSettled];
        default: throw new Error(`Unexpected chain read ${functionName}`);
      }
    },
    verifyTypedData: async ({ address, domain, types, message, signature }) => {
      try {
        const recovered = utils.typedData.verifyTypedData(domain,
          Object.fromEntries(Object.entries(types).map(([name, fields]) => [name, [...fields]])), message, signature);
        return normalizeAddressForSigning(recovered) === normalizeAddressForSigning(address);
      } catch { return false; }
    },
    writeContract: async ({ functionName, args }) => {
      writes.push({ functionName, args });
      if (state.writeError) throw new Error("offline chain rejected transaction");
      if (functionName === "deposit") state.balance += BigInt(String(args[1]));
      if (scheme === "batch-settlement" && functionName === "settle") state.receiverSettled = state.receiverClaimed;
      if (functionName === "claimWithSignature") {
        expect(args[1]).toBe(authorizations.at(-1)?.signature);
        const claims = args[0] as Array<readonly [unknown, string, bigint]>;
        const totalClaimed = BigInt(String(claims[0][2]));
        state.receiverClaimed += totalClaimed - state.claimed;
        state.claimed = totalClaimed;
      }
      if (functionName === "refundWithSignature") expect(args[3]).toBe(authorizations.at(-1)?.signature);
      return transaction;
    },
    waitForTransactionReceipt: async () => ({ status: state.receipt }),
  };
  const authorizer = { address: receiver, signTypedData: async (args: Parameters<ClientTronSigner["signTypedData"]>[0]) => {
    const signature = await signing(receiverKey)(args);
    const recovered = utils.typedData.verifyTypedData(args.domain,
      Object.fromEntries(Object.entries(args.types).map(([name, fields]) => [name, [...fields]])), args.message, signature);
    expect(normalizeAddressForSigning(recovered)).toBe(normalizeAddressForSigning(receiver));
    authorizations.push({ primaryType: args.primaryType, signature });
    return signature;
  } };
  const core = new x402Facilitator().register(network,
    scheme === "upto" ? new UptoTronScheme(signer) : new BatchSettlementTronScheme(signer, authorizer));
  registerPermit2ReplayGuard(core, network, signer);
  core.onAfterVerify(async () => { hooks.push("verified"); });
  core.onVerifyFailure(async () => { hooks.push("verify-failed"); });
  core.onBeforeSettle(async () => { hooks.push("before-settle"); });
  core.onAfterSettle(async () => { hooks.push("settled"); });
  const app = createApp(core, deps);
  const post = (route: "/verify" | "/settle", value: PaymentPayload, req = value.accepted) => app.request(route, {
    method: "POST", headers: { "content-type": "application/json", "X-API-KEY": "sdk21-test-key" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: value, paymentRequirements: req }),
  });
  return { state, writes, hooks, authorizations, post, signer };
}
async function uptoPayment() {
  return new x402Client().register(network, new UptoClient(payerSigner))
    .createPaymentPayload({ x402Version: 2, accepts: [requirements("upto")], resource: { url: "https://test.invalid/upto" } });
}
async function batchDeposit() {
  const accepted = requirements("batch-settlement");
  const result = await createBatchSettlementPermit2DepositPayload(payerSigner, 2, accepted, channel, "5000", "1000");
  return { ...result, accepted };
}
async function batchVoucher(timeout = 300): Promise<PaymentPayload> {
  return payment({ type: "voucher", channelConfig: channel,
    voucher: await signVoucher(payerSigner, channelId, "1000", network) }, requirements("batch-settlement", timeout));
}
async function batchManagement(type: "claim" | "settle" | "refund"): Promise<PaymentPayload> {
  const voucher = await signVoucher(payerSigner, channelId, "1000", network);
  const payload = type === "claim"
    ? { type, claims: [{ voucher: { channel, maxClaimableAmount: "1000" }, signature: voucher.signature, totalClaimed: "1000" }] }
    : type === "settle" ? { type, receiver, token: asset }
    : { type, channelConfig: channel, voucher, claims: [], amount: "2000", refundNonce: "0" };
  // Match the published channel manager's management envelope exactly.
  return payment(payload, { ...requirements("batch-settlement", 0), amount: "0", extra: {} });
}

beforeEach(async () => {
  db.saved.length = 0; db.locks = 0; db.unlocks = 0;
  resetRateLimitState();
  await refreshApiKeysCache();
});

describe("published SDK 2.1 TRON upto through createApp HTTP", () => {
  it("verifies a real maximum authorization and persists only the actual settled amount", async () => {
    const test = fixture("upto"), payload = await uptoPayment();
    const verify = await test.post("/verify", payload);
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({ isValid: true });
    const response = await test.post("/settle", payload, { ...payload.accepted, amount: "370" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, amount: "370", transaction, network });
    expect(test.writes[0]).toMatchObject({ functionName: "settle" });
    expect(test.writes[0].args[1]).toBe(370n);
    expect(db.saved[0]).toMatchObject({ sellerId: "sdk21-seller", amount: "370", scheme: "upto", status: "success" });
    expect(test.hooks).toEqual(["verified", "before-settle", "settled"]);
    expect([db.locks, db.unlocks]).toEqual([1, 1]);
  });
  it("rejects a cryptographically invalid signature without broadcasting", async () => {
    const test = fixture("upto"), payload = await uptoPayment();
    const wrong = await uptoPayment();
    payload.payload.signature = wrong.payload.signature;
    const response = await test.post("/verify", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isValid: false, invalidReason: "invalid_permit2_signature" });
    expect(test.writes).toHaveLength(0);
  });
  it("rejects a settlement above the signed maximum", async () => {
    const test = fixture("upto"), payload = await uptoPayment();
    const response = await test.post("/settle", payload, { ...payload.accepted, amount: "1001" });
    expect(await response.json()).toMatchObject({ success: false, errorReason: "upto_settlement_exceeds_amount" });
    expect(test.writes).toHaveLength(0);
  });
  it("preserves the SDK zero-amount success without broadcasting", async () => {
    const test = fixture("upto"), payload = await uptoPayment();
    const response = await test.post("/settle", payload, { ...payload.accepted, amount: "0" });
    expect(await response.json()).toMatchObject({ success: true, amount: "0", transaction: "" });
    expect(test.writes).toHaveLength(0);
    expect(db.saved[0].amount).toBe("0");
  });
  it("runs the service nonce replay hook before mechanism settlement", async () => {
    const test = fixture("upto"), payload = await uptoPayment(); test.state.consumed = true;
    const response = await test.post("/settle", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: false, errorReason: "permit2_nonce_consumed" });
    expect(test.writes).toHaveLength(0);
    expect(db.saved).toHaveLength(0);
    expect([db.locks, db.unlocks]).toEqual([1, 1]);
  });
});

describe("published upto account RPC failures through createApp HTTP", () => {
  for (const read of ["allowance", "balanceOf"]) {
    it.each(["throw", "invalid"])(`rejects ${read} %s without a settlement write`, async mode => {
      const test = fixture("upto"), payload = await uptoPayment();
      const originalRead = test.signer.readContract;
      test.signer.readContract = async args => {
        if (args.functionName !== read) return originalRead(args);
        if (mode === "throw") throw new Error("RPC failed https://rpc.invalid/?key=private-marker");
        return undefined;
      };
      const verify = await test.post("/verify", payload);
      expect(verify.status).toBe(200);
      const verified = await verify.json();
      expect(verified).toMatchObject({ isValid: false, invalidReason: "chain_read_failed",
        invalidMessage: "TRON contract read failed" });
      expect(JSON.stringify(verified)).not.toContain("private-marker");
      for (const amount of ["370", "0"]) {
        const response = await test.post("/settle", payload, { ...payload.accepted, amount });
        expect(response.status).toBe(200);
        const settled = await response.json();
        expect(settled).toMatchObject({ success: false, errorReason: "chain_read_failed", transaction: "" });
        expect(JSON.stringify(settled)).not.toContain("private-marker");
      }
      expect(test.writes).toHaveLength(0);
      expect(db.saved).toHaveLength(2);
      expect(db.saved.every(row => row.status === "failed" && row.txHash === null)).toBe(true);
      expect([db.locks, db.unlocks]).toEqual([2, 2]);
    });
  }
});

describe("published SDK 2.1 TRON batch-settlement through createApp HTTP", () => {
  it("verifies two real deposit signatures and persists deposit amount and post-channel state", async () => {
    const test = fixture("batch-settlement"), payload = await batchDeposit();
    const verify = await test.post("/verify", payload);
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({ isValid: true, extra: { channelId } });
    const response = await test.post("/settle", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, amount: "5000", transaction,
      extra: { channelState: { channelId, balance: "15000", totalClaimed: "0" } } });
    expect(test.writes[0].functionName).toBe("deposit");
    expect(db.saved[0]).toMatchObject({ amount: "5000", payer, nonce: null, scheme: "batch-settlement" });
    expect([db.locks, db.unlocks]).toEqual([1, 1]);
    expect(test.hooks).toEqual(["verified", "before-settle", "settled"]);
  });
  it("verifies a signed voucher and returns channel state without a chain write", async () => {
    const test = fixture("batch-settlement"), payload = await batchVoucher();
    const response = await test.post("/verify", payload);
    expect(await response.json()).toMatchObject({ isValid: true, extra: { channelId, balance: "10000", totalClaimed: "0" } });
    expect(test.writes).toHaveLength(0);
  });
  it("rejects a voucher signature bound to another cumulative amount", async () => {
    const test = fixture("batch-settlement"), payload = await batchVoucher();
    const voucher = payload.payload.voucher as { maxClaimableAmount: string };
    voucher.maxClaimableAmount = "999";
    const response = await test.post("/verify", payload);
    expect(await response.json()).toMatchObject({ isValid: false, invalidReason: "invalid_batch_settlement_tron_voucher_signature" });
    expect(test.writes).toHaveLength(0);
  });
  it("accepts zero-timeout claim management and signs the real receiver authorization", async () => {
    const test = fixture("batch-settlement"), payload = await batchManagement("claim");
    const response = await test.post("/settle", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, transaction, network });
    expect(test.writes[0].functionName).toBe("claimWithSignature");
    expect(test.authorizations[0].primaryType).toBe("ClaimBatch");
    expect(test.hooks).toEqual(["before-settle", "settled"]);
  });
  it("accepts zero-timeout settle management and returns the actually transferred amount", async () => {
    const test = fixture("batch-settlement"), payload = await batchManagement("settle");
    const response = await test.post("/settle", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, amount: "4000", transaction });
    expect(test.writes[0].functionName).toBe("settle");
    expect(db.saved[0].amount).toBe("4000");
  });
  it("settles the zero-timeout SDK refund envelope and verifies it with authorizer metadata", async () => {
    const test = fixture("batch-settlement"), payload = await batchManagement("refund");
    const verify = await test.post("/verify", payload);
    expect(verify.status).toBe(200);
    // The manager sends extra: {}, while the SDK's refund verifier requires the
    // receiver-authorizer declaration. Its management path calls /settle directly.
    // The registry SDK2.0.0/Core1.1.1 combination has the same existing boundary.
    expect(await verify.json()).toMatchObject({ isValid: false,
      invalidReason: "invalid_batch_settlement_tron_receiver_authorizer_mismatch" });
    const declared = await test.post("/verify", payload, {
      ...payload.accepted, extra: requirements("batch-settlement").extra,
    });
    expect(await declared.json()).toMatchObject({ isValid: true });
    const response = await test.post("/settle", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, amount: "2000", payer, transaction,
      extra: { channelState: { balance: "8000", refundNonce: "1" } } });
    expect(test.writes[0].functionName).toBe("refundWithSignature");
    expect(test.authorizations[0].primaryType).toBe("Refund");
    expect(db.saved[0].amount).toBe("2000");
  });
  it.each(["deposit", "voucher"] as const)("rejects zero-timeout %s at the HTTP schema before Core", async type => {
    const test = fixture("batch-settlement"), payload = type === "deposit" ? await batchDeposit() : await batchVoucher();
    payload.accepted.maxTimeoutSeconds = 0;
    for (const route of ["/verify", "/settle"] as const) {
      const response = await test.post(route, payload);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject(route === "/verify" ? { invalidReason: "missing_parameters" } : { errorReason: "missing_parameters" });
    }
    expect(test.hooks).toHaveLength(0);
    expect(test.writes).toHaveLength(0);
  });
  it("maps chain claim rejection into a protocol failure and persists failed status", async () => {
    const test = fixture("batch-settlement"), payload = await batchManagement("claim"); test.state.writeError = true;
    const response = await test.post("/settle", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: false, transaction: "", errorReason: "invalid_batch_settlement_tron_claim_transaction_failed" });
    expect(db.saved[0]).toMatchObject({ status: "failed", errorReason: "invalid_batch_settlement_tron_claim_transaction_failed" });
  });
  it("returns nothing-to-settle without a chain write when claimed funds are already settled", async () => {
    const test = fixture("batch-settlement"), payload = await batchManagement("settle"); test.state.receiverSettled = test.state.receiverClaimed;
    const response = await test.post("/settle", payload);
    expect(await response.json()).toMatchObject({ success: false, errorReason: "invalid_batch_settlement_tron_nothing_to_settle" });
    expect(test.writes).toHaveLength(0);
  });
});

describe("published SDK 2.1 protocol failure boundaries", () => {
  it("keeps a pending upto transaction failed until its receipt confirms", async () => {
    const test = fixture("upto"), payload = await uptoPayment(); test.state.receipt = "pending";
    const response = await test.post("/settle", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: false, errorReason: "settlement_pending", transaction });
    expect(db.saved[0]).toMatchObject({ status: "failed", txHash: transaction, errorReason: "settlement_pending" });
    expect([db.locks, db.unlocks]).toEqual([1, 1]);
  });
  it("rejects an invalid Permit2 deposit signature in verify and settle without broadcasting", async () => {
    const test = fixture("batch-settlement"), payload = await batchDeposit();
    const deposit = payload.payload as { deposit: { authorization: { permit2Authorization: { signature: string } } }; voucher: { signature: string } };
    // A real Voucher signature cannot authorize a Permit2 deposit's different typed data.
    deposit.deposit.authorization.permit2Authorization.signature = deposit.voucher.signature;
    const verify = await test.post("/verify", payload);
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({ isValid: false, invalidReason: "invalid_batch_settlement_tron_permit2_invalid_signature" });
    const settle = await test.post("/settle", payload);
    expect(settle.status).toBe(200);
    expect(await settle.json()).toMatchObject({ success: false, errorReason: "invalid_batch_settlement_tron_permit2_invalid_signature" });
    expect(test.writes).toHaveLength(0);
  });
  it.each(["claim", "settle"] as const)("routes zero-timeout %s verify to the SDK rather than rejecting its HTTP envelope", async type => {
    const test = fixture("batch-settlement"), payload = await batchManagement(type);
    const response = await test.post("/verify", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isValid: false, invalidReason: "invalid_batch_settlement_tron_payload_type" });
    expect(test.hooks).toEqual(["verify-failed"]);
    expect(test.writes).toHaveLength(0);
  });
  it("rejects a claim whose receiver authorizer differs from the configured wallet", async () => {
    const test = fixture("batch-settlement"), payload = await batchManagement("claim");
    const claims = payload.payload.claims as Array<{ voucher: { channel: ChannelConfig } }>;
    claims[0].voucher.channel = { ...channel, receiverAuthorizer: payer };
    const response = await test.post("/settle", payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: false, errorReason: "invalid_batch_settlement_tron_authorizer_address_mismatch" });
    expect(test.authorizations).toHaveLength(0);
    expect(test.writes).toHaveLength(0);
  });
});

const sdk2Fixtures = JSON.parse(readFileSync(new URL("./fixtures/sdk2-schemes.json", import.meta.url), "utf8")) as {
  provenance: { sdk: string; core: string; signedAtMs: number };
  payloads: { upto: PaymentPayload; batchDeposit: PaymentPayload; batchVoucher: PaymentPayload };
};

describe("registry SDK2 signed HTTP wire consumed by official Core and published SDK 2.1", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(sdk2Fixtures.provenance.signedAtMs); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("verifies the serialized SDK2 upto maximum and settles its actual amount", async () => {
    const test = fixture("upto"), payload = structuredClone(sdk2Fixtures.payloads.upto);
    expect(payload.accepted).toEqual(requirements("upto"));
    const verify = await test.post("/verify", payload);
    expect(verify.status).toBe(200);
    expect(await verify.json()).toMatchObject({ isValid: true, payer: normalizeAddressForSigning(payer) });
    const settle = await test.post("/settle", payload, { ...payload.accepted, amount: "370" });
    expect(settle.status).toBe(200);
    expect(await settle.json()).toMatchObject({ success: true, transaction, network, amount: "370" });
    expect(test.writes[0].args[1]).toBe(370n);
    expect(db.saved[0]).toMatchObject({ scheme: "upto", amount: "370", status: "success", sellerId: "sdk21-seller" });
    expect(test.hooks).toEqual(["verified", "before-settle", "settled"]);
    expect([db.locks, db.unlocks]).toEqual([1, 1]);
  });

  it("consumes serialized SDK2 batch deposit and voucher through claim and receiver settlement", async () => {
    const test = fixture("batch-settlement");
    test.state.balance = 0n;
    test.state.receiverClaimed = 0n;
    const deposit = structuredClone(sdk2Fixtures.payloads.batchDeposit);
    const voucher = structuredClone(sdk2Fixtures.payloads.batchVoucher);
    expect(deposit.accepted).toEqual(requirements("batch-settlement"));
    expect(deposit.payload.channelConfig).toEqual(channel);
    expect(voucher.payload.channelConfig).toEqual(channel);
    const verifiedDeposit = await test.post("/verify", deposit);
    expect(verifiedDeposit.status).toBe(200);
    expect(await verifiedDeposit.json()).toMatchObject({ isValid: true, extra: { channelId, balance: "0" } });
    const deposited = await test.post("/settle", deposit);
    expect(deposited.status).toBe(200);
    expect(await deposited.json()).toMatchObject({ success: true, amount: "5000", transaction,
      extra: { channelState: { channelId, balance: "5000", totalClaimed: "0" } } });
    expect(db.saved[0]).toMatchObject({ scheme: "batch-settlement", amount: "5000", payer, nonce: null });
    const verifiedVoucher = await test.post("/verify", voucher);
    expect(verifiedVoucher.status).toBe(200);
    expect(await verifiedVoucher.json()).toMatchObject({ isValid: true,
      extra: { channelId, balance: "5000", totalClaimed: "0", refundNonce: "0" } });
    const oldVoucher = voucher.payload.voucher as { signature: string; maxClaimableAmount: string };
    const management = { ...requirements("batch-settlement", 0), amount: "0", extra: {} };
    const claim = payment({ type: "claim", claims: [{
      voucher: { channel, maxClaimableAmount: oldVoucher.maxClaimableAmount },
      signature: oldVoucher.signature, totalClaimed: "1000",
    }] }, management);
    const claimed = await test.post("/settle", claim);
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ success: true, transaction, network });
    const claimArgs = test.writes[1].args[0] as Array<readonly [unknown, string, bigint]>;
    expect(claimArgs[0][1]).toBe(oldVoucher.signature);
    const settled = await test.post("/settle", payment({ type: "settle", receiver, token: asset }, management));
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({ success: true, transaction, network, amount: "1000" });
    expect(db.saved.at(-1)).toMatchObject({ scheme: "batch-settlement", amount: "1000", status: "success" });
    expect(test.writes.map(write => write.functionName)).toEqual(["deposit", "claimWithSignature", "settle"]);
    expect([db.locks, db.unlocks]).toEqual([1, 1]);
  });
});
