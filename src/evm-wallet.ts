import { BaseError, FeeCapTooLowError, InsufficientFundsError, encodeFunctionData, keccak256, type Abi, type PublicClient } from "viem";
import { containsNodeError, getNodeError } from "viem/utils";
import { appendDataSuffix, toFacilitatorEvmSigner, type ClientEvmSigner, type FacilitatorEvmSigner } from "@x402/evm";
import type { Erc20ApprovalGasSponsoringSigner } from "@x402/extensions";
import { logger } from "./logger.js";

export type EvmRpcClient = Pick<PublicClient, "getChainId" | "getTransactionCount" | "estimateFeesPerGas" |
  "estimateGas" | "sendRawTransaction" | "readContract" | "verifyTypedData" | "getCode" | "waitForTransactionReceipt">;
export type EvmAuthorizerSigner = Pick<ClientEvmSigner, "address" | "signTypedData">;
export type GasSponsoringFacilitatorEvmSigner = FacilitatorEvmSigner &
  Pick<Erc20ApprovalGasSponsoringSigner, "sendTransactions">;

interface EvmWallet {
  getAddress(): string | Promise<string>;
  signTransaction(payload: Record<string, unknown>): Promise<string | Record<string, unknown>>;
}

interface NonceState {
  tail: Promise<void>;
  transactions: Map<number, { hash: `0x${string}`; serializedTransaction: `0x${string}` }>;
}
// A wallet shared by signers in this process must use one nonce queue.
const nonceStates = new Map<string, NonceState>();

// Match node response details, never arbitrary transport/error message text.
function nodeDetails(error: unknown): string | undefined {
  return error instanceof BaseError && containsNodeError(error) ? error.details?.trim().toLowerCase() : undefined;
}
function alreadyKnown(error: unknown): boolean {
  const details = nodeDetails(error);
  return details === "already known" || details === "known transaction" || details === "transaction already imported";
}
function rejectedBeforeAcceptance(error: unknown): boolean {
  const rejection = error instanceof BaseError && containsNodeError(error) ? getNodeError(error, {}) : error;
  return rejection instanceof InsufficientFundsError || rejection instanceof FeeCapTooLowError ||
    nodeDetails(error) === "transaction underpriced";
}

export async function createAuthorizerEvmSigner(wallet: {
  getAddress(): string | Promise<string>;
  signTypedData(args: Parameters<ClientEvmSigner["signTypedData"]>[0]): Promise<string>;
}): Promise<EvmAuthorizerSigner> {
  return {
    address: await wallet.getAddress() as `0x${string}`,
    signTypedData: async args => `0x${(await wallet.signTypedData(args)).replace(/^0x/, "")}`,
  };
}

/** Adapt wallet signing and an existing RPC client to official x402 interfaces.
 * Network selection, wallet resolution and receipt fallback belong to the caller. */
export async function createFacilitatorEvmSigner(wallet: EvmWallet, options: {
  network: string;
  client: EvmRpcClient;
}): Promise<GasSponsoringFacilitatorEvmSigner> {
  const address = await wallet.getAddress() as `0x${string}`;
  const { client } = options;
  const key = `${options.network}:${address.toLowerCase()}`;
  let state = nonceStates.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), transactions: new Map() };
    nonceStates.set(key, state);
  }
  const nonces = state;

  async function send(to: `0x${string}`, data: `0x${string}`, gasOverride?: bigint): Promise<`0x${string}`> {
    const previous = nonces.tail;
    let release!: () => void;
    nonces.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const [chainId, pendingNonce, latestNonce, fees] = await Promise.all([
        client.getChainId(), client.getTransactionCount({ address, blockTag: "pending" }),
        client.getTransactionCount({ address, blockTag: "latest" }), client.estimateFeesPerGas(),
      ]);
      let confirmedNonce = latestNonce;
      let nonce = Math.max(pendingNonce, confirmedNonce);
      // Keep every unmined original even after pending advances: the pool may
      // later drop an earlier transaction and move pending backwards.
      for (const [reserved, transaction] of [...nonces.transactions].sort(([a], [b]) => a - b)) {
        if (reserved < confirmedNonce) { nonces.transactions.delete(reserved); continue; }
        // An earlier gap owned by another writer cannot be repaired from this
        // process's journal; do not allocate past it or replace its transaction.
        if (reserved > nonce) throw new Error("evm_nonce_reconciliation_required");
        if (reserved >= pendingNonce) {
          try {
            await client.sendRawTransaction({ serializedTransaction: transaction.serializedTransaction });
            logger.info("x402 evm: original tx rebroadcast", { hash: transaction.hash, nonce: reserved });
          } catch (error) {
            if (!alreadyKnown(error)) {
              // A nonce-too-low response alone is not proof of mining. Use a
              // fresh confirmed account nonce before discarding the original.
              const confirmed = await client.getTransactionCount({ address, blockTag: "latest" });
              if (confirmed > reserved) {
                nonces.transactions.delete(reserved);
                confirmedNonce = Math.max(confirmedNonce, confirmed);
                nonce = Math.max(nonce, confirmedNonce);
                continue;
              }
              throw new Error("evm_nonce_reconciliation_required", { cause: error });
            }
          }
        }
        nonce = Math.max(nonce, reserved + 1);
      }
      const gas = gasOverride ?? await client.estimateGas({ account: address, to, data, value: 0n });
      const signed = await wallet.signTransaction({ to, data, value: 0n, nonce, gas, chainId,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      const raw = typeof signed === "string" ? signed : signed.family === "evm" ? signed.rawTransaction : undefined;
      if (typeof raw !== "string") throw new Error("EVM signTransaction must return an EVM signed transaction artifact");
      // Journal the exact signed bytes in this process before submitting. Unknown
      // results and dropped transactions must recover this original, not a replacement.
      const serializedTransaction = `0x${raw.replace(/^0x/, "")}` as `0x${string}`;
      const transaction = { serializedTransaction, hash: keccak256(serializedTransaction) };
      nonces.transactions.set(nonce, transaction);
      logger.debug("x402 evm: broadcast start", { to, chainId, nonce });
      try {
        const hash = await client.sendRawTransaction({ serializedTransaction: transaction.serializedTransaction });
        logger.info("x402 evm: broadcast ok", { to, hash });
        return hash;
      } catch (error) {
        if (alreadyKnown(error)) return transaction.hash;
        // Only a fresh attempt's explicit rejection releases its reservation.
        // Rejections while recovering an older attempt never release that original.
        if (rejectedBeforeAcceptance(error)) nonces.transactions.delete(nonce);
        logger.error("x402 evm: broadcast failed", { to,
          error: error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error) });
        throw error;
      }
    } finally {
      release();
    }
  }

  const signer = toFacilitatorEvmSigner({
    address,
    // Upto simulations must run as the witness-bound facilitator.
    readContract: args => client.readContract({ account: address, ...args, abi: args.abi as Abi }),
    verifyTypedData: args => client.verifyTypedData(args as Parameters<EvmRpcClient["verifyTypedData"]>[0]),
    getCode: args => client.getCode(args),
    waitForTransactionReceipt: async args => {
      const receipt = await client.waitForTransactionReceipt(args);
      logger[receipt.status === "success" ? "info" : "warn"]("x402 evm: tx receipt", { hash: args.hash, status: receipt.status });
      return receipt;
    },
    writeContract: args => send(args.address, appendDataSuffix(encodeFunctionData({
      abi: args.abi as Abi, functionName: args.functionName, args: args.args,
    }), args.dataSuffix), args.gas),
    sendTransaction: args => send(args.to, args.data),
  });
  return {
    ...signer,
    async sendTransactions(transactions) {
      const hashes: `0x${string}`[] = [];
      for (const tx of transactions) {
        if (typeof tx === "string") {
          const hash = await client.sendRawTransaction({ serializedTransaction: `0x${tx.replace(/^0x/, "")}` });
          logger.info("x402 evm: pre-signed tx broadcast ok", { hash });
          hashes.push(hash);
        } else {
          hashes.push(await send(tx.to, tx.data, tx.gas));
        }
      }
      return hashes;
    },
  };
}
