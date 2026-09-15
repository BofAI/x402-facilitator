import { describe, expect, it, vi } from "vitest";
import type { Trc20SponsoringOperation, Trc20ResourceSponsoringChain } from "@bankofai/x402-tron";
import { guardSponsoringChain } from "../src/sponsoring/chain.js";
import { recoverExpiredOperation } from "../src/sponsoring/recovery.js";
import { RecoverableChainError, storageBoundary } from "../src/sponsoring/recovery-errors.js";

describe("local expired delegation recovery", () => {
  it.each([true, false])("resolves a never-submitted prepared Approval only after expiry (%s)", async expired => {
    let operation = { key: "op", revision: 1, status: "failed_recovering", plan: { legs: [] },
      request: { approvalExpiration: String(Date.now() + (expired ? -1000 : 60000)) },
      actions: [{ kind: "approval", txID: "approval", signedTransaction: "aa", status: "prepared" }],
    } as unknown as Trc20SponsoringOperation;
    const chain = { confirm: async () => "failed" } as unknown as Trc20ResourceSponsoringChain;
    const store = { get: async () => operation, save: async (next: Trc20SponsoringOperation) => {
      operation = { ...next, revision: next.revision + 1 }; return operation;
    } };
    await recoverExpiredOperation(operation, store, chain, async () => 0n);
    expect(operation.actions[0].status).toBe(expired ? "failed" : "prepared");
  });
  it.each(["confirm", "broadcast", "inventory"] as const)("still submits Bandwidth reclaim when Energy %s fails", async failure => {
    let operation = { key: "op", revision: 1, request: {}, plan: { legs: [
      { resource: "ENERGY", stakeSun: 1000000n }, { resource: "BANDWIDTH", stakeSun: 1000000n },
    ] }, actions: [], status: "approval_submitted" } as unknown as Trc20SponsoringOperation;
    const events: string[] = [];
    const store = { get: async () => operation, save: async (next: Trc20SponsoringOperation) => {
      operation = { ...next, revision: next.revision + 1 }; return operation;
    } };
    const chain = {
      prepareUndelegate: async (_request, leg) => ({ txID: leg.resource, signedTransaction: leg.resource }),
      broadcast: async action => {
        expect(operation.actions.find(saved => saved.txID === action.txID)?.status).toBe("prepared");
        events.push(`broadcast:${action.txID}`);
        if (failure === "broadcast" && action.txID === "ENERGY") throw new RecoverableChainError(new Error("response lost"));
        return action.txID;
      },
      confirm: async txID => {
        events.push(`confirm:${txID}`);
        if (failure === "confirm" && txID === "ENERGY") throw new RecoverableChainError(new Error("RPC timeout"));
        return "confirmed";
      },
    } as Trc20ResourceSponsoringChain;
    await expect(recoverExpiredOperation(operation, store, chain, async (_operation, leg) => {
      if (failure === "inventory" && leg.resource === "ENERGY") throw new RecoverableChainError(new Error("RPC timeout"));
      return 1000000n;
    })).rejects.toThrow();
    expect(events).toContain("broadcast:BANDWIDTH");
    expect(operation.actions.find(action => action.txID === "BANDWIDTH")?.status).toBe("confirmed");
    if (failure !== "inventory") {
      expect(operation.actions.find(action => action.txID === "ENERGY")?.status).toBe("unknown");
    }
  });

  it("submits both reclaim transactions before waiting for either solidified receipt", async () => {
    let operation = { key: "op", revision: 1, request: {}, plan: { legs: [
      { resource: "ENERGY", stakeSun: 1000000n }, { resource: "BANDWIDTH", stakeSun: 1000000n },
    ] }, actions: [], status: "approval_submitted" } as unknown as Trc20SponsoringOperation;
    const events: string[] = [];
    const store = { get: async () => operation, save: async (next: Trc20SponsoringOperation) => {
      operation = { ...next, revision: next.revision + 1 }; return operation;
    } };
    const chain = {
      prepareUndelegate: async (_request, leg) => ({ txID: leg.resource, signedTransaction: leg.resource }),
      broadcast: async action => { events.push(`broadcast:${action.txID}`); return action.txID; },
      confirm: async txID => { events.push(`confirm:${txID}`); return "confirmed"; },
    } as Trc20ResourceSponsoringChain;
    await recoverExpiredOperation(operation, store, chain, async () => 1000000n);
    expect(events).toEqual(["broadcast:ENERGY", "broadcast:BANDWIDTH", "confirm:ENERGY", "confirm:BANDWIDTH"]);
  });

  it("recovers a lost broadcast response by confirming the original txID without signing a replacement", async () => {
    let operation = { key: "op", revision: 1, request: {}, plan: { legs: [
      { resource: "ENERGY", stakeSun: 1000000n },
    ] }, actions: [], status: "approval_submitted" } as unknown as Trc20SponsoringOperation;
    const events: string[] = [];
    const store = { get: async () => operation, save: async (next: Trc20SponsoringOperation) => {
      operation = { ...next, revision: next.revision + 1 }; return operation;
    } };
    const chain = {
      prepareUndelegate: async () => { events.push("sign"); return { txID: "original", signedTransaction: "signed" }; },
      broadcast: async () => { events.push("broadcast"); throw new RecoverableChainError(new Error("response lost")); },
      confirm: async txID => { events.push(`confirm:${txID}`); return "confirmed"; },
    } as unknown as Trc20ResourceSponsoringChain;
    await expect(recoverExpiredOperation(operation, store, chain, async () => 1000000n)).rejects.toThrow("response lost");
    expect(operation.actions[0].status).toBe("unknown");
    await recoverExpiredOperation(operation, store, chain, async () => 1000000n);
    expect(events).toEqual(["sign", "broadcast", "confirm:original"]);
    expect(operation.actions[0].status).toBe("confirmed");
  });

  it("keeps the original txID unknown when broadcast returns a different txID", async () => {
    let operation = { key: "op", revision: 1, request: {}, plan: { legs: [
      { resource: "ENERGY", stakeSun: 1000000n },
    ] }, actions: [{ kind: "undelegate", resource: "ENERGY", txID: "original", signedTransaction: "signed", status: "prepared" }],
    status: "failed_recovering" } as unknown as Trc20SponsoringOperation;
    const store = { get: async () => operation, save: async (next: Trc20SponsoringOperation) => {
      operation = { ...next, revision: next.revision + 1 }; return operation;
    } };
    const chain = { broadcast: async () => "different" } as unknown as Trc20ResourceSponsoringChain;

    await expect(recoverExpiredOperation(operation, store, chain, async () => 1000000n)).rejects.toThrow("broadcast_txid_mismatch");

    expect(operation.actions[0]).toMatchObject({ txID: "original", signedTransaction: "signed", status: "unknown" });
  });

  it("stops before any broadcast if the prepared reclaim cannot be persisted", async () => {
    const operation = { key: "op", revision: 1, request: {}, plan: { legs: [
      { resource: "ENERGY", stakeSun: 1000000n }, { resource: "BANDWIDTH", stakeSun: 1000000n },
    ] }, actions: [], status: "approval_submitted" } as unknown as Trc20SponsoringOperation;
    const events: string[] = [];
    const chain = {
      prepareUndelegate: async (_request, leg) => {
        events.push(`sign:${leg.resource}`); return { txID: leg.resource, signedTransaction: leg.resource };
      },
      broadcast: async action => { events.push(`broadcast:${action.txID}`); return action.txID; },
    } as Trc20ResourceSponsoringChain;
    await expect(recoverExpiredOperation(operation, { get: async () => operation, save: async () => {
      throw new Error("disk full");
    } }, chain, async () => 1000000n)).rejects.toThrow("disk full");
    expect(events).toEqual(["sign:ENERGY"]);
  });

  it.each(["findAction", "assertOwnership", "action-mismatch"] as const)(
    "does not treat guard %s failure as an isolated chain outage", async failure => {
      let operation = { key: "op", revision: 1, request: {}, plan: { legs: [
        { resource: "ENERGY", stakeSun: 1000000n }, { resource: "BANDWIDTH", stakeSun: 1000000n },
      ] }, actions: [
        { kind: "undelegate", resource: "ENERGY", txID: "ENERGY", signedTransaction: "energy-bytes", status: "prepared" },
        { kind: "undelegate", resource: "BANDWIDTH", txID: "BANDWIDTH", signedTransaction: "bandwidth-bytes", status: "prepared" },
      ], status: "failed_recovering" } as unknown as Trc20SponsoringOperation;
      let first = true;
      const store = {
        get: async () => operation,
        save: async (next: Trc20SponsoringOperation) => { operation = { ...next, revision: next.revision + 1 }; return operation; },
        findAction: vi.fn(async () => {
          if (first && failure === "findAction") { first = false; throw new Error("database unavailable"); }
          if (first && failure === "action-mismatch") { first = false; return undefined; }
          return operation;
        }),
        findApproval: vi.fn(), deadlines: vi.fn(), noteDelegate: vi.fn(),
        assertOwnership: vi.fn(async () => {
          if (first && failure === "assertOwnership") { first = false; throw new Error("sponsor_ownership_lost"); }
        }),
      };
      const base = { broadcast: vi.fn(async action => action.txID) } as unknown as Trc20ResourceSponsoringChain;
      const chain = guardSponsoringChain(base, store);

      await expect(recoverExpiredOperation(operation, store, chain, async () => 1000000n)).rejects.toThrow();

      expect(base.broadcast).not.toHaveBeenCalled();
      expect(operation.actions.every(action => action.status === "prepared")).toBe(true);
    },
  );

  it("stops before later signing when signer expiration persistence fails", async () => {
    const operation = { key: "op", revision: 1, request: {}, plan: { legs: [
      { resource: "ENERGY", stakeSun: 1000000n }, { resource: "BANDWIDTH", stakeSun: 1000000n },
    ] }, actions: [], status: "failed_recovering" } as unknown as Trc20SponsoringOperation;
    const prepared: string[] = [];
    const save = vi.fn(async (next: Trc20SponsoringOperation) => next);
    const chain = { prepareUndelegate: async (_request, leg) => {
      prepared.push(leg.resource);
      await storageBoundary(() => { throw new Error("rememberExpiration unavailable"); });
      return { txID: leg.resource, signedTransaction: leg.resource };
    } } as Trc20ResourceSponsoringChain;

    await expect(recoverExpiredOperation(operation, { get: async () => operation, save }, chain, async () => 1000000n))
      .rejects.toThrow("rememberExpiration unavailable");

    expect(prepared).toEqual(["ENERGY"]);
    expect(save).not.toHaveBeenCalled();
  });

  it("stops before the next leg when local reclaim preparation validation fails", async () => {
    const operation = { key: "op", revision: 1, request: {}, plan: { legs: [
      { resource: "ENERGY", stakeSun: 1000000n }, { resource: "BANDWIDTH", stakeSun: 1000000n },
    ] }, actions: [], status: "failed_recovering" } as unknown as Trc20SponsoringOperation;
    const prepared: string[] = [];
    const save = vi.fn(async (next: Trc20SponsoringOperation) => next);
    const base = { prepareUndelegate: vi.fn(async (_request, leg) => {
      prepared.push(leg.resource);
      if (leg.resource === "ENERGY") throw new Error("resource_reference_block_mismatch");
      return { txID: leg.resource, signedTransaction: leg.resource };
    }), broadcast: vi.fn() } as unknown as Trc20ResourceSponsoringChain;
    const chain = guardSponsoringChain(base, { findAction: vi.fn(), findApproval: vi.fn(), deadlines: vi.fn(),
      noteDelegate: vi.fn(), assertOwnership: vi.fn(async () => {}) });

    await expect(recoverExpiredOperation(operation, { get: async () => operation, save }, chain, async () => 1000000n))
      .rejects.toThrow();

    expect(prepared).toEqual(["ENERGY"]);
    expect(save).not.toHaveBeenCalled();
    expect(base.broadcast).not.toHaveBeenCalled();
  });

  it("does not persist or poll allowance after a confirmation deadline read fails", async () => {
    const operation = { key: "op", approvalTxID: "approval", revision: 1,
      request: { approvalExpiration: String(Date.now() - 1000) }, plan: { legs: [] },
      actions: [{ kind: "approval", txID: "approval", signedTransaction: "aa", status: "prepared" }],
      status: "failed_recovering" } as unknown as Trc20SponsoringOperation;
    const save = vi.fn(async (next: Trc20SponsoringOperation) => next);
    const base = { allowanceSufficient: vi.fn() } as unknown as Trc20ResourceSponsoringChain;
    const chain = guardSponsoringChain(base, { findAction: async () => operation, findApproval: vi.fn(),
      deadlines: async () => { throw new Error("deadline storage unavailable"); }, noteDelegate: vi.fn(), assertOwnership: vi.fn() });

    await expect(recoverExpiredOperation(operation, { get: async () => operation, save }, chain, async () => 0n))
      .rejects.toThrow("deadline storage unavailable");

    expect(base.allowanceSufficient).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("reclaims recorded delegation after deadline even when Approval remains unknown", async () => {
    let operation = { key: "op", revision: 1, request: {}, plan: { legs: [{ resource: "ENERGY", stakeSun: 1000000n }] },
      actions: [{ kind: "approval", txID: "approval", status: "unknown", signedTransaction: "aa" }], status: "approval_submitted" } as Trc20SponsoringOperation;
    const events: string[] = [];
    const store = { get: async () => operation, save: async (next: Trc20SponsoringOperation) => {
      events.push("saved"); operation = { ...next, revision: next.revision + 1 }; return operation;
    } };
    const chain = { prepareUndelegate: async () => ({ txID: "reclaim", signedTransaction: "bb" }),
      broadcast: async () => { events.push("broadcast"); return "reclaim"; }, confirm: async () => "confirmed" } as unknown as Trc20ResourceSponsoringChain;
    const updated = await recoverExpiredOperation(operation, store, chain, async () => 1000000n);
    expect(events.indexOf("saved")).toBeLessThan(events.indexOf("broadcast"));
    expect(updated.actions.find(action => action.kind === "undelegate")?.status).toBe("confirmed");
    expect(updated.status).toBe("failed_recovering");
    expect(updated.actions.find(action => action.kind === "approval")?.status).toBe("unknown");
  });
  it("refuses delegation larger than this operation's recorded stake", async () => {
    const operation = { key: "op", plan: { legs: [{ resource: "ENERGY", stakeSun: 1000000n }] }, actions: [] } as unknown as Trc20SponsoringOperation;
    const chain = { prepareUndelegate: vi.fn() } as unknown as Trc20ResourceSponsoringChain;
    await expect(recoverExpiredOperation(operation, { get: async () => operation, save: async op => op }, chain, async () => 2000000n))
      .rejects.toThrow(/inconsistent/);
    expect(chain.prepareUndelegate).not.toHaveBeenCalled();
  });
});
