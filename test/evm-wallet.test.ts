import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData } from "viem";
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
import { createAuthorizerEvmSigner, createFacilitatorEvmSigner } from "../src/evm-wallet.js";

const options = { network: "eip155:84532", client: rpc as unknown as EvmRpcClient };

const account = "0x1111111111111111111111111111111111111111" as const;
const recipient = "0x2222222222222222222222222222222222222222" as const;
const abi = [{ type: "function", name: "settle", stateMutability: "nonpayable", inputs: [], outputs: [] }] as const;

describe("service-owned EVM wallet overlay with official signer", () => {
  beforeEach(() => vi.clearAllMocks());
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
    rpc.sendRawTransaction.mockRejectedValueOnce(new Error("connection lost"));
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).rejects.toThrow("connection lost");
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).rejects.toThrow("evm_nonce_reconciliation_required");
    expect(sign).toHaveBeenCalledTimes(1);
    rpc.getTransactionCount.mockResolvedValueOnce(8);
    await expect(signer.sendTransaction({ to: recipient, data: "0x" })).resolves.toBe("0xabc");
    expect(sign).toHaveBeenLastCalledWith(expect.objectContaining({ nonce: 8 }));
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
