/**
 * Bounded, read-only EVM receipt confirmation with an independent fallback RPC.
 * Transaction creation and broadcast remain on the signer primary RPC; this module
 * never resubmits a transaction.
 */
import { createPublicClient, defineChain, http, type Log } from "viem";
import type { GasSponsoringFacilitatorEvmSigner } from "@bankofai/x402-evm/adapters/agent-wallet";
import { logger } from "./logger.js";

export interface EvmReceiptResult {
  status: string;
  logs?: readonly Log[];
}

export type ReceiptWaiter = (hash: `0x${string}`) => Promise<EvmReceiptResult>;

interface ReceiptFallbackOptions {
  network: string;
  primary: ReceiptWaiter;
  fallback: ReceiptWaiter;
}

/** Return a short RPC error summary without leaking endpoint URLs or API keys. */
function errorSummary(error: unknown): string {
  const firstLine = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0];
  const redacted = firstLine.replace(/https?:\/\/\S+/gi, "<redacted-rpc-url>");
  return error instanceof Error ? `${error.name}: ${redacted}` : redacted;
}

/**
 * Create a bounded receipt waiter for one RPC endpoint.
 *
 * @param chainId - EVM chain id.
 * @param rpcUrl - Endpoint used only for receipt reads.
 * @param confirmationTimeoutMs - Total time allowed for the receipt to appear.
 * @returns A function that waits for one transaction hash.
 */
export function createReceiptWaiter(
  chainId: number,
  rpcUrl: string,
  confirmationTimeoutMs: number,
): ReceiptWaiter {
  const chain = defineChain({
    id: chainId,
    name: `eip155:${chainId}`,
    nativeCurrency: { name: "Native token", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockTime: 1_000,
  });
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 10_000 }),
  });

  return hash => client.waitForTransactionReceipt({ hash, timeout: confirmationTimeoutMs });
}

/**
 * Replace only the signer's receipt wait with primary-then-fallback confirmation.
 * All signing, reads, simulation, and broadcasts remain unchanged.
 *
 * @param signer - SDK signer used by the facilitator.
 * @param options - Network and bounded receipt waiters.
 * @returns The signer with resilient receipt confirmation.
 */
export function withReceiptFallback(
  signer: GasSponsoringFacilitatorEvmSigner,
  options: ReceiptFallbackOptions,
): GasSponsoringFacilitatorEvmSigner {
  return {
    ...signer,
    async waitForTransactionReceipt({ hash }): Promise<EvmReceiptResult> {
      try {
        return await options.primary(hash);
      } catch (primaryError) {
        logger.warn("primary receipt RPC failed; trying fallback", {
          network: options.network,
          hash,
          error: errorSummary(primaryError),
        });
      }

      try {
        const receipt = await options.fallback(hash);
        logger.info("fallback receipt RPC succeeded", {
          network: options.network,
          hash,
          status: receipt.status,
        });
        return receipt;
      } catch (fallbackError) {
        logger.error("fallback receipt RPC failed", {
          network: options.network,
          hash,
          error: errorSummary(fallbackError),
        });
        throw new Error(`Receipt confirmation failed on primary and fallback RPC for ${hash}`);
      }
    },
  };
}
