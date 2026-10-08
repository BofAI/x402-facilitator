import { setTimeout as sleep } from "node:timers/promises";
import type { PreparedTronAction, Trc20ApprovalResourceSponsoringRequest, Trc20ResourceSponsoringChain, Trc20SponsoringOperation } from "@bankofai/x402-tron";
import type { SponsoringCoordinator } from "./coordinator.js";
import { RecoverableChainError, ReclaimValidationError, SponsoringStorageError,
  storageBoundary } from "./recovery-errors.js";

type Store = Pick<SponsoringCoordinator, "findAction" | "findApproval" | "deadlines" | "noteDelegate" | "assertOwnership">;
interface Timing {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  approvalPollMs?: number;
  confirmationTimeoutMs?: number;
  assertReclaim?: (request: Trc20ApprovalResourceSponsoringRequest, action: PreparedTronAction) => Promise<void>;
}

/** SDK confirm() is action-aware here: Approval completion means allowance
 * observed on FullNode, whereas resource actions retain solidified receipts. */
export function guardSponsoringChain(base: Trc20ResourceSponsoringChain, store: Store, timing: Timing = {}): Trc20ResourceSponsoringChain {
  const now = timing.now ?? Date.now;
  const delay = timing.sleep ?? sleep;
  async function assertActive(operation: Trc20SponsoringOperation) {
    const deadlines = await storageBoundary(() => store.deadlines(operation.key));
    if (now() >= deadlines.businessDeadline ||
        ["reclaiming", "failed_recovering", "sponsored_recovering", "recovered"].includes(operation.status))
      throw new Error("sponsor_operation_timeout");
    return deadlines.businessDeadline;
  }
  return {
    ...base,
    async prepareDelegate(request, leg) {
      await storageBoundary(() => store.assertOwnership());
      return base.prepareDelegate(request, leg);
    },
    async prepareUndelegate(request, leg) {
      await storageBoundary(() => store.assertOwnership());
      return base.prepareUndelegate(request, leg);
    },
    async broadcast(action) {
      const operation = await storageBoundary(() => store.findAction(action.txID));
      const saved = operation?.actions.find(saved => saved.txID === action.txID);
      if (!operation || !saved || saved.signedTransaction !== action.signedTransaction)
        throw new Error("sponsor_action_mismatch");
      let deadline: number | undefined;
      if (saved.kind === "undelegate" && timing.assertReclaim) {
        try { await timing.assertReclaim(operation.request, action); }
        catch (error) {
          if (error instanceof RecoverableChainError || error instanceof SponsoringStorageError) throw error;
          throw new ReclaimValidationError(error);
        }
      }
      if (saved.kind !== "undelegate") {
        deadline = await assertActive(operation);
        await storageBoundary(() => store.noteDelegate(operation.key, now()));
      }
      await storageBoundary(() => store.assertOwnership());
      if (deadline !== undefined && now() >= deadline) throw new Error("sponsor_operation_timeout");
      return base.broadcast(action);
    },
    async broadcastApproval(bytes) {
      const operation = await storageBoundary(() => store.findApproval(bytes));
      const action = operation?.actions.find(action => action.kind === "approval");
      if (!operation || !action || action.signedTransaction !== bytes) throw new Error("sponsor_action_mismatch");
      const deadline = await assertActive(operation);
      await storageBoundary(() => store.assertOwnership());
      if (now() >= deadline) throw new Error("sponsor_operation_timeout");
      return base.broadcastApproval(bytes);
    },
    async confirm(txID) {
      const operation = await storageBoundary(() => store.findAction(txID));
      if (!operation || txID !== operation.approvalTxID) return base.confirm(txID);
      const deadline = Math.min(now() + (timing.confirmationTimeoutMs ?? 90_000),
        (await storageBoundary(() => store.deadlines(operation.key))).businessDeadline, Number(operation.request.approvalExpiration));
      do {
        if (await base.allowanceSufficient(operation.request)) return "confirmed";
        if (now() >= Number(operation.request.approvalExpiration)) return "failed";
        if (now() >= deadline) return "unknown";
        await delay(Math.min(timing.approvalPollMs ?? 3000, deadline - now()));
      } while (now() <= deadline);
      return "unknown";
    },
  };
}
