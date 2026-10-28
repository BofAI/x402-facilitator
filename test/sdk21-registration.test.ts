import { describe, expect, it, vi } from "vitest";
import { x402Facilitator } from "@x402/core/facilitator";
import type { SponsoringService } from "../src/sponsoring/service.js";
import type { FacilitatorConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

const signers = vi.hoisted(() => {
  const base = {
    readContract: vi.fn(async () => 0n), verifyTypedData: vi.fn(async () => true),
    writeContract: vi.fn(), sendTransaction: vi.fn(), waitForTransactionReceipt: vi.fn(),
    getCode: vi.fn(async () => "0x"), sendTransactions: vi.fn(),
  };
  return {
    tron: { ...base, getAddresses: () => ["TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"] },
    evm: { ...base, getAddresses: () => ["0x1111111111111111111111111111111111111111"] },
  };
});
vi.mock("../src/signer.js", () => ({
  buildTronFacilitatorSigner: async () => signers.tron,
  buildTronAuthorizerSigner: async () => ({ address: signers.tron.getAddresses()[0], signTypedData: vi.fn() }),
  buildEvmFacilitatorSigner: async () => signers.evm,
  buildEvmAuthorizerSigner: async () => ({ address: signers.evm.getAddresses()[0], signTypedData: vi.fn() }),
}));
const { buildFacilitator } = await import("../src/facilitator.js");
const config: FacilitatorConfig = { database: { url: "unused" }, facilitator: { networks: {
  "tron:3448148188": { schemes: ["exact", "upto", "batch-settlement"] },
  "eip155:84532": { schemes: ["exact", "upto", "batch-settlement"] },
} } };

describe("official Core service registration", () => {
  it("uses the official Core instance for all registered TRON and EVM schemes", async () => {
    const facilitator = await buildFacilitator(config, { gasfreeBaseUrlFor: () => null });
    expect(facilitator).toBeInstanceOf(x402Facilitator);
    const supported = facilitator.getSupported();
    expect(supported.kinds.map(({ network, scheme, x402Version }) => ({ network, scheme, x402Version })))
      .toHaveLength(6);
    expect(supported.kinds.every(kind => kind.x402Version === 2 && Object.hasOwn(config.facilitator.networks, kind.network))).toBe(true);
    for (const network of ["tron:3448148188", "eip155:84532"])
      for (const scheme of ["exact", "upto", "batch-settlement"])
        expect(supported.kinds).toContainEqual(expect.objectContaining({ network, scheme, x402Version: 2 }));
  });
  it("advertises only the configured EVM v2 network when exact is enabled", async () => {
    const facilitator = await buildFacilitator({ database: { url: "unused" }, facilitator: {
      networks: { "eip155:84532": { schemes: ["exact"] } },
    } }, { gasfreeBaseUrlFor: () => null });
    expect(facilitator.getSupported().kinds.map(({ network, scheme, x402Version }) => ({ network, scheme, x402Version })))
      .toEqual([{ network: "eip155:84532", scheme: "exact", x402Version: 2 }]);
  });
  it("keeps malformed EIP3009 verification a protocol failure instead of HTTP 500", async () => {
    const facilitator = await buildFacilitator({ database: { url: "unused" }, facilitator: {
      networks: { "eip155:84532": { schemes: ["exact"] } },
    } }, { gasfreeBaseUrlFor: () => null });
    const app = createApp(facilitator, { rateLimit: { authenticated: "10000/minute", anonymous: "10000/minute" },
      gasfreeSettings: () => null, metricsOnMainPort: false, metricsEndpoint: "/metrics", maxRequestBodyBytes: 1024 });
    const requirements = { scheme: "exact", network: "eip155:84532", amount: "1",
      asset: "0x2222222222222222222222222222222222222222", payTo: signers.evm.getAddresses()[0],
      maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
    const response = await app.request("http://localhost/verify", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({
        paymentPayload: { x402Version: 2, accepted: requirements, payload: {} }, paymentRequirements: requirements,
      }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isValid: false, invalidReason: "invalid_exact_evm_unexpected_error" });
    expect(signers.evm.writeContract).not.toHaveBeenCalled();
  });
  it.each(["permit2", "eip3009"])("rejects missing TRON %s authorization as a verification result", async method => {
    const facilitator = await buildFacilitator({ database: { url: "unused" }, facilitator: {
      networks: { "tron:3448148188": { schemes: ["exact"] } },
    } }, { gasfreeBaseUrlFor: () => null });
    const app = createApp(facilitator, { rateLimit: { authenticated: "10000/minute", anonymous: "10000/minute" },
      gasfreeSettings: () => null, metricsOnMainPort: false, metricsEndpoint: "/metrics", maxRequestBodyBytes: 2048 });
    const requirements = { scheme: "exact", network: "tron:3448148188", amount: "1",
      asset: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", payTo: signers.tron.getAddresses()[0],
      maxTimeoutSeconds: 300, extra: { assetTransferMethod: method } };
    const response = await app.request("http://localhost/verify", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({
        paymentPayload: { x402Version: 2, accepted: requirements, payload: { signature: `0x${"0".repeat(130)}` } },
        paymentRequirements: requirements,
      }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isValid: false, invalidReason: "invalid_exact_tron_payload_authorization" });
    expect(signers.tron.writeContract).not.toHaveBeenCalled();
  });
  it("registers the independent resource extension's validation and execution callbacks", async () => {
    const runtime = { verify: vi.fn(), sponsor: vi.fn() };
    const service = { runtime, access: () => ({ network: "tron:3448148188", ready: true }) } as unknown as SponsoringService;
    const facilitator = await buildFacilitator(config, { gasfreeBaseUrlFor: () => null, sponsoring: [service] });
    const extension = facilitator.getExtension("trc20ApprovalResourceSponsoring");
    expect(extension).toEqual(expect.objectContaining({ verifyPayment: expect.any(Function), executePayment: expect.any(Function) }));
  });
});
