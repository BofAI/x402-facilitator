import { describe, expect, it } from "vitest";
import { parseOpRef, isUsableToken } from "../src/onepassword.js";

describe("parseOpRef", () => {
  it("parses a valid vault/item/field reference", () => {
    expect(parseOpRef("vault/item/field")).toEqual({ vault: "vault", item: "item", field: "field" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseOpRef("  v / i / f ")).toEqual({ vault: "v", item: "i", field: "f" });
  });

  it("returns null for malformed references", () => {
    expect(parseOpRef("")).toBeNull();
    expect(parseOpRef("only/two")).toBeNull();
    expect(parseOpRef("a/b/c/d")).toBeNull();
    expect(parseOpRef("a//c")).toBeNull();
    expect(parseOpRef(undefined)).toBeNull();
  });
});

describe("isUsableToken", () => {
  it("accepts a real token and rejects placeholders/empties", () => {
    expect(isUsableToken("ops_realtoken")).toBe(true);
    expect(isUsableToken("your-op-token")).toBe(false);
    expect(isUsableToken("your-service-account-token")).toBe(false);
    expect(isUsableToken("")).toBe(false);
    expect(isUsableToken(undefined)).toBe(false);
  });
});
