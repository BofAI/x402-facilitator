import { describe, expect, it } from "vitest";
import { toCaip } from "../src/signer.js";

describe("toCaip", () => {
  it("maps EVM config aliases to eip155:<chainId>", () => {
    expect(toCaip("bsc:testnet")).toBe("eip155:97");
    expect(toCaip("bsc:mainnet")).toBe("eip155:56");
  });

  it("normalizes TRON friendly names to hex-chain-id CAIP-2 (SDK 1.0.1+)", () => {
    expect(toCaip("tron:mainnet")).toBe("tron:0x2b6653dc");
    expect(toCaip("tron:nile")).toBe("tron:0xcd8690dc");
    expect(toCaip("tron:shasta")).toBe("tron:0x94a9059e");
  });

  it("passes canonical CAIP-2 ids through unchanged", () => {
    expect(toCaip("tron:0x2b6653dc")).toBe("tron:0x2b6653dc");
    expect(toCaip("eip155:97")).toBe("eip155:97");
  });

  it("passes unknown namespaces through unchanged", () => {
    expect(toCaip("foo:bar")).toBe("foo:bar");
  });
});
