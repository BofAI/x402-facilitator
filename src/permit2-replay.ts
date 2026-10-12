import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import { TronWeb } from "tronweb";
import { PERMIT2_ADDRESSES, normalizeAddressForSigning } from "@bankofai/x402-tron";
import { PERMIT2_ADDRESS } from "@bankofai/x402-evm";
import type { x402Facilitator } from "@bankofai/x402-core/facilitator";
import type { PaymentPayload, PaymentRequirements } from "@bankofai/x402-core/types";
import { familyOf, requireCanonicalNetwork, type CanonicalNetwork } from "./network.js";
import { logger } from "./logger.js";

export interface Permit2Identity {
  network: CanonicalNetwork;
  owner: `0x${string}`;
  nonce: bigint;
}

export class Permit2ReplayError extends Error {}

interface NonceBitmapReader {
  readContract(args: { address: string; abi: readonly Record<string, unknown>[];
    functionName: string; args: readonly unknown[] }): Promise<unknown>;
}

const UINT256_LIMIT = 1n << 256n;
const settlementLease = new AsyncLocalStorage<{ lost: boolean }>();

/** A lost advisory-lock session cannot authorize a later signing/broadcast step. */
export function assertPermit2SettlementLease(): void {
  if (settlementLease.getStore()?.lost) throw new Permit2ReplayError("permit2_storage_unavailable");
}
const NONCE_BITMAP_ABI = [{ type: "function", name: "nonceBitmap", stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }, { name: "wordPos", type: "uint256" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Permit2's unordered nonce belongs to the owner, shared across tokens and schemes. */
export function permit2Identity(payment: PaymentPayload, requirements: PaymentRequirements): Permit2Identity | null {
  const payload = object(payment.payload);
  let container = payload;
  if (requirements.scheme === "batch-settlement") {
    if (payload?.type !== "deposit") return null;
    container = object(object(payload.deposit)?.authorization);
  }
  const hasAuthorization = container !== undefined && Object.hasOwn(container, "permit2Authorization");
  if (!hasAuthorization && requirements.scheme !== "upto" && requirements.extra?.assetTransferMethod !== "permit2") return null;
  try {
    const authorization = object(container?.permit2Authorization);
    const from = authorization?.from, rawNonce = authorization?.nonce;
    if (typeof from !== "string" || typeof rawNonce !== "string" || !/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(rawNonce))
      throw new Error("Invalid Permit2 identity");
    const network = requireCanonicalNetwork(requirements.network);
    const nonce = BigInt(rawNonce);
    if (nonce < 0n || nonce >= UINT256_LIMIT) throw new Error("Invalid Permit2 nonce");
    let owner: `0x${string}`;
    if (familyOf(network) === "tron") {
      if (!/^0x[0-9a-f]{40}$/i.test(from) && !/^41[0-9a-f]{40}$/i.test(from) && !TronWeb.isAddress(from))
        throw new Error("Invalid TRON owner");
      owner = normalizeAddressForSigning(from).toLowerCase() as `0x${string}`;
    } else {
      if (!/^0x[0-9a-f]{40}$/i.test(from)) throw new Error("Invalid EVM owner");
      owner = from.toLowerCase() as `0x${string}`;
    }
    return { network, owner, nonce };
  } catch {
    throw new Permit2ReplayError("permit2_invalid_authorization");
  }
}

export function registerPermit2ReplayGuard(
  facilitator: x402Facilitator,
  network: CanonicalNetwork,
  signer: NonceBitmapReader,
): void {
  facilitator.onBeforeSettle(async ({ paymentPayload, requirements }) => {
    let identity: Permit2Identity | null;
    try { identity = permit2Identity(paymentPayload, requirements); }
    catch { return { abort: true, reason: "permit2_invalid_authorization" }; }
    if (!identity || identity.network !== network) return;
    try {
      assertPermit2SettlementLease();
      const address = familyOf(network) === "tron" ? PERMIT2_ADDRESSES[network] : PERMIT2_ADDRESS;
      if (!address) throw new Error("No Permit2 contract registered");
      const bitmap = await signer.readContract({ address, abi: NONCE_BITMAP_ABI,
        functionName: "nonceBitmap", args: [identity.owner, identity.nonce >> 8n] });
      assertPermit2SettlementLease();
      if (typeof bitmap !== "bigint" || bitmap < 0n || bitmap >= UINT256_LIMIT)
        throw new Error("Invalid nonce bitmap");
      if ((bitmap & (1n << (identity.nonce & 255n))) !== 0n)
        return { abort: true, reason: "permit2_nonce_consumed" };
    } catch (error) {
      if (error instanceof Permit2ReplayError) return { abort: true, reason: error.message };
      return { abort: true, reason: "permit2_nonce_check_unavailable" };
    }
  });
}

/** The session lock spans only SDK settlement, so a one-connection pool can persist afterwards. */
export async function withPermit2SettlementLock<T>(pool: Pool, identity: Permit2Identity, settle: () => Promise<T>): Promise<T> {
  const key = createHash("sha256").update(`x402:permit2:${identity.network}:${identity.owner}:${identity.nonce}`)
    .digest().readBigInt64BE(0).toString();
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch { throw new Permit2ReplayError("permit2_storage_unavailable"); }
  let acquired = false, discard = false;
  const lease = { lost: false };
  const onSessionError = (error: Error) => {
    lease.lost = true;
    discard = true;
    logger.error("Permit2 settlement lock session lost", { err: String(error), network: identity.network });
  };
  client.on("error", onSessionError);
  try {
    try {
      acquired = (await client.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [key])).rows[0]?.acquired === true;
    } catch {
      discard = true;
      throw new Permit2ReplayError("permit2_storage_unavailable");
    }
    if (lease.lost) throw new Permit2ReplayError("permit2_storage_unavailable");
    if (!acquired) throw new Permit2ReplayError("permit2_authorization_busy");
    return await settlementLease.run(lease, settle);
  } finally {
    if (acquired && !discard) {
      try {
        discard = (await client.query("SELECT pg_advisory_unlock($1::bigint) AS released", [key])).rows[0]?.released !== true;
      } catch { discard = true; }
    }
    // Failed unlock must destroy the session rather than leave a lock in the pool.
    // On discarded sessions the listener remains until the client is collected,
    // absorbing a final socket error after termination. Pooled sessions must not
    // retain a request's lease listener.
    if (!discard) client.off("error", onSessionError);
    client.release(discard);
  }
}

/** The SDK wraps hook aborts in a plain Error; match only our closed set of reasons. */
export function permit2ReplayReason(error: unknown): string | undefined {
  if (error instanceof Permit2ReplayError) return error.message;
  if (!(error instanceof Error)) return undefined;
  return /^Settlement aborted: (permit2_(?:invalid_authorization|nonce_consumed|nonce_check_unavailable|storage_unavailable))$/.exec(error.message)?.[1];
}
