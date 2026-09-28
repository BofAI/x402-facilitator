import { describe, expect, it } from "vitest";
import { sponsoringAccessError } from "../src/sponsoring/access.js";
const requirements = { network: "tron:0xcd8690dc", payTo: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8" };
describe("resource sponsoring request gate", () => {
  it("permits anonymous Nile only when explicitly enabled and preserves other gates", () => {
    const extension = { trc20ApprovalResourceSponsoring: {} };
    const access = { network: "tron:3448148188", payTo: [requirements.payTo], ready: true, requireApiKey: false };
    expect(sponsoringAccessError(extension, requirements, false, access)).toBeUndefined();
    expect(sponsoringAccessError(extension, requirements, false, { ...access, requireApiKey: true })).toBe("sponsor_auth_required");
    expect(sponsoringAccessError(extension, requirements, false, { ...access, requireApiKey: undefined })).toBe("sponsor_auth_required");
    expect(sponsoringAccessError(extension, requirements, false, { ...access, ready: false })).toBe("sponsor_recovery_in_progress");
    expect(sponsoringAccessError(extension, { ...requirements, payTo: "other" }, false, access)).toBe("sponsor_pay_to_forbidden");
    expect(sponsoringAccessError(extension, { ...requirements, network: "tron:2494104990" }, false, access)).toBe("sponsor_auth_required");
    expect(sponsoringAccessError(extension, requirements, false, { ...access, network: "tron:2494104990" })).toBe("sponsor_auth_required");
    expect(sponsoringAccessError(extension, requirements, false)).toBe("sponsor_auth_required");
  });
  it("routes recovery retries to runtime while preserving authentication and receiver checks", () => {
    const extension = { trc20ApprovalResourceSponsoring: {} };
    const access = { network: requirements.network, payTo: [requirements.payTo], ready: false, canRetryExisting: true };
    expect(sponsoringAccessError(extension, requirements, true, access)).toBeUndefined();
    expect(sponsoringAccessError(extension, requirements, false, access)).toBe("sponsor_auth_required");
    expect(sponsoringAccessError(extension, { ...requirements, payTo: "other" }, true, access)).toBe("sponsor_pay_to_forbidden");
  });
  it("leaves ordinary payments unchanged and requires authentication for the extension", () => {
    expect(sponsoringAccessError({}, requirements, false)).toBeUndefined();
    expect(sponsoringAccessError({ trc20ApprovalResourceSponsoring: {} }, requirements, false)).toBe("sponsor_auth_required");
    expect(sponsoringAccessError({ trc20ApprovalResourceSponsoring: {} }, requirements, true)).toBe("sponsor_network_disabled");
  });
  it("checks readiness and the local shard's receiver allowlist", () => {
    const extension = { trc20ApprovalResourceSponsoring: {} };
    const access = { network: requirements.network, payTo: [requirements.payTo], ready: true };
    expect(sponsoringAccessError(extension, requirements, true, access)).toBeUndefined();
    expect(sponsoringAccessError(extension, { ...requirements, network: "eip155:97" }, true, access)).toBe("sponsor_network_disabled");
    expect(sponsoringAccessError(extension, requirements, true, { ...access, ready: false })).toBe("sponsor_recovery_in_progress");
    expect(sponsoringAccessError(extension, { ...requirements, payTo: "other" }, true, access)).toBe("sponsor_pay_to_forbidden");
  });
});
