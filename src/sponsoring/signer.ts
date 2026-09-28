import { resolveWallet, type Wallet } from "@bankofai/agent-wallet";
import { TronWeb } from "tronweb";
import { normalizeSignedTronTransaction, type TronResourceOwnerSigner } from "@bankofai/x402-tron";
import type { SponsoringConfig } from "./config.js";

const canonical = (address: string) => TronWeb.address.toHex(address).toLowerCase();
type Permission = { id?: number; type?: number | string; threshold?: number; operations?: string;
  keys?: { address: string; weight: number }[] };

export function assertResourcePermission(account: { active_permission?: Permission[] }, id: number, signer: string): void {
  const permission = account.active_permission?.find(entry => entry.id === id);
  const mask = Buffer.alloc(32); mask[7] = 6;
  if (!permission || ![2, "Active"].includes(permission.type ?? "") || permission.threshold !== 1 || permission.operations?.toLowerCase() !== mask.toString("hex") ||
      permission.keys?.length !== 1 || canonical(permission.keys[0].address) !== canonical(signer) || permission.keys[0].weight !== 1)
    throw new Error("resource_owner_permission_invalid");
}

/** The SDK chain validates JSON/protobuf/intent before entering this closure
 * and validates again after signing. Recheck the on-chain key scope each time. */
export async function buildResourceOwnerSigner(config: SponsoringConfig, tron: TronWeb, settlementAddress: string,
  prepared: (txID: string, expiration: number) => void | Promise<void>,
  assertOwnership: () => Promise<void> = async () => {}): Promise<TronResourceOwnerSigner> {
  const wallet: Wallet = await resolveWallet({ network: config.network, walletId: config.wallet_id, dir: config.wallet_dir });
  const keyAddress = await wallet.getAddress();
  if (new Set([config.owner, keyAddress, settlementAddress].map(canonical)).size !== 3)
    throw new Error("resource_owner_permission_not_exclusive");
  const validate = async () => assertResourcePermission(await tron.trx.getAccount(config.owner), config.permission_id, keyAddress);
  await validate();
  return {
    getAddress: async () => config.owner,
    async signResourceTransaction({ intent, transaction }) {
      await assertOwnership();
      if (intent.network !== config.network || canonical(intent.owner) !== canonical(config.owner) ||
          intent.permissionId !== config.permission_id || intent.lock !== false ||
          !["delegate", "undelegate"].includes(intent.action) || !["ENERGY", "BANDWIDTH"].includes(intent.resource) ||
          !TronWeb.isAddress(intent.receiver) || BigInt(intent.stakeSun) <= 0n)
        throw new Error("resource_owner_intent_invalid");
      const raw = transaction.raw_data as { timestamp?: number; expiration?: number };
      if (!raw || !Number.isSafeInteger(raw.expiration) || !Number.isSafeInteger(raw.timestamp) ||
          raw.expiration! <= Date.now() || raw.expiration! - raw.timestamp! > 300_000)
        throw new Error("resource_transaction_expiration_invalid");
      await validate();
      await assertOwnership();
      const original = structuredClone(transaction);
      const artifact = await wallet.signTransaction(transaction);
      await assertOwnership();
      if (artifact.family !== "tron") throw new Error("resource_owner_signed_transaction_family_invalid");
      const signed = normalizeSignedTronTransaction(artifact.transaction, original);
      if (signed.raw_data_hex !== original.raw_data_hex || signed.txID !== original.txID)
        throw new Error("resource_owner_signed_transaction_mismatch");
      await prepared(String(signed.txID), raw.expiration!);
      await assertOwnership();
      return signed;
    },
  };
}
