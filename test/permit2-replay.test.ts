import { afterEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { providers } from "tronweb";
import { createFacilitatorTronSigner } from "@bankofai/x402-tron";
import { x402Facilitator } from "@bankofai/x402-core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@bankofai/x402-core/types";
import { permit2Identity, registerPermit2ReplayGuard, withPermit2SettlementLock } from "../src/permit2-replay.js";
import { disposeDatabase, getDatabasePool, getPermit2LockPool, initDatabase } from "../src/db/index.js";

const owner = "0x1111111111111111111111111111111111111111";
const requirements = (network = "eip155:97", scheme = "exact") => ({
  scheme, network, amount: "1", asset: owner, payTo: owner, maxTimeoutSeconds: 60,
}) as PaymentRequirements;
const payment = (nonce: unknown = "257", from: unknown = owner) => ({
  x402Version: 2, accepted: requirements(), payload: { permit2Authorization: { nonce, from } },
}) as PaymentPayload;

describe("Permit2 replay guard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the native TRON contract address through the real SDK's FullNode transport", async () => {
    const calls: Array<{ endpoint: string; args: unknown }> = [];
    vi.spyOn(providers.HttpProvider.prototype, "request").mockImplementation(async (endpoint, args) => {
      calls.push({ endpoint, args });
      if (endpoint !== "wallet/triggerconstantcontract") throw new Error(`Unexpected endpoint ${endpoint}`);
      return { result: { result: true }, constant_result: ["2".padStart(64, "0")] };
    });
    const signer = await createFacilitatorTronSigner({
      getAddress: async () => "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
      signTransaction: async () => { throw new Error("Must not sign a consumed nonce"); },
    }, { network: "tron:3448148188", rpcUrl: "http://127.0.0.1:1" });
    const facilitator = new x402Facilitator();
    registerPermit2ReplayGuard(facilitator, "tron:3448148188", signer);
    await expect(facilitator.settle(payment(), requirements("tron:3448148188"))).rejects.toThrow("permit2_nonce_consumed");
    expect(calls).toEqual([{ endpoint: "wallet/triggerconstantcontract", args: expect.objectContaining({
      contract_address: "41f62f506d1faa02e2354a9886b4a200496ee96f4b", function_selector: "nonceBitmap(address,uint256)",
    }) }]);
  });
  it("uses owner and nonce across assets and exact, upto, and batch deposit schemes", () => {
    const first = permit2Identity(payment(), requirements());
    const upto = permit2Identity(payment("0x101", owner.toUpperCase().replace("0X", "0x")),
      { ...requirements(undefined, "upto"), asset: "different" });
    const batch = { ...payment(), payload: { type: "deposit", deposit: {
      authorization: { permit2Authorization: { from: owner, nonce: "000257" } },
    } } } as PaymentPayload;
    expect(first).toEqual({ network: "eip155:97", owner, nonce: 257n });
    expect(upto).toEqual(first);
    expect(permit2Identity(batch, requirements(undefined, "batch-settlement"))).toEqual(first);
  });

  it("accepts zero and max uint256 while normalizing mixed-case EVM owners", () => {
    const mixedOwner = "0xabcdefABCDEFabcdefABCDEFabcdefABCDEFabcd";
    expect(permit2Identity(payment("0", mixedOwner), requirements())).toEqual({ network: "eip155:97",
      owner: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", nonce: 0n });
    expect(permit2Identity(payment(`0x${"f".repeat(64)}`), requirements())?.nonce)
      .toBe(115792089237316195423570985008687907853269984665640564039457584007913129639935n);
  });

  it("canonicalizes TRON base58, 41-hex, and 20-byte hex and network aliases", () => {
    const tronOwner = "0x0000000000000000000000000000000000000000";
    for (const from of ["T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb", "410000000000000000000000000000000000000000", tronOwner]) {
      expect(permit2Identity(payment("0xff", from), requirements("tron:0xcd8690dc")))
        .toEqual({ network: "tron:3448148188", owner: tronOwner, nonce: 255n });
    }
  });

  it.each([undefined, null, {}, { from: owner }, { from: "bad", nonce: "1" },
    { from: owner, nonce: "-1" }, { from: owner, nonce: 1 }, { from: owner, nonce: "1e3" },
    { from: owner, nonce: `0x1${"0".repeat(64)}` }])("fails closed for malformed Permit2 identity %j", authorization => {
    expect(() => permit2Identity({ ...payment(), payload: { permit2Authorization: authorization } }, requirements()))
      .toThrow("permit2_invalid_authorization");
  });

  it("leaves non-Permit2 authorizations and batch vouchers unaffected", () => {
    expect(permit2Identity({ ...payment(), payload: { authorization: { from: owner, nonce: "x" } } }, requirements())).toBeNull();
    expect(permit2Identity({ ...payment(), payload: { type: "voucher" } }, requirements(undefined, "batch-settlement"))).toBeNull();
  });

  it.each(["eip155:97", "tron:3448148188"])("checks word and bit before broadcasting on %s", async network => {
    let bitmap = 0n, broadcasts = 0;
    const reads: unknown[] = [];
    const facilitator = new x402Facilitator();
    registerPermit2ReplayGuard(facilitator, network, { readContract: async args => { reads.push(args); return bitmap; } });
    facilitator.register(network as `${string}:${string}`, { scheme: "exact", caipFamily: network.split(":")[0],
      getExtra: () => undefined, getSigners: () => [owner], verify: async () => ({ isValid: true }),
      settle: async () => { broadcasts++; bitmap = 2n;
        return { success: true, network: network as `${string}:${string}`, transaction: "tx" }; },
    });
    expect((await facilitator.settle(payment(), requirements(network))).success).toBe(true);
    await expect(facilitator.settle(payment(), requirements(network))).rejects.toThrow("permit2_nonce_consumed");
    expect(broadcasts).toBe(1);
    expect(reads[0]).toMatchObject({ address: network.startsWith("tron:") ? "TYQuuhGbEMxF7nZxUHV3uHJxAVVAegNU9h" : "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      functionName: "nonceBitmap", args: [owner, 1n] });
  });

  it.each([new Error("RPC unavailable"), undefined, -1n, 1n << 256n])("fails closed on failed or invalid nonce reads", async read => {
    let broadcasts = 0;
    const facilitator = new x402Facilitator();
    registerPermit2ReplayGuard(facilitator, "eip155:97", { readContract: async () => {
      if (read instanceof Error) throw read; return read;
    } });
    facilitator.register("eip155:97", { scheme: "exact", caipFamily: "eip155", getSigners: () => [owner],
      verify: async () => ({ isValid: true }), settle: async () => { broadcasts++; return { success: true, network: "eip155:97", transaction: "tx" }; } });
    await expect(facilitator.settle(payment(), requirements())).rejects.toThrow("permit2_nonce_check_unavailable");
    expect(broadcasts).toBe(0);
  });
});

const url = process.env.SPONSORING_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/sponsoring_test")
    throw new Error("Only the localhost sponsoring_test database is permitted");
}
describe.skipIf(!url)("PostgreSQL Permit2 authorization lock", () => {
  const pools: Pool[] = [];
  const pool = () => { const result = new Pool({ connectionString: url, max: 1 }); pools.push(result); return result; };
  afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.end())); });

  it("allows one runner across separate pools and releases after success and errors", async () => {
    const a = pool(), b = pool();
    const identity = permit2Identity(payment("98765432109876543210"), requirements())!;
    let release!: () => void, entered!: () => void, runs = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = withPermit2SettlementLock(a, identity, async () => { runs++; entered(); await waiting; return "first"; });
    await started;
    try {
      await expect(withPermit2SettlementLock(b, identity, async () => { runs++; })).rejects.toThrow("permit2_authorization_busy");
    } finally { release(); }
    expect(await first).toBe("first");
    expect(runs).toBe(1);
    await expect(withPermit2SettlementLock(b, identity, async () => { throw new Error("chain failure"); })).rejects.toThrow("chain failure");
    expect(await withPermit2SettlementLock(a, identity, async () => "retried")).toBe("retried");
    expect((await a.query("SELECT 1 AS ready")).rows[0].ready).toBe(1);
  });

  it("handles a lost PostgreSQL session during settlement without an unhandled error", async () => {
    const a = pool(), admin = pool();
    let backendPid = 0;
    a.on("connect", client => { backendPid = (client as PoolClient & { processID: number }).processID; });
    const identity = permit2Identity(payment("98765432109876543211"), requirements())!;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = withPermit2SettlementLock(a, identity, async () => { entered(); await waiting; return "confirmed"; });
    await started;
    await admin.query("SELECT pg_terminate_backend($1)", [backendPid]);
    // Round-trip until the terminated backend is gone, giving its error event time to arrive.
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [backendPid])).rowCount === 0) break;
    }
    release();
    expect(await first).toBe("confirmed");
    expect(await withPermit2SettlementLock(admin, identity, async () => "next")).toBe("next");
    expect((await a.query("SELECT 1 AS ready")).rows[0].ready).toBe(1);
  });

  it("does not settle after losing the lock while the nonce RPC was suspended", async () => {
    const a = pool(), admin = pool();
    let backendPid = 0, observedLoss!: () => void;
    const lost = new Promise<void>(resolve => { observedLoss = resolve; });
    a.on("connect", client => {
      backendPid = (client as PoolClient & { processID: number }).processID;
      client.once("error", observedLoss);
    });
    let releaseRead!: () => void, entered!: () => void, broadcasts = 0;
    const read = new Promise<void>(resolve => { releaseRead = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const facilitator = new x402Facilitator();
    registerPermit2ReplayGuard(facilitator, "eip155:97", { readContract: async () => { entered(); await read; return 0n; } });
    facilitator.register("eip155:97", { scheme: "exact", caipFamily: "eip155", getSigners: () => [owner],
      verify: async () => ({ isValid: true }), settle: async () => { broadcasts++; return { success: true, network: "eip155:97", transaction: "tx" }; } });
    const identity = permit2Identity(payment("98765432109876543212"), requirements())!;
    const first = withPermit2SettlementLock(a, identity, () => facilitator.settle(payment("98765432109876543212"), requirements()));
    const failure = expect(first).rejects.toThrow("permit2_storage_unavailable");
    await started;
    await admin.query("SELECT pg_terminate_backend($1)", [backendPid]);
    await lost;
    releaseRead();
    await failure;
    expect(broadcasts).toBe(0);
  });

  it("keeps a one-connection business pool usable during a Permit2 settlement", async () => {
    await initDatabase({ url: url!, poolSize: 1, maxOverflow: 0, maxLifeTime: 60, sslMode: "disable" });
    try {
      const identity = permit2Identity(payment("98765432109876543213"), requirements())!;
      const result = await withPermit2SettlementLock(getPermit2LockPool(), identity,
        async () => (await getDatabasePool().query("SELECT 1 AS usable")).rows[0].usable);
      expect(result).toBe(1);
    } finally { await disposeDatabase(); }
  });
});
