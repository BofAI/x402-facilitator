import { describe, expect, it } from "vitest";
import type { Trc20SponsoringOperation } from "@bankofai/x402-tron";
import { hasUnresolvedResourceActions } from "../src/sponsoring/admission.js";

function operation(): Trc20SponsoringOperation {
  return { status: "sponsored_recovering", actions: [
    { kind: "delegate", resource: "ENERGY", status: "confirmed" },
    { kind: "approval", status: "confirmed" },
    { kind: "undelegate", resource: "ENERGY", status: "confirmed" },
  ], plan: { legs: [{ resource: "ENERGY" }] } } as Trc20SponsoringOperation;
}
describe("new admission while capacity debt remains reserved", () => {
  it("does not block new payers solely because confirmed reclaimed resources await regeneration", () => {
    expect(hasUnresolvedResourceActions(operation())).toBe(false);
  });
  it.each(["prepared", "submitted", "unknown"] as const)("blocks when any chain action remains %s", status => {
    const op = operation(); op.actions[2].status = status;
    expect(hasUnresolvedResourceActions(op)).toBe(true);
  });
  it("blocks a failed reclaim while its original delegation was confirmed", () => {
    const op = operation(); op.actions[2].status = "failed";
    expect(hasUnresolvedResourceActions(op)).toBe(true);
  });
  it("blocks a missing reclaim", () => {
    const op = operation(); op.actions = op.actions.slice(0, 2);
    expect(hasUnresolvedResourceActions(op)).toBe(true);
  });
  it("blocks business execution even if the currently recorded actions are confirmed", () => {
    const op = operation(); op.status = "approval_confirmed";
    expect(hasUnresolvedResourceActions(op)).toBe(true);
  });
  it("allows admission after a failed Approval with confirmed resource reclaim", () => {
    const op = operation(); op.status = "failed_recovering"; op.actions[1].status = "failed";
    expect(hasUnresolvedResourceActions(op)).toBe(false);
  });
});
