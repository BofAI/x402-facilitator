import { describe, expect, it, vi } from "vitest";
import type { GasSponsoringFacilitatorEvmSigner } from "@bankofai/x402-evm/adapters/agent-wallet";
import { withReceiptFallback, type ReceiptWaiter } from "../src/evm-receipt.js";

const HASH = `0x${"ab".repeat(32)}` as `0x${string}`;

function signer(): GasSponsoringFacilitatorEvmSigner {
  return {
    getAddresses: () => ["0x0000000000000000000000000000000000000001"],
    readContract: vi.fn(),
    verifyTypedData: vi.fn(),
    writeContract: vi.fn(),
    sendTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getCode: vi.fn(),
    sendTransactions: vi.fn(),
  };
}

describe("withReceiptFallback", () => {
  it("returns the primary receipt without calling fallback", async () => {
    const primary = vi.fn<ReceiptWaiter>().mockResolvedValue({ status: "success" });
    const fallback = vi.fn<ReceiptWaiter>().mockResolvedValue({ status: "success" });
    const wrapped = withReceiptFallback(signer(), {
      network: "eip155:56",
      primary,
      fallback,
    });

    await expect(wrapped.waitForTransactionReceipt({ hash: HASH })).resolves.toEqual({
      status: "success",
    });
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses fallback for the same hash when primary receipt RPC rejects", async () => {
    const primary = vi.fn<ReceiptWaiter>().mockRejectedValue(new Error("primary unavailable"));
    const fallback = vi.fn<ReceiptWaiter>().mockResolvedValue({ status: "success" });
    const wrapped = withReceiptFallback(signer(), {
      network: "eip155:56",
      primary,
      fallback,
    });

    await expect(wrapped.waitForTransactionReceipt({ hash: HASH })).resolves.toEqual({
      status: "success",
    });
    expect(primary).toHaveBeenCalledWith(HASH);
    expect(fallback).toHaveBeenCalledWith(HASH);
  });

  it("does not consult fallback for a terminal reverted receipt", async () => {
    const primary = vi.fn<ReceiptWaiter>().mockResolvedValue({ status: "reverted" });
    const fallback = vi.fn<ReceiptWaiter>().mockResolvedValue({ status: "success" });
    const wrapped = withReceiptFallback(signer(), {
      network: "eip155:56",
      primary,
      fallback,
    });

    await expect(wrapped.waitForTransactionReceipt({ hash: HASH })).resolves.toEqual({
      status: "reverted",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("throws a bounded error containing the hash when both RPCs reject", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const primary = vi.fn<ReceiptWaiter>().mockRejectedValue(
      new Error("URL: https://primary.example/secret"),
    );
    const fallback = vi.fn<ReceiptWaiter>().mockRejectedValue(
      new Error("URL: https://fallback.example"),
    );
    const wrapped = withReceiptFallback(signer(), {
      network: "eip155:56",
      primary,
      fallback,
    });

    await expect(wrapped.waitForTransactionReceipt({ hash: HASH })).rejects.toThrow(
      `Receipt confirmation failed on primary and fallback RPC for ${HASH}`,
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("primary.example");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("fallback.example");
  });

  it("preserves all signer broadcast methods", () => {
    const original = signer();
    const wrapped = withReceiptFallback(original, {
      network: "eip155:56",
      primary: vi.fn<ReceiptWaiter>(),
      fallback: vi.fn<ReceiptWaiter>(),
    });

    expect(wrapped.writeContract).toBe(original.writeContract);
    expect(wrapped.sendTransaction).toBe(original.sendTransaction);
    expect(wrapped.sendTransactions).toBe(original.sendTransactions);
  });
});
