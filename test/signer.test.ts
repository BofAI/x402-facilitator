import { describe, expect, it } from "vitest";
import { normalize } from "../src/network.js";

describe("normalize", () => {
  it("maps EVM config aliases to canonical eip155:<chainId>", () => {
    expect(normalize("bsc:testnet")).toBe("eip155:97");
    expect(normalize("bsc:mainnet")).toBe("eip155:56");
  });

  it("normalizes TRON friendly names to hex-chain-id CAIP-2 (SDK 1.0.1+)", () => {
    expect(normalize("tron:mainnet")).toBe("tron:0x2b6653dc");
    expect(normalize("tron:nile")).toBe("tron:0xcd8690dc");
    expect(normalize("tron:shasta")).toBe("tron:0x94a9059e");
  });

  it("passes canonical CAIP-2 ids through unchanged", () => {
    expect(normalize("tron:0x2b6653dc")).toBe("tron:0x2b6653dc");
    expect(normalize("eip155:97")).toBe("eip155:97");
  });

  it("throws on unknown networks (fail fast at startup)", () => {
    expect(() => normalize("foo:bar")).toThrow(/Unsupported or unknown network: foo:bar/);
    expect(() => normalize("eip155:999")).toThrow(/Unsupported or unknown network: eip155:999/);
  });
});
