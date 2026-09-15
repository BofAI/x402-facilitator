import type { Trc20ResourceLeg, Trc20ResourceSponsoringChain, Trc20SponsoringOperation, Trc20SponsoringCoordinator } from "@bankofai/x402-tron";
import { RecoverableChainError, ReclaimValidationError } from "./recovery-errors.js";

/** Timed-out business actions cannot hold resources hostage. Only query pairs
 * present in the local operation, and never reclaim more than its reservation. */
export async function recoverExpiredOperation(
  operation: Trc20SponsoringOperation,
  store: Pick<Trc20SponsoringCoordinator, "get" | "save">,
  chain: Trc20ResourceSponsoringChain,
  delegated: (operation: Trc20SponsoringOperation, leg: Trc20ResourceLeg) => Promise<bigint>,
): Promise<Trc20SponsoringOperation> {
  let current = (await store.get(operation.key))!;
  const errors: unknown[] = [];
  const pendingConfirmations: string[] = [];
  // Isolate chain failures, but let persistence failures stop all further writes.
  async function attempt<T>(action: () => Promise<T>): Promise<T | undefined> {
    try { return await action(); }
    catch (error) {
      if (!(error instanceof RecoverableChainError)) throw error;
      errors.push(error);
      return undefined;
    }
  }
  for (const leg of current.plan.legs) {
    const outstanding = await attempt(() => delegated(current, leg));
    if (outstanding === undefined) continue;
    if (outstanding < 0n || outstanding > leg.stakeSun) throw new Error("sponsor_capacity_inconsistent");
    if (outstanding === 0n) continue;
    let action = current.actions.find(action => action.kind === "undelegate" && action.resource === leg.resource);
    if (action?.status === "confirmed") throw new Error("sponsor_capacity_inconsistent");
    if (!action || action.status === "failed") {
      const prepared = await attempt(() => chain.prepareUndelegate(current.request, { ...leg, stakeSun: outstanding }));
      if (!prepared) continue;
      action = { ...prepared, kind: "undelegate", resource: leg.resource, status: "prepared" };
      current = await store.save({ ...current, status: "failed_recovering", recoveryStartedAtMs: current.recoveryStartedAtMs ?? Date.now(),
        actions: [...current.actions.filter(item => item.kind !== "undelegate" || item.resource !== leg.resource), action] });
    }
    if (action.status === "prepared") {
      let broadcastError: RecoverableChainError | ReclaimValidationError | undefined;
      try {
        const txID = await chain.broadcast(action);
        if (txID !== action.txID) throw new RecoverableChainError(new Error("broadcast_txid_mismatch"));
      } catch (error) {
        if (!(error instanceof RecoverableChainError) && !(error instanceof ReclaimValidationError)) throw error;
        broadcastError = error;
      }
      // The original txID may have reached TRON in this or an earlier process.
      action = { ...action, status: "unknown" };
      current = await store.save({ ...current, actions: current.actions.map(item => item.txID === action!.txID ? action! : item) });
      if (broadcastError instanceof ReclaimValidationError) throw broadcastError;
      if (broadcastError) { errors.push(broadcastError); continue; }
    }
    pendingConfirmations.push(action.txID);
  }
  // Receipt polling must not delay submission of the other resource's reclaim.
  for (const txID of pendingConfirmations) {
    const status = await attempt(() => chain.confirm(txID));
    if (status === undefined) continue;
    current = await store.save({ ...current, actions: current.actions.map(item => item.txID === txID ? { ...item, status } : item) });
  }
  // The SDK creates the Approval action at admission, before any delegation.
  // A crash before broadcast can therefore leave it prepared indefinitely.
  // Only resolve it after expiry and a fresh allowance read through the chain
  // guard; never rebroadcast it or release the capacity debt here.
  const approval = current.actions.find(action => action.kind === "approval" && action.status === "prepared");
  if (approval && Number(current.request.approvalExpiration) <= Date.now()) {
    const status = await attempt(() => chain.confirm(approval.txID));
    if (status !== undefined) current = await store.save({ ...current,
      actions: current.actions.map(action => action.txID === approval.txID ? { ...action, status } : action) });
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new RecoverableChainError(new AggregateError(errors, "sponsor_recovery_incomplete"));
  return current;
}
