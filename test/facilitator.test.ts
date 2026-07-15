import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRON_NILE } from "@bankofai/x402-tron";
import { registerExactTronScheme } from "@bankofai/x402-tron/exact/facilitator";
import { registerExactGasFreeTronScheme } from "@bankofai/x402-tron/gasfree/facilitator";

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

vi.mock("../src/signer.js", async (importOriginal) => {
  // Keep the real `toCaip` so tests exercise the actual tron:nile -> hex CAIP-2
  // normalization; only the signer builders (which talk to real wallets) are stubbed.
  const actual = await importOriginal<typeof import("../src/signer.js")>();
  return {
    ...actual,
    buildEvmFacilitatorSigner: mocks.buildEvmFacilitatorSigner,
    buildEvmAuthorizerSigner: mocks.buildEvmAuthorizerSigner,
    buildTronFacilitatorSigner: mocks.buildTronFacilitatorSigner,
    buildTronAuthorizerSigner: mocks.buildTronAuthorizerSigner,
  };
});

const { buildFacilitator } = await import("../src/facilitator.js");

describe("buildFacilitator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("passes the normalized hex CAIP-2 to the TRON gasfree registration path", async () => {
    const gasfreeBaseUrlFor = vi.fn(
      (network: string) => (network === TRON_NILE ? "http://127.0.0.1:8001/nile" : null),
    );

    await buildFacilitator(
      {
        database: { url: "postgresql://localhost/test" },
        facilitator: {
          networks: {
            "tron:nile": { schemes: ["exact"] },
          },
        },
      },
      { gasfreeBaseUrlFor },
    );

    // toCaip normalizes "tron:nile" -> "tron:0xcd8690dc" (TRON_NILE) before it
    // reaches gasfreeBaseUrlFor and the scheme registrar.
    expect(gasfreeBaseUrlFor).toHaveBeenCalledWith(TRON_NILE);
    expect(vi.mocked(registerExactTronScheme)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ networks: TRON_NILE }),
    );
    expect(vi.mocked(registerExactGasFreeTronScheme)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        networks: TRON_NILE,
        apiBaseUrls: { [TRON_NILE]: "http://127.0.0.1:8001/nile" },
      }),
    );
  });

  it("skips exact_gasfree when gasfreeBaseUrlFor returns null", async () => {
    const gasfreeBaseUrlFor = vi.fn(() => null);

    await buildFacilitator(
      {
        database: { url: "postgresql://localhost/test" },
        facilitator: {
          networks: {
            "tron:nile": { schemes: ["exact"] },
          },
        },
      },
      { gasfreeBaseUrlFor },
    );

    expect(vi.mocked(registerExactTronScheme)).toHaveBeenCalled();
    expect(vi.mocked(registerExactGasFreeTronScheme)).not.toHaveBeenCalled();
  });
});
