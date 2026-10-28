import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme as ExactClient } from "@x402/evm/exact/client";
import { ExactEvmScheme } from "../src/evm-exact.js";
import { createApp } from "../src/server.js";

describe("application EVM exact verification boundary", () => {
  it.each([false, true])("verifies real EIP3009 signatures and fails closed on RPC errors (unavailable=%s)", async unavailable => {
    const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
    const asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Official Base Sepolia USDC.
    const requirements = { scheme: "exact", network: "eip155:84532" as const, asset, amount: "1000",
      payTo: "0x3333333333333333333333333333333333333333", maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" } };
    const client = new x402Client().register(requirements.network, new ExactClient(account));
    const payment = await client.createPaymentPayload({ x402Version: 2, accepts: [requirements],
      resource: { url: "http://localhost/paid" } });
    const write = vi.fn();
    const signer = {
      getAddresses: () => [requirements.payTo],
      getCode: vi.fn(async ({ address }: { address: string }) => {
        if (unavailable) throw new Error("RPC unavailable");
        return address.toLowerCase() === asset.toLowerCase() ? "0x6000" as const : "0x" as const;
      }),
      readContract: vi.fn(async () => {
        if (unavailable) throw new Error("RPC unavailable");
        return undefined;
      }),
      verifyTypedData: vi.fn(), writeContract: write, sendTransaction: write, waitForTransactionReceipt: vi.fn(),
    };
    const core = new x402Facilitator().register(requirements.network, new ExactEvmScheme(signer));
    const app = createApp(core, { rateLimit: { authenticated: "10000/minute", anonymous: "10000/minute" },
      gasfreeSettings: () => null, metricsOnMainPort: false, metricsEndpoint: "/metrics", maxRequestBodyBytes: 10_000 });
    const response = await app.request("http://localhost/verify", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: payment, paymentRequirements: requirements }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isValid: !unavailable });
    expect(signer.getCode).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
