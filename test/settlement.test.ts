import { describe, expect, it } from "vitest";
import { extractPayerNonce } from "../src/settlement.js";

describe("extractPayerNonce", () => {
  it("extracts from an EIP-3009 payload (authorization.{from,nonce})", () => {
    expect(
      extractPayerNonce({
        signature: "0xsig",
        authorization: { from: "0xpayer", to: "0xto", value: "1", validAfter: "0", validBefore: "9", nonce: "0xabc" },
      }, "exact"),
    ).toEqual({ payer: "0xpayer", nonce: "0xabc" });
  });

  it("extracts from a Permit2 payload (permit2Authorization.{from,nonce})", () => {
    expect(
      extractPayerNonce({
        signature: "0xsig",
        permit2Authorization: { from: "0xowner", nonce: "42", spender: "0xspender", deadline: "9" },
      }, "exact"),
    ).toEqual({ payer: "0xowner", nonce: "42" });
  });

  it("extracts from a GasFree payload (gasfree.{user,nonce})", () => {
    expect(
      extractPayerNonce({
        signature: "0xsig",
        gasfree: { user: "TUser", nonce: "7", token: "TToken", value: "1" },
        gasfreeAddress: "TAddr",
      }, "exact_gasfree"),
    ).toEqual({ payer: "TUser", nonce: "7" });
  });

  it("extracts payer (null nonce) from a batch-settlement deposit/voucher/refund payload", () => {
    expect(
      extractPayerNonce({
        type: "voucher",
        channelConfig: { payer: "0xchanpayer", receiver: "0xrecv", token: "0xtok", salt: "0x01" },
        voucher: { channelId: "0xchan", maxClaimableAmount: "100", signature: "0xsig" },
      }, "batch-settlement"),
    ).toEqual({ payer: "0xchanpayer", nonce: null });
  });

  it("extracts payer (null nonce) from a batch-settlement claim payload (voucher.channel.payer)", () => {
    expect(
      extractPayerNonce({
        voucher: { channel: { payer: "0xclaimpayer", receiver: "0xrecv", token: "0xtok" }, maxClaimableAmount: "100" },
        signature: "0xsig",
        totalClaimed: "50",
      }, "batch-settlement"),
    ).toEqual({ payer: "0xclaimpayer", nonce: null });
  });

  it("ignores authorization fields unrelated to a batch settlement", () => {
    expect(extractPayerNonce({
      type: "settle", receiver: "TReceiver", token: "TToken",
      authorization: { from: "TUnrelatedPayer", nonce: "123" },
    }, "batch-settlement")).toBeNull();
  });

  it("returns null for unknown / empty payloads", () => {
    expect(extractPayerNonce(undefined, "exact")).toBeNull();
    expect(extractPayerNonce({}, "exact")).toBeNull();
    expect(extractPayerNonce({ authorization: { from: "0x" } }, "exact")).toBeNull(); // missing nonce
    expect(extractPayerNonce({ something: "else" }, "exact")).toBeNull();
  });
});
