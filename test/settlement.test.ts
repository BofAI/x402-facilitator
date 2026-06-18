import { describe, expect, it } from "vitest";
import { extractPayerNonce } from "../src/settlement.js";

describe("extractPayerNonce", () => {
  it("extracts from an EIP-3009 payload (authorization.{from,nonce})", () => {
    expect(
      extractPayerNonce({
        signature: "0xsig",
        authorization: { from: "0xpayer", to: "0xto", value: "1", validAfter: "0", validBefore: "9", nonce: "0xabc" },
      }),
    ).toEqual({ payer: "0xpayer", nonce: "0xabc" });
  });

  it("extracts from a Permit2 payload (permit2Authorization.{from,nonce})", () => {
    expect(
      extractPayerNonce({
        signature: "0xsig",
        permit2Authorization: { from: "0xowner", nonce: "42", spender: "0xspender", deadline: "9" },
      }),
    ).toEqual({ payer: "0xowner", nonce: "42" });
  });

  it("extracts from a GasFree payload (gasfree.{user,nonce})", () => {
    expect(
      extractPayerNonce({
        signature: "0xsig",
        gasfree: { user: "TUser", nonce: "7", token: "TToken", value: "1" },
        gasfreeAddress: "TAddr",
      }),
    ).toEqual({ payer: "TUser", nonce: "7" });
  });

  it("returns null for unknown / empty payloads", () => {
    expect(extractPayerNonce(undefined)).toBeNull();
    expect(extractPayerNonce({})).toBeNull();
    expect(extractPayerNonce({ authorization: { from: "0x" } })).toBeNull(); // missing nonce
    expect(extractPayerNonce({ something: "else" })).toBeNull();
  });
});
