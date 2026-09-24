import { isDeepStrictEqual } from "node:util";
import type { Trc20SponsoringOperation } from "@bankofai/x402-tron";
import type { CapacityLimits } from "./coordinator.js";

export function capacityDenial(active: readonly Trc20SponsoringOperation[], operation: Trc20SponsoringOperation, limits: CapacityLimits): string | undefined {
  if (active.some(op => op.payer === operation.payer)) return "sponsor_operation_in_progress";
  const used: CapacityLimits = { energy: 0n, bandwidth: 0n, budget: 0n, management: 0n };
  for (const op of [...active, operation]) {
    if (op.budgetUnits < 0n || op.plan.managementBandwidthRequired < 0n) throw new Error("sponsor_invalid_capacity");
    used.budget += op.budgetUnits;
    used.management += op.plan.managementBandwidthRequired;
    for (const leg of op.plan.legs) {
      if (leg.stakeSun < 1_000_000n) return "sponsor_delegate_below_chain_minimum";
      used[leg.resource === "ENERGY" ? "energy" : "bandwidth"] += leg.stakeSun;
    }
  }
  if ((Object.keys(used) as (keyof CapacityLimits)[]).some(key => used[key] > limits[key])) return "sponsor_capacity_unavailable";
}

export function validateSave(current: Trc20SponsoringOperation | undefined, operation: Trc20SponsoringOperation): void {
  if (!current || current.revision !== operation.revision) throw new Error("sponsorship operation revision conflict");
  if (current.network !== operation.network || current.payer !== operation.payer ||
      current.requestDigest !== operation.requestDigest || current.approvalTxID !== operation.approvalTxID ||
      current.createdAtMs !== operation.createdAtMs || current.budgetUnits !== operation.budgetUnits ||
      !isDeepStrictEqual(current.plan, operation.plan) || !isDeepStrictEqual(current.request, operation.request))
    throw new Error("sponsor_immutable_operation_changed");
}
