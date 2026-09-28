import type { Pool } from "pg";
import { sponsoringConfigSchema, type SponsoringConfig } from "./config.js";
import type { SponsoringCoordinator } from "./coordinator.js";
import { SqliteSponsoringCoordinator } from "./store.js";
import { PostgresSponsoringCoordinator } from "./postgres-store.js";

/** The application owns the shared Pool; coordinators only borrow sessions. */
export async function createSponsoringCoordinator(input: SponsoringConfig, pool?: Pool): Promise<SponsoringCoordinator> {
  const config = sponsoringConfigSchema.parse(input);
  const binding = { network: config.network, owner: config.owner, permissionId: config.permission_id };
  const limits = { energy: BigInt(config.energy_stake_sun), bandwidth: BigInt(config.bandwidth_stake_sun),
    budget: BigInt(config.budget_sun), management: BigInt(config.management_bandwidth) };
  if (config.storage?.type === "postgres") {
    if (!pool) throw new Error("sponsor_postgres_pool_required");
    return PostgresSponsoringCoordinator.create(pool, binding, limits);
  }
  return new SqliteSponsoringCoordinator(config.storage?.path ?? config.database!, binding, limits);
}
