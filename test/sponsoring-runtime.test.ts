import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTrc20ApprovalResourceSponsoringRuntime, TRON_NILE, type Trc20ApprovalResourceSponsoringRequest,
  type Trc20ResourceSponsoringChain } from "@bankofai/x402-tron";
import { SqliteSponsoringCoordinator } from "../src/sponsoring/store.js";
import { guardSponsoringChain } from "../src/sponsoring/chain.js";

describe("beta SDK with durable coordinator and allowance confirmation", () => {
  it.each(["none", "energy", "bandwidth", "both"])("executes %s plan and persists each action before broadcast", async (mode) => {
    const payer = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
    const token = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
    const requirements = { scheme: "exact", network: TRON_NILE, asset: token, amount: "1000000", payTo: payer, maxTimeoutSeconds: 600 };
    const request: Trc20ApprovalResourceSponsoringRequest = { network: TRON_NILE, approvalTxID: "a".repeat(64),
      approvalTimestamp: String(Date.now()), approvalExpiration: String(Date.now() + 600000), approvalFeeLimitSun: "100000000",
      approvalRefBlockBytes: "1234", approvalRefBlockHash: "0102030405060708", payer, asset: token,
      spender: "TYQuuhGbEMxF7nZxUHV3uHJxAVVAegNU9h", amount: String((1n << 256n) - 1n), requiredAllowance: "1000000",
      signedTransaction: "0a02abcd", paymentRequirements: requirements,
      paymentPayload: { x402Version: 2, accepted: requirements, payload: {} } };
    const store = new SqliteSponsoringCoordinator(join(mkdtempSync(join(tmpdir(), "sdk-sponsor-")), "db.sqlite"),
      { network: TRON_NILE, owner: "owner", permissionId: 2 }, { energy: 1000000000n, bandwidth: 1000000000n, budget: 100000000n, management: 100000n });
    const events: string[] = [];
    let visible = false;
    let allowance = false;
    const base: Trc20ResourceSponsoringChain = {
      preflight: async () => ({ accountActivated: true, accountIsContract: false, allowance: 0n, tokenBalance: 2000000n,
        estimatedEnergy: 100n, estimatedBandwidth: 100n, managementBandwidthAvailable: 100000n, replacementCost: 1n,
        resources: { energyAvailable: visible || ["none", "bandwidth"].includes(mode) ? 1000n : 0n,
          stakedBandwidthAvailable: visible || ["none", "energy"].includes(mode) ? 1000n : 0n, freeBandwidthAvailable: 0n,
          totalEnergyLimit: 1000n, totalEnergyWeight: 100n, totalBandwidthLimit: 1000n, totalBandwidthWeight: 100n } }),
      prepareDelegate: async (_request, leg) => ({ txID: `delegate-${leg.resource}`, signedTransaction: `delegate-${leg.resource}` }),
      prepareUndelegate: async (_request, leg) => ({ txID: `reclaim-${leg.resource}`, signedTransaction: `reclaim-${leg.resource}` }),
      broadcast: async action => {
        const persisted = await store.findAction(action.txID);
        expect(persisted?.actions.find(item => item.txID === action.txID)?.signedTransaction).toBe(action.signedTransaction);
        events.push(action.txID); return action.txID;
      },
      broadcastApproval: async bytes => {
        expect((await store.findApproval(bytes))?.actions.some(item => item.kind === "approval")).toBe(true);
        events.push("approval"); allowance = true; return request.approvalTxID;
      },
      confirm: async txID => { expect(txID).not.toBe(request.approvalTxID); return "confirmed"; },
      resourcesVisible: async () => { visible = true; return true; },
      allowanceSufficient: async () => allowance,
      capacityRecovered: async () => true,
    };
    const runtime = createTrc20ApprovalResourceSponsoringRuntime({ chain: guardSponsoringChain(base, store), coordinator: store,
      policy: { preview: async () => ({ allowed: true, budgetUnits: 1n }) }, approvalPolicy: { strategyFor: () => "zero-first" } });
    const result = await runtime.sponsor(request);
    expect(result.success).toBe(true);
    const expected = mode === "none" ? [] : mode === "both" ? ["ENERGY", "BANDWIDTH"] : [mode.toUpperCase()];
    expect(events).toEqual([...expected.map(resource => `delegate-${resource.toLowerCase()}`), "approval", ...expected.map(resource => `reclaim-${resource.toLowerCase()}`)]);
    await runtime.reconcile();
    expect(await store.listRecoverable(100)).toEqual([]);
    store.close();
  });
});
