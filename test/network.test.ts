/**
 * Canonical CAIP-2 network registry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requireCanonicalNetwork,
  familyOf,
  rpcFor,
  receiptRpcFor,
  chainIdOf,
} from "../src/network.js";

afterEach(() => vi.unstubAllEnvs());

describe("network registry", () => {
  it.each([
    "eip155:97",
    "eip155:56",
    "eip155:8453",
    "eip155:84532",
    "tron:0x2b6653dc",
    "tron:0xcd8690dc",
    "tron:0x94a9059e",
  ])("accepts supported canonical CAIP-2 %s unchanged", input => {
    expect(requireCanonicalNetwork(input)).toBe(input);
  });

  it("rejects aliases and unknown networks", () => {
    expect(() => requireCanonicalNetwork("bsc:testnet")).toThrow(/Unsupported canonical CAIP-2 network/);
    expect(() => requireCanonicalNetwork("tron:nile")).toThrow(/Unsupported canonical CAIP-2 network/);
    expect(() => requireCanonicalNetwork("eip155:999")).toThrow(/Unsupported canonical CAIP-2 network/);
  });
});

describe("network registry family lookup", () => {
  it("classifies TRON networks", () => {
    expect(familyOf(requireCanonicalNetwork("tron:0xcd8690dc"))).toBe("tron");
    expect(familyOf(requireCanonicalNetwork("tron:0x2b6653dc"))).toBe("tron");
  });

  it("classifies EVM networks", () => {
    expect(familyOf(requireCanonicalNetwork("eip155:97"))).toBe("evm");
    expect(familyOf(requireCanonicalNetwork("eip155:56"))).toBe("evm");
    expect(familyOf(requireCanonicalNetwork("eip155:84532"))).toBe("evm");
  });
});

describe("network registry rpc + chainId", () => {
  it("returns RPC endpoints", () => {
    expect(rpcFor(requireCanonicalNetwork("eip155:97"))).toBe("https://bsc-testnet-rpc.publicnode.com");
    expect(rpcFor(requireCanonicalNetwork("eip155:56"))).toBe("https://bsc-dataseed.bnbchain.org");
    expect(receiptRpcFor(requireCanonicalNetwork("eip155:56"))).toBe(
      "https://bsc-dataseed-public.bnbchain.org",
    );
    expect(rpcFor(requireCanonicalNetwork("eip155:8453"))).toBe("https://mainnet.base.org");
    expect(receiptRpcFor(requireCanonicalNetwork("eip155:8453"))).toBeUndefined();
    expect(rpcFor(requireCanonicalNetwork("tron:0xcd8690dc"))).toBe("https://nile.trongrid.io");
  });

  it("allows BSC mainnet primary and receipt RPC environment overrides", () => {
    vi.stubEnv("BSC_MAINNET_RPC_URL", "https://primary.example");
    vi.stubEnv("BSC_MAINNET_RECEIPT_RPC_URL", "https://receipt.example");
    const network = requireCanonicalNetwork("eip155:56");

    expect(rpcFor(network)).toBe("https://primary.example");
    expect(receiptRpcFor(network)).toBe("https://receipt.example");
  });

  it("returns chainId for EVM and undefined for TRON", () => {
    expect(chainIdOf(requireCanonicalNetwork("eip155:97"))).toBe(97);
    expect(chainIdOf(requireCanonicalNetwork("eip155:56"))).toBe(56);
    expect(chainIdOf(requireCanonicalNetwork("eip155:8453"))).toBe(8453);
    expect(chainIdOf(requireCanonicalNetwork("eip155:84532"))).toBe(84532);
    expect(chainIdOf(requireCanonicalNetwork("tron:0xcd8690dc"))).toBeUndefined();
  });
});
