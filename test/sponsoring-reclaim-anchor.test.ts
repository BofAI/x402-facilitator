import { describe, expect, it, vi } from "vitest";
import { TronWeb, utils } from "tronweb";
import { serializeSignedTronTransaction, type Trc20ApprovalResourceSponsoringRequest } from "@bankofai/x402-tron";
import { createAnchoredSponsoringChain } from "../src/sponsoring/sdk-chain.js";
import { createReclaimAnchor } from "../src/sponsoring/reclaim-anchor.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trc20ResourceSponsoringChain, Trc20SponsoringOperation } from "@bankofai/x402-tron";
import { SqliteSponsoringCoordinator } from "../src/sponsoring/store.js";
import { guardSponsoringChain } from "../src/sponsoring/chain.js";
import { recoverExpiredOperation } from "../src/sponsoring/recovery.js";
import { RecoverableChainError } from "../src/sponsoring/recovery-errors.js";

const approval = "a".repeat(64);
const request = { approvalTxID: approval, approvalExpiration: "20000" } as Trc20ApprovalResourceSponsoringRequest;
function block(number = 100, timestamp = 10000, hash = "1111111111111111") {
  return { blockID: number.toString(16).padStart(16, "0") + hash + "0".repeat(32),
    block_header: { raw_data: { number, timestamp } },
    transactions: [{ txID: approval, ret: [{ contractRet: "SUCCESS" }] }] };
}
function fixture() {
  let head = block(101, 13000, "2222222222222222"), included = block();
  let receipt: object = { id: approval, blockNumber: 100, receipt: { result: "SUCCESS" } };
  const rpc = vi.fn(async (path: string, body: { num?: number }) => {
    if (path === "wallet/getnowblock") return head;
    if (path === "wallet/gettransactioninfobyid") return receipt;
    if (path === "wallet/getblockbynum") return body.num === 100 ? included : head;
    throw new Error(`unexpected RPC ${path}`);
  });
  const anchor = createReclaimAnchor({ fullNode: { request: rpc } } as unknown as TronWeb, () => 14000);
  return { anchor, rpc, setHead: (b: ReturnType<typeof block>) => { head = b; },
    setBlock: (b: ReturnType<typeof block>) => { included = b; }, setReceipt: (r: object) => { receipt = r; } };
}
function action(ref = "1111111111111111") {
  const transaction = { raw_data: { ref_block_bytes: "0064", ref_block_hash: ref, timestamp: 14000, expiration: 74000,
    contract: [{ type: "UnDelegateResourceContract", Permission_id: 2, parameter: {
      type_url: "type.googleapis.com/protocol.UnDelegateResourceContract",
      value: { owner_address: `41${"11".repeat(20)}`, receiver_address: `41${"22".repeat(20)}`, balance: 1000000, resource: "ENERGY" },
    } }] }, signature: ["11".repeat(65)] };
  const pb = utils.transaction.txJsonToPb(transaction);
  const txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, "");
  return { txID, signedTransaction: serializeSignedTronTransaction({ ...transaction, txID, raw_data_hex: utils.transaction.txPbToRawDataHex(pb) }) };
}
describe("reclaim TAPOS anchor", () => {
  it("classifies anchor transport failure without classifying malformed signed bytes", async () => {
    const unavailable = createReclaimAnchor({ fullNode: { request: async () => { throw new Error("offline"); } } } as unknown as TronWeb);
    await expect(unavailable.blockHeader(request)).rejects.toBeInstanceOf(RecoverableChainError);
    const { anchor } = fixture();
    await expect(anchor.assertBroadcast(request, { txID: approval, signedTransaction: "not-hex" }))
      .rejects.not.toBeInstanceOf(RecoverableChainError);
  });

  it("survives restart and retains forked signed bytes until the original action is confirmed failed", async () => {
    const { anchor, setBlock } = fixture();
    const file = join(mkdtempSync(join(tmpdir(), "reclaim-anchor-")), "store.sqlite");
    const binding = { network: "tron:3448148188", owner: "owner", permissionId: 2 };
    const limits = { energy: 10000000n, bandwidth: 10000000n, budget: 10000000n, management: 10000n };
    const original = action();
    const op = { key: approval, network: binding.network, approvalTxID: approval, payer: "payer", requestDigest: approval,
      request: { ...request, network: binding.network, payer: "payer" },
      plan: { energyRequired: 100n, bandwidthRequired: 0n, managementBandwidthRequired: 700n, replacementCost: 1n,
        legs: [{ resource: "ENERGY", requiredUnits: 100n, delegatedUnits: 100n, stakeSun: 1000000n }] },
      budgetUnits: 1n, status: "sponsored_recovering", revision: 0, createdAtMs: 1000,
      actions: [{ ...original, kind: "undelegate", resource: "ENERGY", status: "prepared" }],
    } as Trc20SponsoringOperation;
    let store = new SqliteSponsoringCoordinator(file, binding, limits);
    await store.admit(op); store.close();
    store = new SqliteSponsoringCoordinator(file, binding, limits);
    let confirmation: "unknown" | "failed" | "confirmed" = "unknown";
    const replacement = action("3333333333333333");
    const prepare = vi.fn(async () => { await anchor.blockHeader(op.request); return replacement; });
    const broadcast = vi.fn(async prepared => prepared.txID);
    const confirm = vi.fn(async () => confirmation);
    const base = { prepareUndelegate: prepare, broadcast, confirm } as unknown as Trc20ResourceSponsoringChain;
    const chain = guardSponsoringChain(base, store, { assertReclaim: anchor.assertBroadcast });
    const recover = () => recoverExpiredOperation(op, store, chain, async () => 1000000n);
    try {
      setBlock(block(100, 10000, "3333333333333333"));
      await expect(recover()).rejects.toThrow("sponsor_reclaim_anchor_changed");
      expect((await store.get(op.key))!.actions[0]).toMatchObject({ ...original, status: "unknown" });
      await recover();
      expect(confirm).toHaveBeenCalledWith(original.txID);
      expect(prepare).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      // The chain confirmation layer, not elapsed wall time or a guard error,
      // must first establish failure of the original signed transaction.
      confirmation = "failed";
      await recover();
      expect(prepare).not.toHaveBeenCalled();
      confirmation = "confirmed";
      await recover();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(replacement));
      expect((await store.get(op.key))!.actions[0]).toMatchObject({ ...replacement, status: "confirmed" });
    } finally { store.close(); }
  });
  it("preserves the anchor through the real TronWeb builder, SDK signing and serialized broadcast guard", async () => {
    const { rpc } = fixture();
    const tron = new TronWeb({ fullHost: "http://127.0.0.1:1" });
    vi.spyOn(tron.solidityNode, "request").mockImplementation(async path => {
      if (path === "walletsolidity/getaccount") return { active_permission: [{ id: 2, operations: `${"00".repeat(7)}06${"00".repeat(24)}` }] };
      throw new Error(`unexpected solidity RPC ${path}`);
    });
    vi.spyOn(tron.fullNode, "request").mockImplementation(async (path, params) => {
      if (path === "wallet/getaccount") return { active_permission: [{ id: 2, operations: `${"00".repeat(7)}06${"00".repeat(24)}` }] };
      return rpc(path, params);
    });
    const anchor = createReclaimAnchor(tron, () => 14000);
    const chain = await createAnchoredSponsoringChain({ tronWeb: tron, network: "tron:3448148188", permissionId: 2,
      resourceOwnerSigner: { getAddress: async () => TronWeb.address.fromHex(`41${"11".repeat(20)}`),
        signResourceTransaction: async ({ transaction }) => ({ ...transaction, signature: ["11".repeat(65)] }) },
      readContract: async () => 0n, allowedAssets: [] }, anchor.blockHeader);
    const req = { ...request, payer: TronWeb.address.fromHex(`41${"22".repeat(20)}`) };
    const prepared = await chain.prepareUndelegate(req, { resource: "ENERGY", stakeSun: 1000000n, requiredUnits: 100n, delegatedUnits: 100n });
    await expect(anchor.assertBroadcast(req, prepared)).resolves.toBeUndefined();
    const raw = Buffer.from(utils.crypto.getRowBytesFromTransactionBase64(Buffer.from(prepared.signedTransaction, "hex").toString("base64")));
    expect(utils.deserializeTx.deserializeTransaction("UnDelegateResourceContract", raw.toString("hex")))
      .toMatchObject({ ref_block_bytes: "0064", ref_block_hash: "1111111111111111" });
  });
  it("anchors to the exact packed Approval block without any solidity RPC", async () => {
    const { anchor } = fixture();
    expect(await anchor.blockHeader(request)).toEqual({ ref_block_bytes: "0064", ref_block_hash: "1111111111111111", timestamp: 14000, expiration: 74000 });
  });
  it("does not treat provisional allowance or a receipt without block membership as inclusion", async () => {
    const { anchor, setBlock } = fixture();
    setBlock({ ...block(), transactions: [] });
    await expect(anchor.blockHeader(request)).rejects.toThrow("sponsor_approval_not_in_block");
  });
  it.each([{}, { id: "b".repeat(64), blockNumber: 100, receipt: { result: "SUCCESS" } },
    { id: approval, blockNumber: 100, receipt: { result: "REVERT" } }, { Error: "offline" }])("fails closed on unavailable or inconsistent receipts (%j)", async receipt => {
    const { anchor, setReceipt } = fixture(); setReceipt(receipt);
    await expect(anchor.blockHeader(request)).rejects.toThrow();
  });
  it("rejects a block whose identity disagrees with its requested height", async () => {
    const { anchor, setBlock } = fixture(); setBlock(block(99));
    await expect(anchor.blockHeader(request)).rejects.toThrow();
  });
  it("uses chain time, not wall time, to release an expired unbroadcast Approval", async () => {
    const { anchor, setHead, setReceipt } = fixture(); setReceipt({});
    setHead(block(101, 20000));
    await expect(anchor.blockHeader(request)).rejects.toThrow();
    setHead(block(101, 23000));
    expect(await anchor.blockHeader(request)).toMatchObject({ ref_block_bytes: "0065", ref_block_hash: "1111111111111111" });
  });
  it("allows replay of identical signed bytes while their Approval anchor remains canonical", async () => {
    const { anchor } = fixture(); const prepared = action();
    await expect(anchor.assertBroadcast(request, prepared)).resolves.toBeUndefined();
    await expect(anchor.assertBroadcast(request, prepared)).resolves.toBeUndefined();
  });
  it("rejects a prepared reclaim after a fork replaces its anchor, even if Approval reappears", async () => {
    const { anchor, setBlock } = fixture(); setBlock(block(100, 10000, "3333333333333333"));
    await expect(anchor.assertBroadcast(request, action())).rejects.toThrow("sponsor_reclaim_anchor_changed");
  });
  it("rejects legacy unanchored reclamation even when that old reference block is canonical", async () => {
    const { anchor, setBlock } = fixture(); setBlock({ ...block(), transactions: [] });
    await expect(anchor.assertBroadcast(request, action())).rejects.toThrow();
  });
  it("rejects signed-byte / txID mismatch before network access", async () => {
    const { anchor, rpc } = fixture();
    await expect(anchor.assertBroadcast(request, { ...action(), txID: "b".repeat(64) })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("accepts an expiry anchor without inventing an Approval inclusion", async () => {
    const { anchor, setBlock, setHead, setReceipt } = fixture();
    setReceipt({}); setBlock({ ...block(100, 23000), transactions: [] }); setHead(block(101, 26000));
    await expect(anchor.assertBroadcast(request, action())).resolves.toBeUndefined();
  });
});
