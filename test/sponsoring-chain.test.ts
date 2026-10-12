import { describe, expect, it, vi } from "vitest";
import type { Trc20ResourceSponsoringChain, Trc20SponsoringOperation } from "@bankofai/x402-tron";
import { guardSponsoringChain } from "../src/sponsoring/chain.js";
import { RecoverableChainError } from "../src/sponsoring/recovery-errors.js";

function fixture() {
  const operation = { key: "op", approvalTxID: "approve", request: { signedTransaction: "aa", approvalExpiration: "99999999" }, actions: [
    { kind: "approval", txID: "approve", signedTransaction: "aa", status: "submitted" },
    { kind: "delegate", txID: "delegate", signedTransaction: "bb", status: "prepared" },
  ] } as Trc20SponsoringOperation;
  const store = { findAction: async () => operation, findApproval: async () => operation,
    deadlines: vi.fn(async () => ({ businessDeadline: 480000 })), noteDelegate: vi.fn(async () => {}), assertOwnership: vi.fn(async () => {}) };
  const base = { prepareDelegate: vi.fn(async () => ({ txID: "delegate", signedTransaction: "bb" })),
    prepareUndelegate: vi.fn(async () => ({ txID: "reclaim", signedTransaction: "cc" })),
    confirm: vi.fn(async () => "unknown"), allowanceSufficient: vi.fn(async () => true),
    broadcastApproval: vi.fn(async () => "approve"), broadcast: vi.fn(async () => "delegate") } as unknown as Trc20ResourceSponsoringChain;
  let now = 1000;
  const chain = guardSponsoringChain(base, store, { now: () => now, sleep: async ms => { now += ms; },
    approvalPollMs: 1000, confirmationTimeoutMs: 3000 });
  return { chain, base, store, operation, setNow: (value: number) => { now = value; } };
}
describe("sponsoring chain boundary", () => {
  it.each(["prepareDelegate", "prepareUndelegate"] as const)("does not classify local %s validation as transport failure", async method => {
    const { store, base } = fixture();
    base[method].mockRejectedValue(new Error("resource_owner_signed_transaction_mismatch"));
    const chain = guardSponsoringChain(base, store);
    await expect(chain[method]({} as never, {} as never)).rejects.not.toBeInstanceOf(RecoverableChainError);
  });
  it("does not classify local broadcast-byte validation as transport failure", async () => {
    const { chain, base } = fixture();
    base.broadcast.mockRejectedValue(new Error("Invalid hex transaction provided"));
    await expect(chain.broadcast({ txID: "delegate", signedTransaction: "bb" }))
      .rejects.not.toBeInstanceOf(RecoverableChainError);
  });
  it("does not classify local allowance parsing as transport failure", async () => {
    const { chain, base } = fixture();
    base.allowanceSufficient.mockRejectedValue(new SyntaxError("invalid bigint"));
    await expect(chain.confirm("approve")).rejects.not.toBeInstanceOf(RecoverableChainError);
  });
  it("rejects an unsafe persisted reclaim before broadcasting its original bytes", async () => {
    const { base, store, operation } = fixture();
    (operation.actions as unknown[]).push({ kind: "undelegate", txID: "reclaim", signedTransaction: "cc", status: "prepared" });
    const chain = guardSponsoringChain(base, store, { assertReclaim: async () => { throw new Error("sponsor_reclaim_anchor_changed"); } });
    await expect(chain.broadcast({ txID: "reclaim", signedTransaction: "cc" })).rejects.toThrow("sponsor_reclaim_anchor_changed");
    expect(base.broadcast).not.toHaveBeenCalled();
  });
  it("rechecks ownership after asynchronous reclaim-anchor validation", async () => {
    const { base, store, operation } = fixture();
    (operation.actions as unknown[]).push({ kind: "undelegate", txID: "reclaim", signedTransaction: "cc", status: "prepared" });
    const chain = guardSponsoringChain(base, store, { assertReclaim: async () => {
      store.assertOwnership.mockRejectedValue(new Error("sponsor_owner_lock_lost"));
    } });
    await expect(chain.broadcast({ txID: "reclaim", signedTransaction: "cc" })).rejects.toThrow("sponsor_owner_lock_lost");
    expect(base.broadcast).not.toHaveBeenCalled();
  });
  it.each(["delegate", "approval"])("rejects %s if its deadline passes during the final ownership read", async kind => {
    const { chain, store, base, setNow } = fixture();
    store.assertOwnership.mockImplementation(async () => { setNow(480001); });
    await expect(kind === "delegate" ? chain.broadcast({ txID: "delegate", signedTransaction: "bb" }) : chain.broadcastApproval("aa")).rejects.toThrow("sponsor_operation_timeout");
    expect(base.broadcast).not.toHaveBeenCalled();
    expect(base.broadcastApproval).not.toHaveBeenCalled();
  });
  it.each(["prepareDelegate", "prepareUndelegate"] as const)("checks ownership before %s", async method => {
    const { chain, store, base } = fixture();
    store.assertOwnership.mockRejectedValue(new Error("sponsor_owner_lock_lost"));
    await expect(chain[method]({} as never, {} as never)).rejects.toThrow("sponsor_owner_lock_lost");
    expect(base[method]).not.toHaveBeenCalled();
  });
  it.each(["delegate", "approval"])("awaits durable deadlines before %s broadcast", async kind => {
    const { chain, store, base } = fixture();
    let release!: () => void;
    store.deadlines.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); return { businessDeadline: 480000 }; });
    const pending = kind === "delegate" ? chain.broadcast({ txID: "delegate", signedTransaction: "bb" }) : chain.broadcastApproval("aa");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(base.broadcast).not.toHaveBeenCalled();
    expect(base.broadcastApproval).not.toHaveBeenCalled();
    release();
    await pending;
  });
  it("awaits durable delegation timing and rechecks ownership before broadcast", async () => {
    const { chain, store, base } = fixture();
    let release!: () => void;
    store.noteDelegate.mockImplementation(async () => { await new Promise<void>(r => { release = r; }); });
    const pending = chain.broadcast({ txID: "delegate", signedTransaction: "bb" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(base.broadcast).not.toHaveBeenCalled();
    store.assertOwnership.mockRejectedValue(new Error("sponsor_owner_lock_lost"));
    release();
    await expect(pending).rejects.toThrow("sponsor_owner_lock_lost");
    expect(base.broadcast).not.toHaveBeenCalled();
  });
  it.each(["delegate", "approval"])("rejects %s with lost ownership", async kind => {
    const { chain, store, base } = fixture();
    store.assertOwnership.mockRejectedValue(new Error("sponsor_owner_lock_lost"));
    await expect(kind === "delegate" ? chain.broadcast({ txID: "delegate", signedTransaction: "bb" }) : chain.broadcastApproval("aa")).rejects.toThrow("sponsor_owner_lock_lost");
    expect(base.broadcast).not.toHaveBeenCalled();
    expect(base.broadcastApproval).not.toHaveBeenCalled();
  });
  it("accepts observed allowance without waiting for the Approval receipt", async () => {
    const { chain, base } = fixture();
    expect(await chain.confirm("approve")).toBe("confirmed");
    expect(base.confirm).not.toHaveBeenCalled();
  });
  it("keeps unknown when allowance never appears and still uses receipt confirmation for Delegate", async () => {
    const { chain, base } = fixture();
    vi.mocked(base.allowanceSufficient).mockResolvedValue(false);
    expect(await chain.confirm("approve")).toBe("unknown");
    expect(await chain.confirm("delegate")).toBe("unknown");
    expect(base.confirm).toHaveBeenCalledWith("delegate");
  });
  it("rejects late Delegate and Approval broadcasts but allows reclaim", async () => {
    const { chain, setNow, operation } = fixture();
    setNow(480001);
    await expect(chain.broadcastApproval("aa")).rejects.toThrow(/timeout/);
    await expect(chain.broadcast({ txID: "delegate", signedTransaction: "bb" })).rejects.toThrow(/timeout/);
    (operation.actions as unknown[]).push({ kind: "undelegate", txID: "reclaim", signedTransaction: "cc", status: "prepared" });
    await expect(chain.broadcast({ txID: "reclaim", signedTransaction: "cc" })).resolves.toBe("delegate");
  });
  it("rejects transaction bytes different from the durable action", async () => {
    const { chain } = fixture();
    await expect(chain.broadcast({ txID: "delegate", signedTransaction: "dd" })).rejects.toThrow(/mismatch/);
  });
});
