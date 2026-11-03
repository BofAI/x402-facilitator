import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, custom, encodeFunctionData, keccak256 } from "viem";
import type { EvmRpcClient } from "../src/evm-wallet.js";

const rpc = {
  getChainId: vi.fn(async () => 84532),
  getTransactionCount: vi.fn(async () => 7),
  estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })),
  estimateGas: vi.fn(async () => 50_000n),
  sendRawTransaction: vi.fn(async () => "0xabc" as const),
  readContract: vi.fn(async () => 1000n),
  verifyTypedData: vi.fn(async () => true),
  getCode: vi.fn(async () => "0x"),
  waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
};
let createAuthorizerEvmSigner: typeof import("../src/evm-wallet.js").createAuthorizerEvmSigner;
let createFacilitatorEvmSigner: typeof import("../src/evm-wallet.js").createFacilitatorEvmSigner;

const options = { network: "eip155:84532", client: rpc as unknown as EvmRpcClient };

const account = "0x1111111111111111111111111111111111111111" as const;
const recipient = "0x2222222222222222222222222222222222222222" as const;
const abi = [{ type: "function", name: "settle", stateMutability: "nonpayable", inputs: [], outputs: [] }] as const;

describe("service-owned EVM wallet overlay with official signer", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ createAuthorizerEvmSigner, createFacilitatorEvmSigner } = await import("../src/evm-wallet.js"));
  });
  it("uses the injected RPC client for signing and broadcasting", async () => {
    const client = { ...rpc, sendRawTransaction: vi.fn(async () => "0xdef" as const) };
    const signer = await createFacilitatorEvmSigner({
      getAddress: () => "0x6666666666666666666666666666666666666666",
      signTransaction: async () => "0x1234",
    }, { ...options, client: client as unknown as EvmRpcClient });
    expect(await signer.sendTransaction({ to: recipient, data: "0x" })).toBe("0xdef");
    expect(client.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: "0x1234" });
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("uses pending nonce, EIP1559 fields, sender simulation and suffix without exposing wallet keys", async () => {
    const sign = vi.fn(async () => ({ family: "evm", rawTransaction: "1234" }));
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: sign }, options);
    await signer.readContract({ address: recipient, abi, functionName: "settle", args: [] });
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ account }));
    const hash = await signer.writeContract({ address: recipient, abi, functionName: "settle", args: [], dataSuffix: "0xbeef" });
    const data = `${encodeFunctionData({ abi, functionName: "settle" })}beef`;
    expect(rpc.getTransactionCount).toHaveBeenCalledWith({ address: account, blockTag: "pending" });
    expect(rpc.estimateGas).toHaveBeenCalledWith({ account, to: recipient, data, value: 0n });
    expect(sign).toHaveBeenCalledWith({ to: recipient, data, value: 0n, nonce: 7, gas: 50_000n,
      maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, chainId: 84532 });
    expect(rpc.sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: "0x1234" });
    expect(hash).toBe("0xabc");
  });
  it("broadcasts client Approval unchanged, then signs settlement with its supplied gas", async () => {
    const sign = vi.fn(async () => "0x5678");
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: sign }, options);
    expect(await signer.sendTransactions(["0x1234", { to: recipient, data: "0xabcd", gas: 90_000n }])).toEqual(["0xabc", "0xabc"]);
    expect(rpc.sendRawTransaction.mock.calls.map(([args]) => args.serializedTransaction)).toEqual(["0x1234", "0x5678"]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ gas: 90_000n }));
    expect(rpc.estimateGas).not.toHaveBeenCalled();
  });
  it("rejects a wrong-family artifact before any broadcast", async () => {
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account,
      signTransaction: async () => ({ family: "tron", rawTransaction: "abcd" }) }, options);
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).rejects.toThrow("EVM signed transaction artifact");
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("preserves the authorizer signature prefix expected by official batch settlement", async () => {
    const sign = vi.fn(async () => "abcd");
    const signer = await createAuthorizerEvmSigner({ getAddress: () => account, signTypedData: sign });
    const typed = { domain: { chainId: 84532 }, types: { Claim: [{ name: "amount", type: "uint256" }] },
      primaryType: "Claim", message: { amount: 1n } };
    expect(await signer.signTypedData(typed)).toBe("0xabcd");
    expect(sign).toHaveBeenCalledWith(typed);
  });

  it("reserves distinct nonces across concurrent signers sharing a wallet", async () => {
    const nonces: number[] = [];
    const wallet = { getAddress: () => "0x3333333333333333333333333333333333333333",
      signTransaction: vi.fn(async (args: { nonce: number }) => { nonces.push(args.nonce); return "0x1234"; }) };
    const first = await createFacilitatorEvmSigner(wallet, options);
    const second = await createFacilitatorEvmSigner(wallet, options);
    await Promise.all([first.sendTransaction({ to: recipient, data: "0x" }),
      second.sendTransaction({ to: recipient, data: "0x" })]);
    expect(nonces).toEqual([7, 8]);
  });

  it("blocks new signing after an ambiguous broadcast until the pending nonce advances", async () => {
    const sign = vi.fn(async () => "0x1234");
    const signer = await createFacilitatorEvmSigner({ getAddress: () => "0x4444444444444444444444444444444444444444",
      signTransaction: sign }, options);
    rpc.sendRawTransaction.mockRejectedValueOnce(new Error("connection lost"))
      .mockRejectedValueOnce(new Error("connection still lost"));
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).rejects.toThrow("connection lost");
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).rejects.toThrow("evm_nonce_reconciliation_required");
    expect(sign).toHaveBeenCalledTimes(1);
    rpc.getTransactionCount.mockResolvedValueOnce(8);
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).resolves.toBe("0xabc");
    expect(sign).toHaveBeenLastCalledWith(expect.objectContaining({ nonce: 8 }));
  });

  it.each([
    ["insufficient funds for gas * price + value", "0x7777777777777777777777777777777777777777"],
    ["max fee per gas less than block base fee", "0x8888888888888888888888888888888888888888"],
    ["transaction underpriced", "0x9999999999999999999999999999999999999999"],
  ])("reuses the nonce after an explicit RPC rejection: %s", async (message, address) => {
    let broadcasts = 0;
    const publicClient = createPublicClient({ transport: custom({ request: async () => {
      if (++broadcasts === 1) throw { code: -32000, message };
      return "0xabc";
    } }) });
    const sign = vi.fn<(args: { nonce: number }) => Promise<string>>(async () => "0x1234");
    const signer = await createFacilitatorEvmSigner({ getAddress: () => address, signTransaction: sign },
      { ...options, client: { ...rpc, sendRawTransaction: publicClient.sendRawTransaction } as unknown as EvmRpcClient });
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).rejects.toThrow(message);
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).resolves.toBe("0xabc");
    expect(sign.mock.calls.map(([args]) => args.nonce)).toEqual([7, 7]);
    expect(broadcasts).toBe(2);
  });

  it("restores a dropped transaction with identical bytes before allocating a later nonce", async () => {
    const sign = vi.fn(async ({ nonce }: { nonce: number }) => nonce === 7 ? "0x0700" : "0x0800");
    const wallet = { getAddress: () => account, signTransaction: sign };
    const first = await createFacilitatorEvmSigner(wallet, options);
    await first.sendTransaction({ to: recipient, data: "0x" });
    // Recreating the signer must retain the original transaction for the shared wallet.
    const second = await createFacilitatorEvmSigner(wallet, options);
    await second.sendTransaction({ to: recipient, data: "0xab" });
    expect(sign.mock.calls.map(([args]) => args.nonce)).toEqual([7, 8]);
    expect(rpc.sendRawTransaction.mock.calls.map(([args]) => args.serializedTransaction))
      .toEqual(["0x0700", "0x0700", "0x0800"]);
  });

  it("restores all retained transactions when the pending nonce falls backwards", async () => {
    let pending = 7;
    const client = { ...rpc, getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) => blockTag === "pending" ? pending : 7) };
    const sign = vi.fn(async ({ nonce }: { nonce: number }) => `0x0${nonce}00`);
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: sign },
      { ...options, client: client as unknown as EvmRpcClient });
    await signer.sendTransaction({ to: recipient, data: "0x" });
    pending = 8;
    await signer.sendTransaction({ to: recipient, data: "0x" });
    pending = 7;
    await signer.sendTransaction({ to: recipient, data: "0x" });
    expect(sign.mock.calls.map(([args]) => args.nonce)).toEqual([7, 8, 9]);
    expect(rpc.sendRawTransaction.mock.calls.map(([args]) => args.serializedTransaction))
      .toEqual(["0x0700", "0x0800", "0x0700", "0x0800", "0x0900"]);
  });

  it("blocks allocation when pending falls into an untracked earlier nonce gap", async () => {
    let pending = 7;
    const client = { ...rpc, getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) => blockTag === "pending" ? pending : 6) };
    const sign = vi.fn(async () => "0x0700");
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: sign },
      { ...options, client: client as unknown as EvmRpcClient });
    await signer.sendTransaction({ to: recipient, data: "0x" });
    pending = 6;
    await expect(signer.sendTransaction({ to: recipient, data: "0xab" })).rejects.toThrow("evm_nonce_reconciliation_required");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost broadcast response by resending the original signed transaction", async () => {
    const sign = vi.fn(async ({ nonce }: { nonce: number }) => nonce === 7 ? "0x0700" : "0x0800");
    rpc.sendRawTransaction.mockRejectedValueOnce(new Error("connection lost"));
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: sign }, options);
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).rejects.toThrow("connection lost");
    await expect(signer.sendTransaction({ to: recipient, data: "0xab" })).resolves.toBe("0xabc");
    expect(sign.mock.calls.map(([args]) => args.nonce)).toEqual([7, 8]);
    expect(rpc.sendRawTransaction.mock.calls.map(([args]) => args.serializedTransaction))
      .toEqual(["0x0700", "0x0700", "0x0800"]);
  });

  it("retains the original when a transport error merely says transaction underpriced", async () => {
    const sign = vi.fn(async ({ nonce }: { nonce: number }) => nonce === 7 ? "0x0700" : "0x0800");
    rpc.sendRawTransaction.mockRejectedValueOnce(new Error("transaction underpriced"));
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: sign }, options);
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).rejects.toThrow("transaction underpriced");
    await signer.sendTransaction({ to: recipient, data: "0xab" });
    expect(sign.mock.calls.map(([args]) => args.nonce)).toEqual([7, 8]);
    expect(rpc.sendRawTransaction.mock.calls.map(([args]) => args.serializedTransaction))
      .toEqual(["0x0700", "0x0700", "0x0800"]);
  });

  it("does not discard an original transaction when its recovery broadcast is underpriced", async () => {
    let calls = 0;
    const publicClient = createPublicClient({ transport: custom({ request: async () => {
      if (++calls === 2) throw { code: -32000, message: "transaction underpriced" };
      return "0xabc";
    } }) });
    const sign = vi.fn(async ({ nonce }: { nonce: number }) => nonce === 7 ? "0x0700" : "0x0800");
    const broadcast = vi.fn(publicClient.sendRawTransaction);
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: sign },
      { ...options, client: { ...rpc, sendRawTransaction: broadcast } as unknown as EvmRpcClient });
    await signer.sendTransaction({ to: recipient, data: "0x" });
    await expect(signer.sendTransaction({ to: recipient, data: "0xab" })).rejects.toThrow("evm_nonce_reconciliation_required");
    expect(sign).toHaveBeenCalledTimes(1);
    await expect(signer.sendTransaction({ to: recipient, data: "0xab" })).resolves.toBe("0xabc");
    expect(broadcast.mock.calls.map(([args]) => args.serializedTransaction))
      .toEqual(["0x0700", "0x0700", "0x0700", "0x0800"]);
  });

  it.each(["already known", "known transaction", "transaction already imported"])(
    "accepts an original transaction already in the pool: %s", async message => {
      let calls = 0;
      const publicClient = createPublicClient({ transport: custom({ request: async () => {
        if (++calls === 2) throw { code: -32000, message };
        return "0xabc";
      } }) });
      const broadcast = vi.fn(publicClient.sendRawTransaction);
      const sign = vi.fn(async ({ nonce }: { nonce: number }) => nonce === 7 ? "0x0700" : "0x0800");
      const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: sign },
        { ...options, client: { ...rpc, sendRawTransaction: broadcast } as unknown as EvmRpcClient });
      await signer.sendTransaction({ to: recipient, data: "0x" });
      await expect(signer.sendTransaction({ to: recipient, data: "0xab" })).resolves.toBe("0xabc");
      expect(sign.mock.calls.map(([args]) => args.nonce)).toEqual([7, 8]);
      expect(broadcast.mock.calls.map(([args]) => args.serializedTransaction)).toEqual(["0x0700", "0x0700", "0x0800"]);
    },
  );

  it("returns the original transaction hash when its first submission is already known", async () => {
    const publicClient = createPublicClient({ transport: custom({ request: async () => {
      throw { code: -32000, message: "already known" };
    } }) });
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: async () => "0x0700" },
      { ...options, client: { ...rpc, sendRawTransaction: publicClient.sendRawTransaction } as unknown as EvmRpcClient });
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).resolves.toBe(keccak256("0x0700"));
  });

  it("requires a fresh mined nonce before releasing an original after a mining race", async () => {
    let broadcasts = 0, latestReads = 0;
    const publicClient = createPublicClient({ transport: custom({ request: async () => {
      if (++broadcasts === 2) throw { code: -32000, message: "nonce too low" };
      return "0xabc";
    } }) });
    const sign = vi.fn(async ({ nonce }: { nonce: number }) => nonce === 7 ? "0x0700" : "0x0800");
    const client = { ...rpc, sendRawTransaction: vi.fn(publicClient.sendRawTransaction),
      getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) => blockTag === "latest" && ++latestReads >= 3 ? 8 : 7) };
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: sign },
      { ...options, client: client as unknown as EvmRpcClient });
    await signer.sendTransaction({ to: recipient, data: "0x" });
    await expect(signer.sendTransaction({ to: recipient, data: "0xab" })).resolves.toBe("0xabc");
    expect(sign.mock.calls.map(([args]) => args.nonce)).toEqual([7, 8]);
    expect(client.sendRawTransaction.mock.calls.map(([args]) => args.serializedTransaction)).toEqual(["0x0700", "0x0700", "0x0800"]);
  });

  it("releases mined reservations when latest nonce proves consumption", async () => {
    let latest = 7;
    const client = { ...rpc, getTransactionCount: vi.fn(async ({ blockTag }: { blockTag: string }) => blockTag === "latest" ? latest : 7) };
    const sign = vi.fn(async ({ nonce }: { nonce: number }) => nonce === 7 ? "0x0700" : "0x0800");
    const signer = await createFacilitatorEvmSigner({ getAddress: () => account, signTransaction: sign },
      { ...options, client: client as unknown as EvmRpcClient });
    await signer.sendTransaction({ to: recipient, data: "0x" });
    latest = 8;
    await signer.sendTransaction({ to: recipient, data: "0x" });
    expect(rpc.sendRawTransaction.mock.calls.map(([args]) => args.serializedTransaction)).toEqual(["0x0700", "0x0800"]);
    expect(client.getTransactionCount).toHaveBeenCalledWith({ address: account, blockTag: "latest" });
  });

  it("does not consume a nonce when wallet signing fails before broadcast", async () => {
    const sign = vi.fn<(args: { nonce: number }) => Promise<string>>(async () => "0x1234")
      .mockRejectedValueOnce(new Error("wallet locked"));
    const signer = await createFacilitatorEvmSigner({ getAddress: () => "0x5555555555555555555555555555555555555555",
      signTransaction: sign }, options);
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).rejects.toThrow("wallet locked");
    await signer.sendTransaction({ to: recipient, data: "0x" });
    expect(sign.mock.calls.map(([args]) => (args as { nonce: number }).nonce)).toEqual([7, 7]);
  });
});
