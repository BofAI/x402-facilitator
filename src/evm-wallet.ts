/** BankofAI wallet overlay moved from the Apache-2.0 SDK adapter into the service.
 * Signing remains in the supplied wallet; official EVM public signer interfaces own settlement.
 */
import { encodeFunctionData, type Abi, type Log } from "viem";
import { toFacilitatorEvmSigner, type ClientEvmSigner, type FacilitatorEvmSigner } from "@x402/evm";
import { createEvmPublicClient } from "./evm-chains.js";
import { logger as log } from "./logger.js";

interface EvmNonceState {
  tail: Promise<void>;
  nextNonce?: number;
  uncertainNonce?: number;
}
// All service signers for one chain/EOA share a queue. Deployments must still
// assign a wallet to one process; this is not a distributed nonce allocator.
const nonceStates = new Map<string, EvmNonceState>();

async function withNonceQueue<T>(key: string, operation: (state: EvmNonceState) => Promise<T>): Promise<T> {
  let state = nonceStates.get(key);
  if (!state) {
    state = { tail: Promise.resolve() };
    nonceStates.set(key, state);
  }
  const previous = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await operation(state); }
  finally { release(); }
}
export interface EvmTypedDataWallet {
  getAddress(): string | Promise<string>;
  signTypedData(args: Parameters<ClientEvmSigner["signTypedData"]>[0]): Promise<string>;
}

function normalizeSignedEvmTransaction(result: string | Record<string, unknown>): `0x${string}` {
  const raw =
    typeof result === "string"
      ? result
      : result.family === "evm" && typeof result.rawTransaction === "string"
        ? result.rawTransaction
        : undefined;
  if (raw == null) {
    throw new Error("EVM signTransaction must return an EVM signed transaction artifact");
  }
  return `0x${raw.replace(/^0x/, "")}` as `0x${string}`;
}

export type EvmAuthorizerSigner = Pick<ClientEvmSigner, "address" | "signTypedData">;

/**
 * Creates an authorizer signer (address + typed-data signing) from a wallet —
 * e.g. the batch-settlement `receiverAuthorizer`, which signs `ClaimBatch` /
 * `Refund` EIP-712 digests. No chain client is built (signing is offline).
 *
 * @param wallet - The wallet that holds the authorizer key.
 * @returns A signer satisfying batch-settlement's `AuthorizerSigner`.
 */
export async function createAuthorizerEvmSigner(
  wallet: EvmTypedDataWallet,
): Promise<EvmAuthorizerSigner> {
  const address = (await wallet.getAddress()) as `0x${string}`;
  return {
    address,
    // agent-wallet strips the `0x`; re-add it so the signature conforms.
    signTypedData: async msg => {
      const sig = await wallet.signTypedData(msg);
      return `0x${sig.replace(/^0x/, "")}` as `0x${string}`;
    },
  };
}

/**
 * Typed EIP-1559 fields the facilitator wallet receives to sign a settlement tx.
 * A `type` (not `interface`) so it stays assignable to `Record<string, unknown>`
 * — the shape a generic agent-wallet `signTransaction` accepts.
 */
export type Eip1559TxFields = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  chainId: number;
};

/** EVM facilitator wallet — {@link FacilitatorWallet} refined to EIP-1559 fields. */
export interface FacilitatorEvmWallet {
  getAddress(): string | Promise<string>;
  signTransaction(args: Eip1559TxFields): Promise<string | Record<string, unknown>>;
}

/**
 * Loose view of the viem public client for internal forwarding. viem's read/verify
 * methods are generic and strict, while upstream's `FacilitatorEvmSigner` shape is
 * loose; we narrow once here so the impedance is resolved inside the service adapter.
 */
type LooseEvmPublicClient = {
  getChainId(): Promise<number>;
  getTransactionCount(args: {
    address: `0x${string}`;
    blockTag?: "latest" | "pending";
  }): Promise<number>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  estimateGas(args: {
    account: `0x${string}`;
    to: `0x${string}`;
    data: `0x${string}`;
    value?: bigint;
  }): Promise<bigint>;
  sendRawTransaction(args: { serializedTransaction: `0x${string}` }): Promise<`0x${string}`>;
  readContract(args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    account?: `0x${string}`;
  }): Promise<unknown>;
  verifyTypedData(args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  }): Promise<boolean>;
  getCode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
  }): Promise<{ status: string; logs?: readonly Log[] }>;
};

/** Options for {@link createFacilitatorEvmSigner}. */
export interface CreateFacilitatorEvmSignerOptions {
  /** CAIP-2 network, e.g. `"eip155:97"`. The viem client is built from it. */
  network: string;
  /** Optional RPC URL override; falls back to the chain's default. */
  rpcUrl?: string;
  /** Gas limit when a per-call `gas` is not supplied; otherwise estimated. */
  defaultGas?: bigint;
}

/**
 * One transaction for {@link GasSponsoringFacilitatorEvmSigner.sendTransactions}:
 * a pre-signed serialized tx (broadcast as-is) or an unsigned call intent (signed
 * by the facilitator wallet, then broadcast).
 */
export type EvmTransactionRequest =
  | `0x${string}`
  | { to: `0x${string}`; data: `0x${string}`; gas?: bigint };

/**
 * {@link FacilitatorEvmSigner} plus `sendTransactions` — the shape the ERC-20
 * approval gas-sponsoring extension expects (broadcasts the client's pre-signed
 * `approve` bundled with `settle`).
 */
export type GasSponsoringFacilitatorEvmSigner = FacilitatorEvmSigner & {
  sendTransactions(transactions: readonly EvmTransactionRequest[]): Promise<`0x${string}`[]>;
};

/**
 * Appends an extension data suffix (e.g. a builder code) to encoded calldata.
 *
 * @param data - The encoded function calldata.
 * @param suffix - Optional `0x`-prefixed suffix to append.
 * @returns The calldata with the suffix appended, or `data` unchanged.
 */
function appendDataSuffix(data: `0x${string}`, suffix?: `0x${string}`): `0x${string}` {
  if (!suffix || suffix === "0x") {
    return data;
  }
  return `${data}${suffix.slice(2)}` as `0x${string}`;
}

/**
 * Creates a {@link FacilitatorEvmSigner} from a wallet — the EVM counterpart of
 * `createFacilitatorTronSigner`. The viem public client (reads / verification /
 * broadcast) is built internally from `opts.network`. The transaction is built
 * (nonce / EIP-1559 fees / gas), handed to the wallet to sign (the private key
 * never enters this adapter), then broadcast.
 *
 * @param wallet - The wallet that signs settlement transactions.
 * @param opts - Target network (+ optional RPC override / default gas).
 * @returns A {@link GasSponsoringFacilitatorEvmSigner} backed by the wallet.
 *
 * @example
 * ```typescript
 * const signer = await createFacilitatorEvmSigner(agentWallet, { network: "eip155:97" });
 * facilitator.register("eip155:97", new ExactEvmScheme(signer));
 * ```
 */
export async function createFacilitatorEvmSigner(
  wallet: FacilitatorEvmWallet,
  opts: CreateFacilitatorEvmSignerOptions,
): Promise<GasSponsoringFacilitatorEvmSigner> {
  const address = (await wallet.getAddress()) as `0x${string}`;
  // Narrow once: viem's strict generic methods → the loose shape we forward to
  // upstream's FacilitatorEvmSigner. Keeps the cast inside the service adapter.
  const client = createEvmPublicClient(
    opts.network,
    opts.rpcUrl,
  ) as unknown as LooseEvmPublicClient;

  /**
   * Build, wallet-sign, and broadcast a transaction.
   *
   * @param to - Destination contract or account
   * @param data - Encoded call data
   * @param gasOverride - Optional precomputed gas limit
   * @returns Broadcast transaction hash
   */
  async function buildSignBroadcast(
    to: `0x${string}`,
    data: `0x${string}`,
    gasOverride?: bigint,
  ): Promise<`0x${string}`> {
    return withNonceQueue(`${opts.network}:${address.toLowerCase()}`, async state => {
      const value = 0n; // x402 settlement never transfers native value.
      const [chainId, pendingNonce, fees] = await Promise.all([
        client.getChainId(),
        // "pending" (not the default "latest") counts the EOA's not-yet-mined txs,
        // so rapid sequential settlements from one facilitator key don't reuse a
        // nonce while the previous settle is still in the mempool.
        client.getTransactionCount({ address, blockTag: "pending" }),
        client.estimateFeesPerGas(),
      ]);
      if (state.uncertainNonce !== undefined) {
        if (pendingNonce <= state.uncertainNonce) throw new Error("evm_nonce_reconciliation_required");
        delete state.uncertainNonce;
      }
      const nonce = Math.max(pendingNonce, state.nextNonce ?? pendingNonce);
      const gas =
        gasOverride ??
        opts.defaultGas ??
        (await client.estimateGas({ account: address, to, data, value }));

      const signed = await wallet.signTransaction({
        to,
        data,
        value,
        nonce,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        chainId,
      });
      const serializedTransaction = normalizeSignedEvmTransaction(signed);
      // Once broadcast begins, a transport failure cannot prove the tx was absent.
      // Retain the reservation and fail closed until a fresh pending nonce passes it.
      state.nextNonce = nonce + 1;
      log.debug("x402 evm: broadcast start", { to, chainId, nonce });
      try {
        const hash = await client.sendRawTransaction({ serializedTransaction });
        log.info("x402 evm: broadcast ok", { to, hash });
        return hash;
      } catch (error) {
        state.uncertainNonce = nonce;
        log.error("x402 evm: broadcast failed", {
          to,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }

  const base = toFacilitatorEvmSigner({
    address,
    // Issue every read as the facilitator EOA (sets the eth_call `from`). View
    // calls ignore the caller, but caller-authorized simulations need it — the
    // upto proxy `settle` reverts with `UnauthorizedFacilitator` unless
    // `msg.sender` is the witness-bound facilitator (= this single-key wallet).
    // `...args` last so an explicit per-call `account` (if upstream ever adds one)
    // overrides this default.
    readContract: args => client.readContract({ account: address, ...args }),
    verifyTypedData: args => client.verifyTypedData(args),
    getCode: args => client.getCode(args),
    waitForTransactionReceipt: async args => {
      const receipt = await client.waitForTransactionReceipt(args);
      log[receipt.status === "success" ? "info" : "warn"]("x402 evm: tx receipt", {
        hash: args.hash,
        status: receipt.status,
      });
      return receipt;
    },
    writeContract: args => {
      const data = appendDataSuffix(
        encodeFunctionData({
          abi: args.abi as Abi,
          functionName: args.functionName,
          args: args.args,
        }),
        args.dataSuffix,
      );
      return buildSignBroadcast(args.address, data, args.gas);
    },
    sendTransaction: args => buildSignBroadcast(args.to, args.data),
  });

  // Batch broadcast for the ERC-20 approval gas-sponsoring extension: the
  // client's pre-signed `approve` (a serialized tx) is broadcast as-is; the
  // `settle` call intent is signed by the facilitator wallet and broadcast.
  return {
    ...base,
    async sendTransactions(transactions) {
      const hashes: `0x${string}`[] = [];
      for (const tx of transactions) {
        if (typeof tx === "string") {
          const serializedTransaction = `0x${tx.replace(/^0x/, "")}` as `0x${string}`;
          const hash = await client.sendRawTransaction({ serializedTransaction });
          log.info("x402 evm: pre-signed tx broadcast ok", { hash });
          hashes.push(hash);
        } else {
          hashes.push(await buildSignBroadcast(tx.to, tx.data, tx.gas));
        }
      }
      return hashes;
    },
  };
}
