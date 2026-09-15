import type { Trc20SponsoringOperation } from "@bankofai/x402-tron";

/** A reclaimed operation can retain its capacity reservation without blocking
 * unrelated payers. Unknown transactions or unfinished reclaim still close admission. */
export function hasUnresolvedResourceActions(operation: Trc20SponsoringOperation): boolean {
  if (!["sponsored_recovering", "failed_recovering"].includes(operation.status)) return true;
  if (operation.actions.some(action => action.status !== "confirmed" && action.status !== "failed")) return true;
  return operation.plan.legs.some(leg => {
    const delegate = operation.actions.find(action => action.kind === "delegate" && action.resource === leg.resource);
    if (!delegate || delegate.status === "failed") return false;
    return !operation.actions.some(action => action.kind === "undelegate" && action.resource === leg.resource && action.status === "confirmed");
  });
}
