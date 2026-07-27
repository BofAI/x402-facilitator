/**
 * P2-01 unified network registry: normalization, family lookup, and the
 * canonical/alias equivalence that closes P0-04 and P1-10.
 */
import { describe, expect, it } from "vitest";
import { normalize, familyOf, rpcFor, chainIdOf } from "../src/network.js";

describe("network registry normalize", () => {
  it.each([
    ["bsc:testnet", "eip155:97"],
    ["bsc:mainnet", "eip155:56"],
    ["eip155:97", "eip155:97"],
    ["eip155:56", "eip155:56"],
    ["base:mainnet", "eip155:8453"],
    ["base-mainnet", "eip155:8453"],
    ["base:sepolia", "eip155:84532"],
    ["base-sepolia", "eip155:84532"],
    ["eip155:8453", "eip155:8453"],
    ["eip155:84532", "eip155:84532"],
    ["tron:mainnet", "tron:0x2b6653dc"],
    ["tron:nile", "tron:0xcd8690dc"],
    ["tron:shasta", "tron:0x94a9059e"],
    ["tron:0x2b6653dc", "tron:0x2b6653dc"],
    ["tron:0xcd8690dc", "tron:0xcd8690dc"],
  ])("normalizes %s -> %s (alias and canonical resolve to the same key)", (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it("throws on unknown networks (fail fast at startup)", () => {
    expect(() => normalize("foo:bar")).toThrow(/Unsupported or unknown network: foo:bar/);
    expect(() => normalize("eip155:999")).toThrow(/Unsupported or unknown network: eip155:999/);
    expect(() => normalize("tron:unknown")).toThrow(/Unsupported or unknown network: tron:unknown/);
  });
});

describe("network registry family lookup", () => {
  it("classifies TRON networks", () => {
    expect(familyOf(normalize("tron:nile"))).toBe("tron");
    expect(familyOf(normalize("tron:0x2b6653dc"))).toBe("tron");
  });

  it("classifies EVM networks", () => {
    expect(familyOf(normalize("bsc:testnet"))).toBe("evm");
    expect(familyOf(normalize("eip155:56"))).toBe("evm");
    expect(familyOf(normalize("base:sepolia"))).toBe("evm");
  });
});

describe("network registry rpc + chainId", () => {
  it("returns RPC endpoints", () => {
    expect(rpcFor(normalize("bsc:testnet"))).toBe("https://bsc-testnet-rpc.publicnode.com");
    expect(rpcFor(normalize("base:mainnet"))).toBe("https://mainnet.base.org");
    expect(rpcFor(normalize("base:sepolia"), "https://rpc.example")).toBe("https://rpc.example");
    expect(rpcFor(normalize("tron:nile"))).toBe("https://nile.trongrid.io");
  });

  it("returns chainId for EVM and undefined for TRON", () => {
    expect(chainIdOf(normalize("eip155:97"))).toBe(97);
    expect(chainIdOf(normalize("eip155:56"))).toBe(56);
    expect(chainIdOf(normalize("base:mainnet"))).toBe(8453);
    expect(chainIdOf(normalize("base:sepolia"))).toBe(84532);
    expect(chainIdOf(normalize("tron:0xcd8690dc"))).toBeUndefined();
  });
});
