import { describe, expect, it } from "vitest";
import { requireCanonicalNetwork } from "../src/network.js";

describe("canonical network validation", () => {
  it("passes canonical CAIP-2 ids through unchanged", () => {
    expect(requireCanonicalNetwork("tron:0x2b6653dc")).toBe("tron:0x2b6653dc");
    expect(requireCanonicalNetwork("eip155:97")).toBe("eip155:97");
  });

  it("rejects aliases and unknown networks", () => {
    expect(() => requireCanonicalNetwork("bsc:testnet")).toThrow(/Unsupported canonical CAIP-2 network/);
    expect(() => requireCanonicalNetwork("eip155:999")).toThrow(/Unsupported canonical CAIP-2 network/);
  });
});
