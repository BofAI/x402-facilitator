import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import { providers, TronWeb, utils } from "tronweb";
import type { FacilitatorTronSigner, Trc20ApprovalResourceSponsoringRequest,
  Trc20SponsoringOperation } from "@bankofai/x402-tron";
import { serializeSignedTronTransaction } from "@bankofai/x402-tron";
import { sponsoringConfigSchema } from "../src/sponsoring/config.js";
import { createSponsoringService } from "../src/sponsoring/service.js";
import { SqliteSponsoringCoordinator } from "../src/sponsoring/store.js";
import { recoveryErrors } from "../src/sponsoring/metrics.js";
import { SponsoringStorageError } from "../src/sponsoring/recovery-errors.js";

const signerCallbacks = vi.hoisted(() => ({
  rememberExpiration: undefined as undefined | ((txID: string, expiration: number) => Promise<void>),
  assertOwnership: undefined as undefined | (() => Promise<void>),
}));
vi.mock("../src/sponsoring/signer.js", () => ({ buildResourceOwnerSigner: async (_config: unknown, _tron: unknown,
  _settlement: unknown, rememberExpiration: (txID: string, expiration: number) => Promise<void>, assertOwnership: () => Promise<void>) => {
  signerCallbacks.rememberExpiration = rememberExpiration;
  signerCallbacks.assertOwnership = assertOwnership;
  return { getAddress: async () => "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8",
    signResourceTransaction: async () => { throw new Error("unexpected signing"); } };
} }));

function testConfig() {
  return sponsoringConfigSchema.parse({ network: "tron:3448148188", database: join(mkdtempSync(join(tmpdir(), "sponsor-service-")), "local.sqlite"),
    owner: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8", wallet_id: "owner-active", permission_id: 2,
    assets: ["TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"], pay_to: ["TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"],
    energy_stake_sun: "1000000000", bandwidth_stake_sun: "1000000000", budget_sun: "100000000", management_bandwidth: "10000" });
}
const settlement = { getAddresses: () => ["TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"], readContract: async () => 0n } as unknown as FacilitatorTronSigner;

async function recoveryErrorCount(network: string): Promise<number> {
  return (await recoveryErrors.get()).values.find(value => value.labels.network === network)?.value ?? 0;
}

function preparedReclaim() {
  const transaction = { raw_data: { ref_block_bytes: "0064", ref_block_hash: "11".repeat(8), timestamp: 14000, expiration: 74000,
    contract: [{ type: "UnDelegateResourceContract", Permission_id: 2, parameter: {
      type_url: "type.googleapis.com/protocol.UnDelegateResourceContract",
      value: { owner_address: `41${"11".repeat(20)}`, receiver_address: `41${"22".repeat(20)}`,
        balance: 1000000, resource: "ENERGY" },
    } }] }, signature: ["11".repeat(65)] };
  const protobuf = utils.transaction.txJsonToPb(transaction);
  const txID = utils.transaction.txPbToTxID(protobuf).replace(/^0x/, "");
  return { txID, signedTransaction: serializeSignedTronTransaction({ ...transaction, txID,
    raw_data_hex: utils.transaction.txPbToRawDataHex(protobuf) }) };
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function requestDigest(request: Trc20ApprovalResourceSponsoringRequest): string {
  const { requiredAllowance, ...legacy } = request;
  const bound = requiredAllowance === request.paymentRequirements.amount ? legacy : request;
  return createHash("sha256").update(canonicalJson(bound)).digest("hex");
}

describe("sponsoring service lifecycle", () => {
  it.each(["rememberExpiration", "assertOwnership"] as const)("tags signer %s storage failures at their origin", async method => {
    const failure = new Error(`${method} unavailable`);
    const storage = vi.spyOn(SqliteSponsoringCoordinator.prototype, method).mockImplementation(() => { throw failure; });
    const service = await createSponsoringService(testConfig(), settlement);
    try {
      const call = method === "rememberExpiration"
        ? signerCallbacks.rememberExpiration!("tx", 1000)
        : signerCallbacks.assertOwnership!();
      await expect(call).rejects.toBeInstanceOf(SponsoringStorageError);
      await expect(call).rejects.toThrow(failure.message);
    } finally { await service.close(); storage.mockRestore(); }
  });

  it("drains an active SQLite sponsor before releasing its store on shutdown", async () => {
    const config = testConfig();
    const rpc = vi.spyOn(providers.HttpProvider.prototype, "request").mockImplementation(async path => {
      if (path === "walletsolidity/getdelegatedresourceaccountindexv2") return {};
      throw new Error("inventory read unavailable");
    });
    const service = await createSponsoringService(config, settlement);
    service.start();
    await vi.waitFor(() => expect(service.readiness().ready).toBe(true));
    let release!: () => void;
    const original = SqliteSponsoringCoordinator.prototype.get;
    const read = vi.spyOn(SqliteSponsoringCoordinator.prototype, "get").mockImplementationOnce(async function(key) {
      await new Promise<void>(resolve => { release = resolve; });
      return original.call(this, key);
    });
    const sponsor = service.runtime.sponsor({ network: config.network, approvalTxID: "a".repeat(64), payer: settlement.getAddresses()[0],
      approvalTimestamp: String(Date.now()), approvalExpiration: String(Date.now() + 600000),
      paymentRequirements: { payTo: config.pay_to[0] } } as never);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    let closed = false;
    const closing = service.close().then(() => { closed = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(closed).toBe(false);
      expect(service.access().ready).toBe(false);
    } finally {
      release(); await sponsor; await closing; read.mockRestore(); rpc.mockRestore();
    }
  });
  it.each([[600113, "sponsor_recovery_in_progress"], [630001, "sponsor_approval_lifetime_exceeded"]])(
    "checks SDK-generated Approval lifetime %i without rejecting normal RPC construction latency", async (lifetime, reason) => {
      const config = testConfig();
      const service = await createSponsoringService(config, settlement);
      try {
        const result = await service.runtime.verify({ network: config.network, approvalTimestamp: String(Date.now()),
          approvalExpiration: String(Date.now() + Number(lifetime)), paymentRequirements: { payTo: config.pay_to[0] } } as never);
        expect(result).toMatchObject({ isValid: false, invalidReason: reason });
      } finally { await service.close(); }
    },
  );

  it("accepts an unchanged already-approved retry near expiry but rejects changed binding", async () => {
    const config = testConfig();
    const now = Date.now();
    const payer = settlement.getAddresses()[0];
    const asset = config.assets[0];
    const requirements = { scheme: "exact", network: config.network, asset, amount: "1000",
      payTo: config.pay_to[0], maxTimeoutSeconds: 600 };
    const request: Trc20ApprovalResourceSponsoringRequest = { network: config.network, approvalTxID: "a".repeat(64), payer, asset,
      spender: config.owner, amount: String((1n << 256n) - 1n), requiredAllowance: "1000",
      approvalTimestamp: String(now), approvalExpiration: String(now + 280000),
      approvalFeeLimitSun: "100000000", approvalRefBlockBytes: "0064",
      approvalRefBlockHash: "11".repeat(8), signedTransaction: "aa",
      paymentRequirements: requirements,
      paymentPayload: { x402Version: 2, accepted: requirements, payload: {} } } as Trc20ApprovalResourceSponsoringRequest;
    const store = new SqliteSponsoringCoordinator(config.database,
      { network: config.network, owner: config.owner, permissionId: config.permission_id },
      { energy: 1000000000n, bandwidth: 1000000000n, budget: 100000000n, management: 10000n });
    await store.admit({ key: `${config.network}:${request.approvalTxID}`, network: config.network,
      approvalTxID: request.approvalTxID, payer, requestDigest: requestDigest(request), request,
      plan: { energyRequired: 0n, bandwidthRequired: 0n, managementBandwidthRequired: 0n,
        replacementCost: 0n, legs: [] }, budgetUnits: 0n, status: "sponsored_recovering",
      actions: [], revision: 0, createdAtMs: now, recoveryStartedAtMs: now } as never);
    store.close();
    const rpcPaths: string[] = [];
    const rpc = vi.spyOn(providers.HttpProvider.prototype, "request").mockImplementation(async (path, params) => {
      rpcPaths.push(path);
      if (path === "walletsolidity/getdelegatedresourceaccountindexv2") return {};
      if (path === "wallet/getaccount" || path === "walletsolidity/getaccount") {
        const address = (params as { address: string }).address;
        return { address, type: address.toLowerCase() === TronWeb.address.toHex(asset).toLowerCase() ? "Contract" : 0 };
      }
      if (path === "wallet/getnowblock") return { block_header: { raw_data: { number: 100 } } };
      if (path === "wallet/getblockbynum") return { blockID: `${"0".repeat(16)}${"11".repeat(8)}${"0".repeat(32)}` };
      throw new Error(`Unexpected RPC: ${path}`);
    });
    const service = await createSponsoringService(config, { ...settlement,
      readContract: async () => 1000000000n } as FacilitatorTronSigner);
    try {
      service.start();
      await vi.waitFor(() => expect(service.readiness().ready).toBe(true));

      const verified = await service.runtime.verify(request);
      const sponsored = await service.runtime.sponsor(request);
      const changed = { ...request, signedTransaction: "bb" };
      const changedVerification = await service.runtime.verify(changed);
      const changedSponsorship = await service.runtime.sponsor(changed);

      expect(verified).toEqual({ isValid: true });
      expect(sponsored).toMatchObject({ success: true, approvalTransaction: request.approvalTxID });
      expect(changedVerification).toMatchObject({ isValid: false, invalidReason: "approval_transaction_reused" });
      expect(changedSponsorship).toMatchObject({ success: false, errorReason: "approval_transaction_reused" });
      expect(rpcPaths).not.toEqual(expect.arrayContaining([
        "wallet/delegateresource", "wallet/undelegateresource", "wallet/broadcasttransaction",
        "wallet/broadcasthex",
      ]));
    } finally { await service.close(); rpc.mockRestore(); }
  });

  it("rotates a failing recovery record so the next local payer is not starved", async () => {
    vi.useFakeTimers();
    const config = testConfig();
    const store = new SqliteSponsoringCoordinator(config.database,
      { network: config.network, owner: config.owner, permissionId: config.permission_id },
      { energy: 1000000000n, bandwidth: 1000000000n, budget: 100000000n, management: 10000n });
    const payers = [settlement.getAddresses()[0], config.owner];
    for (const [index, payer] of payers.entries()) {
      await store.admit({ key: `operation-${index}`, network: config.network, payer, approvalTxID: `approval-${index}`,
        requestDigest: `digest-${index}`, revision: 0, createdAtMs: Date.now() - 600000 + index,
        status: "failed_recovering", budgetUnits: 1n, request: { payer }, actions: [],
        plan: { legs: [{ resource: "ENERGY", stakeSun: 1000000n }], managementBandwidthRequired: 600n },
      } as Trc20SponsoringOperation);
    }
    store.close();
    const queried: string[] = [];
    const rpc = vi.spyOn(providers.HttpProvider.prototype, "request").mockImplementation(async (path, params) => {
      if (path === "walletsolidity/getdelegatedresourcev2") {
        queried.push((params as { toAddress: string }).toAddress);
        throw new Error("receiver lookup unavailable");
      }
      throw new Error(`Unexpected RPC: ${path}`);
    });
    const service = await createSponsoringService(config, settlement);
    try {
      service.start();
      await vi.waitFor(() => expect(service.readiness().mode).toBe("DEGRADED"));
      await vi.advanceTimersByTimeAsync(15000);
      expect(new Set(queried).size).toBe(2);
      expect(service.access().ready).toBe(false);
    } finally { await service.close(); rpc.mockRestore(); vi.useRealTimers(); }
  });

  it("reconciles healthy recovered debt after another receiver's RPC failure", async () => {
    vi.useFakeTimers();
    const config = testConfig();
    const now = Date.now();
    const store = new SqliteSponsoringCoordinator(config.database,
      { network: config.network, owner: config.owner, permissionId: config.permission_id },
      { energy: 1000000000n, bandwidth: 1000000000n, budget: 100000000n, management: 10000n });
    function recoveredDebt(key: string, payer: string): Trc20SponsoringOperation {
      return { key, network: config.network, payer, approvalTxID: `${key}-approval`, requestDigest: key,
        revision: 0, createdAtMs: now - 26 * 3600000, recoveryStartedAtMs: now - 25 * 3600000,
        status: "sponsored_recovering", budgetUnits: 1n,
        request: { network: config.network, payer, requiredAllowance: "1", paymentRequirements: { amount: "1" } },
        plan: { legs: [{ resource: "ENERGY", stakeSun: 1000000n, delegatedUnits: 100n, requiredUnits: 100n }],
          energyRequired: 100n, bandwidthRequired: 0n, managementBandwidthRequired: 600n, replacementCost: 1n },
        actions: [
          { kind: "approval", txID: `${key}-approval`, signedTransaction: "aa", status: "confirmed" },
          { kind: "delegate", resource: "ENERGY", txID: `${key}-delegate`, signedTransaction: "bb", status: "confirmed" },
          { kind: "undelegate", resource: "ENERGY", txID: `${key}-reclaim`, signedTransaction: "cc", status: "confirmed" },
        ],
      } as Trc20SponsoringOperation;
    }
    await store.admit(recoveredDebt("bad", config.owner));
    await store.admit(recoveredDebt("healthy", settlement.getAddresses()[0]));
    store.close();
    const rpc = vi.spyOn(providers.HttpProvider.prototype, "request").mockImplementation(async (path, params) => {
      if (path === "walletsolidity/getdelegatedresourcev2") {
        if ((params as { toAddress: string }).toAddress === TronWeb.address.toHex(config.owner))
          throw new Error("one receiver RPC permanently fails");
        return {};
      }
      if (path === "walletsolidity/getdelegatedresourceaccountindexv2") return {};
      if (path === "wallet/getaccountresource") return { EnergyLimit: 1000, NetLimit: 1000 };
      throw new Error(`Unexpected RPC: ${path}`);
    });
    const service = await createSponsoringService(config, { ...settlement, readContract: async () => 1000000n });
    try {
      const errorsBefore = await recoveryErrorCount(config.network);
      service.start();
      await vi.advanceTimersByTimeAsync(100);
      const debt = new DatabaseSync(config.database, { readOnly: true });
      try { expect(debt.prepare("SELECT status FROM operations WHERE key='healthy'").get()?.status).toBe("recovered"); }
      finally { debt.close(); }
      expect(service.readiness().mode).toBe("DEGRADED");
      expect(service.access().ready).toBe(false);
      expect(await recoveryErrorCount(config.network)).toBe(errorsBefore + 1);
    } finally { await service.close(); rpc.mockRestore(); vi.useRealTimers(); }
  });

  it("broadcasts another receiver's prepared reclaim after an earlier receiver RPC failure", async () => {
    vi.useFakeTimers();
    const config = testConfig();
    const now = Date.now();
    const reclaim = preparedReclaim();
    const store = new SqliteSponsoringCoordinator(config.database,
      { network: config.network, owner: config.owner, permissionId: config.permission_id },
      { energy: 1000000000n, bandwidth: 1000000000n, budget: 100000000n, management: 10000n });
    const operation = (key: string, payer: string, actions: Trc20SponsoringOperation["actions"]) => ({
      key, network: config.network, payer, approvalTxID: `${key}-approval`, requestDigest: key, revision: 0,
      createdAtMs: now - 26 * 3600000, recoveryStartedAtMs: now - 25 * 3600000, status: "failed_recovering", budgetUnits: 1n,
      request: { network: config.network, payer, approvalTxID: `${key}-approval`, approvalExpiration: String(now - 1000),
        requiredAllowance: "1", paymentRequirements: { amount: "1" } },
      plan: { legs: [{ resource: "ENERGY", stakeSun: 1000000n, delegatedUnits: 100n, requiredUnits: 100n }],
        energyRequired: 100n, bandwidthRequired: 0n, managementBandwidthRequired: 600n, replacementCost: 1n },
      actions,
    }) as Trc20SponsoringOperation;
    await store.admit(operation("bad", config.owner, []));
    await store.admit(operation("healthy", settlement.getAddresses()[0], [
      { ...reclaim, kind: "undelegate", resource: "ENERGY", status: "prepared" },
    ]));
    store.close();
    const broadcasts: string[] = [];
    const rpc = vi.spyOn(providers.HttpProvider.prototype, "request").mockImplementation(async (path, params) => {
      if (path === "walletsolidity/getdelegatedresourcev2") {
        const receiver = (params as { toAddress: string }).toAddress;
        if (receiver === TronWeb.address.toHex(config.owner)) throw new Error("bad receiver unavailable");
        return { delegatedResource: [{ from: TronWeb.address.toHex(config.owner), to: receiver, frozen_balance_for_energy: 1000000 }] };
      }
      if (path === "wallet/getnowblock") return { blockID: `${"0".repeat(14)}64${"11".repeat(8)}${"0".repeat(32)}`,
        block_header: { raw_data: { number: 100, timestamp: now } } };
      if (path === "wallet/getblockbynum") return { blockID: `${"0".repeat(14)}64${"11".repeat(8)}${"0".repeat(32)}`,
        block_header: { raw_data: { number: 100, timestamp: now } } };
      if (path === "wallet/broadcasthex") {
        broadcasts.push(String((params as { transaction: string }).transaction));
        return { result: true, txid: reclaim.txID, transaction: JSON.stringify({}) };
      }
      if (path === "walletsolidity/gettransactioninfobyid") return { id: reclaim.txID, blockNumber: 100, receipt: { result: "SUCCESS" } };
      if (path === "wallet/getaccountresource") return { EnergyLimit: 1000, NetLimit: 1000 };
      throw new Error(`Unexpected RPC: ${path}`);
    });
    const service = await createSponsoringService(config, settlement);
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(broadcasts).toEqual([reclaim.signedTransaction]);
      const db = new DatabaseSync(config.database, { readOnly: true });
      try {
        const row = db.prepare("SELECT payload FROM operations WHERE key='healthy'").get() as { payload: Uint8Array };
        expect(deserialize(row.payload)).toMatchObject({ status: "recovered",
          actions: [expect.objectContaining({ txID: reclaim.txID, status: "confirmed" })] });
      } finally { db.close(); }
      expect(service.readiness().mode).toBe("DEGRADED");
    } finally { await service.close(); rpc.mockRestore(); vi.useRealTimers(); }
  });

  it.each(["rpc-failure", "unknown-receiver", "invalid-inventory"])("closes admission on %s and retries inventory after recovery", async problem => {
    vi.useFakeTimers();
    let healthy = false;
    let reads = 0;
    const rpc = vi.spyOn(providers.HttpProvider.prototype, "request").mockImplementation(async path => {
      if (path !== "walletsolidity/getdelegatedresourceaccountindexv2") throw new Error(`Unexpected RPC: ${path}`);
      reads++;
      if (healthy) return {};
      if (problem === "rpc-failure") throw new Error("RPC unavailable");
      if (problem === "unknown-receiver") return { toAccounts: ["TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"] };
      return { toAccounts: "malformed" };
    });
    const service = await createSponsoringService(testConfig(), settlement);
    try {
      service.start();
      await vi.waitFor(() => expect(service.readiness().mode).toBe("DEGRADED"));
      expect(service.access().ready).toBe(false);
      healthy = true;
      await vi.advanceTimersByTimeAsync(15000);
      expect(service.readiness().mode).toBe("READY");
      expect(reads).toBe(2);
      await service.close();
      await vi.advanceTimersByTimeAsync(60000);
      expect(reads).toBe(2);
    } finally { rpc.mockRestore(); vi.useRealTimers(); }
  });

  it("opens new admission after confirmed reclaim but keeps its capacity debt through restart", async () => {
    vi.useFakeTimers();
    const config = testConfig();
    const now = Date.now();
    const store = new SqliteSponsoringCoordinator(config.database,
      { network: config.network, owner: config.owner, permissionId: config.permission_id },
      { energy: 1000000000n, bandwidth: 1000000000n, budget: 100000000n, management: 10000n });
    const op = { key: "recovered-later", network: config.network, payer: settlement.getAddresses()[0], approvalTxID: "approval",
      requestDigest: "digest", revision: 0, createdAtMs: now - 3600000, recoveryStartedAtMs: now - 3600000,
      status: "sponsored_recovering", budgetUnits: 1n,
      request: { network: config.network, payer: settlement.getAddresses()[0], requiredAllowance: "1", paymentRequirements: { amount: "1" } },
      plan: { legs: [{ resource: "ENERGY", stakeSun: 1000000n, delegatedUnits: 100n, requiredUnits: 100n }],
        energyRequired: 100n, bandwidthRequired: 0n, managementBandwidthRequired: 600n, replacementCost: 1n },
      actions: [
        { kind: "delegate", resource: "ENERGY", txID: "delegate", signedTransaction: "aa", status: "confirmed" },
        { kind: "approval", txID: "approval", signedTransaction: "bb", status: "confirmed" },
        { kind: "undelegate", resource: "ENERGY", txID: "reclaim", signedTransaction: "cc", status: "confirmed" },
      ],
    } as Trc20SponsoringOperation;
    await store.admit(op); store.close();
    const rpc = vi.spyOn(providers.HttpProvider.prototype, "request").mockImplementation(async path => {
      if (path === "walletsolidity/getdelegatedresourceaccountindexv2" || path === "walletsolidity/getdelegatedresourcev2") return {};
      if (path === "wallet/getaccountresource") return { EnergyLimit: 1000, EnergyUsed: 0, NetLimit: 1000, NetUsed: 0 };
      throw new Error(`Unexpected RPC: ${path}`);
    });
    const service = await createSponsoringService(config, settlement);
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(service.readiness().mode).toBe("READY");
      expect(service.access().ready).toBe(true);
      const debt = new (await import("node:sqlite")).DatabaseSync(config.database, { readOnly: true });
      try {
        expect(debt.prepare("SELECT status FROM operations WHERE key=?").get(op.key)?.status).toBe("sponsored_recovering");
      } finally { debt.close(); }
      vi.setSystemTime(now + 24 * 3600000);
      await vi.advanceTimersByTimeAsync(15000);
      expect(service.readiness().mode).toBe("READY");
    } finally { await service.close(); rpc.mockRestore(); vi.useRealTimers(); }
  });

  it("keeps its gate closed until local inventory is checked and closes cleanly", async () => {
    const rpc = vi.spyOn(providers.HttpProvider.prototype, "request").mockImplementation(async (path) => {
      if (path === "walletsolidity/getdelegatedresourceaccountindexv2") return {};
      throw new Error(`Unexpected RPC: ${path}`);
    });
    const config = sponsoringConfigSchema.parse({ network: "tron:0xcd8690dc", database: join(mkdtempSync(join(tmpdir(), "sponsor-service-")), "local.sqlite"),
      owner: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8", wallet_id: "owner-active", permission_id: 2,
      assets: ["TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"], pay_to: ["TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"],
      energy_stake_sun: "1000000000", bandwidth_stake_sun: "1000000000", budget_sun: "100000000", management_bandwidth: "10000" });
    const service = await createSponsoringService(config, { getAddresses: () => ["TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC"],
      readContract: async () => 0n } as unknown as FacilitatorTronSigner);
    try {
      expect(service.readiness()).toEqual({ ready: false, mode: "BOOTING", network: "tron:3448148188" });
      service.start();
      await vi.waitFor(() => expect(service.access().ready).toBe(true));
      expect(service.access().network).toBe("tron:3448148188");
    } finally { await service.close(); rpc.mockRestore(); }
    expect(service.access().ready).toBe(false);
  });
});
