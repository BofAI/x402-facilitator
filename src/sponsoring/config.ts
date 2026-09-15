import { isAbsolute } from "node:path";
import { z } from "zod";
import { TronWeb } from "tronweb";
import { TRON_NILE, TRON_SHASTA, normalizeTronNetwork } from "@bankofai/x402-tron";

const address = z.string().refine(value => TronWeb.isAddress(value), "invalid TRON address")
  .transform(value => TronWeb.address.fromHex(TronWeb.address.toHex(value)));
const positiveAmount = z.string().regex(/^[1-9][0-9]*$/).max(78);

export const sponsoringConfigSchema = z.object({
  network: z.enum(["tron:0xcd8690dc", TRON_NILE, "tron:0x94a9059e", TRON_SHASTA]).transform(normalizeTronNetwork),
  database: z.string().refine(isAbsolute, "must be an absolute persistent path").optional(),
  storage: z.discriminatedUnion("type", [
    z.object({ type: z.literal("sqlite"), path: z.string().refine(isAbsolute, "must be an absolute persistent path") }).strict(),
    z.object({ type: z.literal("postgres") }).strict(),
  ]).optional(),
  owner: address,
  wallet_id: z.string().min(1),
  wallet_dir: z.string().refine(isAbsolute).optional(),
  permission_id: z.number().int().min(2).max(9),
  assets: z.array(address).min(1),
  pay_to: z.array(address).min(1),
  energy_stake_sun: positiveAmount,
  bandwidth_stake_sun: positiveAmount,
  budget_sun: positiveAmount,
  management_bandwidth: positiveAmount,
}).strict().refine(value => (value.database !== undefined) !== (value.storage !== undefined),
  "specify exactly one of database or storage");

export type SponsoringConfig = z.infer<typeof sponsoringConfigSchema>;
