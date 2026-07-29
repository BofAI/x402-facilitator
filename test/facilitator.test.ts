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

  const baseSigner = (addr: string) => ({
    getAddresses: () => [addr],
    readContract: vi.fn(),
    verifyTypedData: vi.fn(),
    writeContract: vi.fn(),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getCode: vi.fn(),
    sendTransactions: vi.fn(),
  });
  const evmSigner = baseSigner("0xfacilitator");
  const evmSigner97 = baseSigner("0xsigner97");
  const evmSigner56 = baseSigner("0xsigner56");

  return {
    FakeFacilitator,
    evmSigner,
    evmSigner97,
    evmSigner56,
    buildEvmFacilitatorSigner: vi.fn(async (canonical: string) =>
      canonical === "eip155:56" ? evmSigner56 : evmSigner97,
    ),
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
  // Keep the real canonical-network validation; only signer builders (real wallets)
  // are stubbed.
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
            "eip155:97": {
              schemes: ["exact", "upto", "batch-settlement"],
            },
          },
        },
      },
      { gasfreeBaseUrlFor: () => null },
    )) as InstanceType<typeof mocks.FakeFacilitator>;

    expect(mocks.buildEvmFacilitatorSigner).toHaveBeenCalledWith("eip155:97");
    expect(facilitator.extensions).toHaveLength(1);
    expect(facilitator.extensions[0].key).toBe("erc20ApprovalGasSponsoring");
    // The fallback signer is network-scoped, never an insertion-ordered arbitrary value.
    expect(facilitator.extensions[0].signer).toBe(mocks.evmSigner97);
    expect((facilitator.extensions[0].signerForNetwork as (network: string) => unknown)("eip155:97")).toBe(
      mocks.evmSigner97,
    );
  });

  it("P1-14: resolves the gas-sponsoring signer by canonical network, not insertion order", async () => {
    // Register mainnet FIRST to make insertion order != chain-id order; the
    // resolver must still map eip155:97 -> signer97 and eip155:56 -> signer56.
    const facilitator = (await buildFacilitator(
      {
        database: { url: "postgresql://localhost/test" },
        facilitator: {
          networks: {
            "eip155:56": { schemes: ["exact"] },
            "eip155:97": { schemes: ["exact"] },
          },
        },
      },
      { gasfreeBaseUrlFor: () => null },
    )) as InstanceType<typeof mocks.FakeFacilitator>;

    expect(facilitator.extensions).toHaveLength(1);
    const resolve = facilitator.extensions[0].signerForNetwork as (n: string) => unknown;
    // Canonical networks resolve to their own signer regardless of object order.
    expect(resolve("eip155:97")).toBe(mocks.evmSigner97);
    expect(resolve("eip155:56")).toBe(mocks.evmSigner56);
    // Unknown network throws instead of falling back to a default signer.
    expect(() => resolve("eip155:999")).toThrow(/No gas-sponsoring signer registered for network eip155:999/);
  });

  it("accepts canonical CAIP-2 ids in config", async () => {
    const facilitator = (await buildFacilitator(
      {
        database: { url: "postgresql://localhost/test" },
        facilitator: { networks: { "eip155:97": { schemes: ["exact"] } } },
      },
      { gasfreeBaseUrlFor: () => null },
    )) as InstanceType<typeof mocks.FakeFacilitator>;
    expect(mocks.buildEvmFacilitatorSigner).toHaveBeenCalledWith("eip155:97");
    expect(facilitator.extensions).toHaveLength(1);
  });

  it("registers Base Sepolia exact with the registry RPC", async () => {
    const facilitator = (await buildFacilitator(
      {
        database: { url: "postgresql://localhost/test" },
        facilitator: {
          networks: {
            "eip155:84532": {
              schemes: ["exact"],
            },
          },
        },
      },
      { gasfreeBaseUrlFor: () => null },
    )) as InstanceType<typeof mocks.FakeFacilitator>;

    expect(mocks.buildEvmFacilitatorSigner).toHaveBeenCalledWith("eip155:84532");
    expect(facilitator.registrations).toEqual([
      expect.objectContaining({ network: "eip155:84532" }),
    ]);
    expect(facilitator.extensions).toHaveLength(1);
  });

  it("rejects a non-canonical network id at startup", async () => {
    await expect(
      buildFacilitator(
        {
          database: { url: "postgresql://localhost/test" },
          facilitator: {
            networks: {
              "bsc:testnet": { schemes: ["exact"] },
            },
          },
        },
        { gasfreeBaseUrlFor: () => null },
      ),
    ).rejects.toThrow(/Unsupported canonical CAIP-2 network: bsc:testnet/);
  });

  it("rejects an unsupported canonical network id at startup", async () => {
    await expect(
      buildFacilitator(
        {
          database: { url: "postgresql://localhost/test" },
          facilitator: { networks: { "eip155:999": { schemes: ["exact"] } } },
        },
        { gasfreeBaseUrlFor: () => null },
      ),
    ).rejects.toThrow(/Unsupported canonical CAIP-2 network: eip155:999/);
  });

  it("passes the configured CAIP-2 directly to the TRON gasfree registration path", async () => {
    const gasfreeBaseUrlFor = vi.fn(
      (network: string) => (network === TRON_NILE ? "http://127.0.0.1:8001/nile" : null),
    );

    await buildFacilitator(
      {
        database: { url: "postgresql://localhost/test" },
        facilitator: {
          networks: {
            [TRON_NILE]: { schemes: ["exact"] },
          },
        },
      },
      { gasfreeBaseUrlFor },
    );

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
            [TRON_NILE]: { schemes: ["exact"] },
          },
        },
      },
      { gasfreeBaseUrlFor },
    );

    expect(vi.mocked(registerExactTronScheme)).toHaveBeenCalled();
    expect(vi.mocked(registerExactGasFreeTronScheme)).not.toHaveBeenCalled();
  });
});
