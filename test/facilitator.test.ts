import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeFacilitator {
    registrations: Array<{ network: string; scheme: unknown }> = [];
    extensions: Array<Record<string, unknown>> = [];

    register(network: string, scheme: unknown): FakeFacilitator {
      this.registrations.push({ network, scheme });
      return this;
    }

    registerExtension(extension: Record<string, unknown>): FakeFacilitator {
      this.extensions.push(extension);
      return this;
    }
  }

  const evmSigner = {
    getAddresses: () => ["0xfacilitator"],
    readContract: vi.fn(),
    verifyTypedData: vi.fn(),
    writeContract: vi.fn(),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getCode: vi.fn(),
    sendTransactions: vi.fn(),
  };

  return {
    FakeFacilitator,
    evmSigner,
    buildEvmFacilitatorSigner: vi.fn(async () => evmSigner),
    buildEvmAuthorizerSigner: vi.fn(async () => ({
      address: "0xauthorizer",
      signTypedData: vi.fn(),
    })),
    buildTronFacilitatorSigner: vi.fn(),
    buildTronAuthorizerSigner: vi.fn(),
  };
});

vi.mock("@bankofai/x402-core/facilitator", () => ({
  x402Facilitator: mocks.FakeFacilitator,
}));

vi.mock("@bankofai/x402-core", () => ({
  createFacilitator: () => new mocks.FakeFacilitator(),
}));

vi.mock("@bankofai/x402-tron/exact/facilitator", () => ({
  registerExactTronScheme: vi.fn(),
}));

vi.mock("@bankofai/x402-tron/gasfree/facilitator", () => ({
  registerExactGasFreeTronScheme: vi.fn(),
}));

vi.mock("@bankofai/x402-tron/upto/facilitator", () => ({
  UptoTronScheme: class {},
}));

vi.mock("@bankofai/x402-tron/batch-settlement/facilitator", () => ({
  BatchSettlementTronScheme: class {},
}));

vi.mock("@bankofai/x402-evm/exact/facilitator", () => ({
  registerExactEvmScheme: vi.fn((facilitator, { signer, networks }) => {
    facilitator.register(networks, { scheme: "exact", signer });
  }),
}));

vi.mock("@bankofai/x402-evm/upto/facilitator", () => ({
  UptoEvmScheme: class {
    readonly scheme = "upto";
  },
}));

vi.mock("@bankofai/x402-evm/batch-settlement/facilitator", () => ({
  BatchSettlementEvmScheme: class {
    readonly scheme = "batch-settlement";
  },
}));

vi.mock("@bankofai/x402-extensions", () => ({
  createErc20ApprovalGasSponsoringExtension: vi.fn((signer, signerForNetwork) => ({
    key: "erc20ApprovalGasSponsoring",
    signer,
    signerForNetwork,
  })),
}));

vi.mock("../src/signer.js", () => ({
  buildEvmFacilitatorSigner: mocks.buildEvmFacilitatorSigner,
  buildEvmAuthorizerSigner: mocks.buildEvmAuthorizerSigner,
  buildTronFacilitatorSigner: mocks.buildTronFacilitatorSigner,
  buildTronAuthorizerSigner: mocks.buildTronAuthorizerSigner,
  toCaip: vi.fn((network: string) => (network === "bsc:testnet" ? "eip155:97" : network)),
}));

const { buildFacilitator } = await import("../src/facilitator.js");

describe("buildFacilitator", () => {
  it("registers the ERC-20 approval gas-sponsoring extension for BSC/EVM networks", async () => {
    const facilitator = (await buildFacilitator(
      {
        database: { url: "postgresql://localhost/test" },
        facilitator: {
          networks: {
            "bsc:testnet": {
              schemes: ["exact", "upto", "batch-settlement"],
            },
          },
        },
      },
      { gasfreeBaseUrlFor: () => null },
    )) as InstanceType<typeof mocks.FakeFacilitator>;

    expect(mocks.buildEvmFacilitatorSigner).toHaveBeenCalledWith("bsc:testnet");
    expect(facilitator.extensions).toHaveLength(1);
    expect(facilitator.extensions[0].key).toBe("erc20ApprovalGasSponsoring");
    expect(facilitator.extensions[0].signer).toBe(mocks.evmSigner);
    expect((facilitator.extensions[0].signerForNetwork as (network: string) => unknown)("eip155:97")).toBe(
      mocks.evmSigner,
    );
  });
});
