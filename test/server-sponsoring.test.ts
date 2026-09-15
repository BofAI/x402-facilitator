import { beforeEach, describe, expect, it, vi } from "vitest";
import type { x402Facilitator } from "@bankofai/x402-core/facilitator";
import { createApp } from "../src/server.js";
import { setApiKeyCacheForTest } from "../src/auth.js";
import { resetRateLimitState } from "../src/rate-limit.js";
import type { SponsoringService } from "../src/sponsoring/service.js";

describe("resource sponsoring HTTP boundary", () => {
  it.each(["/verify", "/settle"])("returns HTTP 503 and Retry-After for runtime owner contention on %s", async route => {
    const payTo = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
    const facilitator = { verify: async () => ({ isValid: false, invalidReason: "sponsor_owner_busy" }),
      settle: async () => ({ success: false, errorReason: "sponsor_owner_busy" }), getSupported: () => ({}) };
    const sponsoring = { access: () => ({ network: "tron:3448148188", ready: true, payTo: [payTo] }) } as SponsoringService;
    const app = createApp(facilitator as unknown as x402Facilitator, { rateLimit: { authenticated: "1000/minute", anonymous: "1000/minute" },
      gasfreeSettings: () => null, metricsOnMainPort: false, metricsEndpoint: "/metrics", maxRequestBodyBytes: 100000, sponsoring });
    const requirements = { network: "tron:3448148188", scheme: "exact", asset: "token", amount: "1", payTo, maxTimeoutSeconds: 600 };
    const response = await app.request(route, { method: "POST", headers: { "content-type": "application/json", "X-API-KEY": "test-key" },
      body: JSON.stringify({ paymentRequirements: requirements, paymentPayload: { x402Version: 2, accepted: requirements, payload: {},
        extensions: { trc20ApprovalResourceSponsoring: {} } } }) });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
  });
  beforeEach(() => { setApiKeyCacheForTest(["test-key"]); resetRateLimitState(); });
  it.each(["/verify", "/settle"])("rejects unauthenticated %s before executing SDK", async route => {
    const facilitator = { verify: vi.fn(), settle: vi.fn(), getSupported: () => ({}) };
    const app = createApp(facilitator as unknown as x402Facilitator, { rateLimit: { authenticated: "1000/minute", anonymous: "1000/minute" },
      gasfreeSettings: () => null, metricsOnMainPort: false, metricsEndpoint: "/metrics", maxRequestBodyBytes: 100000 });
    const requirements = { network: "tron:3448148188", scheme: "exact", asset: "token", amount: "1", payTo: "receiver", maxTimeoutSeconds: 600 };
    const response = await app.request(route, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentRequirements: requirements, paymentPayload: { x402Version: 2, accepted: requirements, payload: {},
        extensions: { trc20ApprovalResourceSponsoring: {} } } }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject(route === "/verify" ? { invalidReason: "sponsor_auth_required" } : { errorReason: "sponsor_auth_required" });
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
  it("returns retryable recovery status without executing settlement", async () => {
    const payTo = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
    const facilitator = { verify: vi.fn(), settle: vi.fn(), getSupported: () => ({}) };
    const sponsoring = { access: () => ({ network: "tron:3448148188", ready: false, payTo: [payTo] }),
      readiness: () => ({ ready: false, mode: "RECOVERING", network: "tron:3448148188" }) } as SponsoringService;
    const app = createApp(facilitator as unknown as x402Facilitator, { rateLimit: { authenticated: "1000/minute", anonymous: "1000/minute" },
      gasfreeSettings: () => null, metricsOnMainPort: false, metricsEndpoint: "/metrics", maxRequestBodyBytes: 100000, sponsoring });
    const requirements = { network: "tron:3448148188", scheme: "exact", asset: "token", amount: "1", payTo, maxTimeoutSeconds: 600 };
    const response = await app.request("/settle", { method: "POST", headers: { "content-type": "application/json", "X-API-KEY": "test-key" },
      body: JSON.stringify({ paymentRequirements: requirements, paymentPayload: { x402Version: 2, accepted: requirements, payload: {},
        extensions: { trc20ApprovalResourceSponsoring: {} } } }) });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("15");
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect((await app.request("/sponsoring/ready")).status).toBe(503);
  });
});
