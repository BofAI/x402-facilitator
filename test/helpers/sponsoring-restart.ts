import { createTrc20ApprovalResourceSponsoringRuntime, TRON_NILE,
  type Trc20ApprovalResourceSponsoringRequest, type Trc20ResourceSponsoringChain } from "@bankofai/x402-tron";
import { SqliteSponsoringCoordinator } from "../../src/sponsoring/store.js";
import { guardSponsoringChain } from "../../src/sponsoring/chain.js";

export const binding = { network: TRON_NILE, owner: "test-owner", permissionId: 2 };
export const limits = { energy: 1000000000n, bandwidth: 1000000000n, budget: 100000000n, management: 100000n };
export const approvalTxID = "a".repeat(64);
export const operationKey = `${TRON_NILE}:${approvalTxID}`;

export function restartHarness(file: string, options: { allowance?: boolean; interrupt?: string; resumed?: boolean } = {}) {
  const store = new SqliteSponsoringCoordinator(file, binding, limits);
  const payer = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
  const asset = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
  const requirements = { scheme: "exact", network: TRON_NILE, asset, amount: "1", payTo: payer, maxTimeoutSeconds: 600 };
  const request: Trc20ApprovalResourceSponsoringRequest = { network: TRON_NILE, approvalTxID,
    approvalTimestamp: String(Date.now()), approvalExpiration: String(Date.now() + 600000), approvalFeeLimitSun: "100000000",
    approvalRefBlockBytes: "1234", approvalRefBlockHash: "0102030405060708", payer, asset,
    spender: "TYQuuhGbEMxF7nZxUHV3uHJxAVVAegNU9h", amount: String((1n << 256n) - 1n), requiredAllowance: "1",
    signedTransaction: "0a02abcd", paymentRequirements: requirements,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: {} } };
  const events: string[] = [];
  let visible = false;
  let allowance = options.allowance ?? false;
  async function broadcast(kind: string, txID: string) {
    events.push(`broadcast:${txID}`);
    if (options.interrupt === kind) {
      const op = await store.get(operationKey);
      process.send?.({ phase: kind, txID, instanceId: store.instanceId, deadlines: store.deadlines(operationKey),
        persisted: op?.actions.some(action => action.txID === txID && action.status === "prepared") });
      // Simulate a landed transaction with a response that never reaches the process.
      await new Promise(() => { setInterval(() => {}, 1000); });
    }
    return txID;
  }
  const base: Trc20ResourceSponsoringChain = {
    preflight: async () => ({ accountActivated: true, accountIsContract: false, allowance: 0n, tokenBalance: 1000000n,
      estimatedEnergy: 100n, estimatedBandwidth: 100n, managementBandwidthAvailable: 100000n, replacementCost: 1n,
      resources: { energyAvailable: visible ? 1000n : 0n, stakedBandwidthAvailable: 1000n, freeBandwidthAvailable: 0n,
        totalEnergyLimit: 1000n, totalEnergyWeight: 100n, totalBandwidthLimit: 1000n, totalBandwidthWeight: 100n } }),
    prepareDelegate: async () => { events.push("sign:delegate"); if (options.resumed) throw new Error("must not sign another delegate");
      return { txID: "delegate", signedTransaction: "signed-delegate" }; },
    prepareUndelegate: async () => { events.push("sign:reclaim"); return { txID: "reclaim", signedTransaction: "signed-reclaim" }; },
    broadcast: async action => {
      const saved = await store.findAction(action.txID);
      if (!saved?.actions.some(item => item.txID === action.txID && item.signedTransaction === action.signedTransaction))
        throw new Error("broadcast without durable matching bytes");
      return broadcast(action.txID === "delegate" ? "delegate" : "undelegate", action.txID);
    },
    broadcastApproval: async () => { allowance = true; return broadcast("approval", approvalTxID); },
    confirm: async txID => { events.push(`confirm:${txID}`); return "confirmed"; },
    resourcesVisible: async () => { visible = true; return true; },
    allowanceSufficient: async () => allowance,
    capacityRecovered: async () => true,
  };
  const runtime = createTrc20ApprovalResourceSponsoringRuntime({ chain: guardSponsoringChain(base, store), coordinator: store,
    policy: { preview: async () => ({ allowed: true, budgetUnits: 1n }) }, approvalPolicy: { strategyFor: () => "zero-first" } });
  return { store, runtime, request, events };
}
