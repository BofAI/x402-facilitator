import { normalizeTronNetwork, type Trc20ApprovalResourceSponsoringRuntime } from "@bankofai/x402-tron";
import type { SponsoringConfig } from "./config.js";
import type { SponsoringService } from "./service.js";

/** Network-local runtimes share a process, never readiness or capacity state. */
export function sponsoringForNetwork(services: readonly SponsoringService[], network: string): SponsoringService | undefined {
  const canonical = normalizeTronNetwork(network);
  return services.find(service => normalizeTronNetwork(service.access().network) === canonical);
}

/** The SDK falls back to the default runtime when its resolver returns undefined.
 * Dispatch there too, rather than falling back to the first configured network. */
export function routingSponsoringRuntime(services: readonly SponsoringService[]): Trc20ApprovalResourceSponsoringRuntime {
  return {
    async verify(request) {
      const service = sponsoringForNetwork(services, request.network);
      return service ? service.runtime.verify(request) : { isValid: false, invalidReason: "sponsor_network_disabled" };
    },
    async sponsor(request, options) {
      const service = sponsoringForNetwork(services, request.network);
      return service ? service.runtime.sponsor(request, options) : { success: false, errorReason: "sponsor_network_disabled" };
    },
  };
}

export async function closeSponsoringServices(services: readonly SponsoringService[]): Promise<void> {
  const results = await Promise.allSettled(services.map(service => service.close()));
  const failures = results.filter(result => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "sponsor_shutdown_failed");
}

export async function createSponsoringServices(configs: readonly SponsoringConfig[],
  create: (config: SponsoringConfig) => Promise<SponsoringService>): Promise<SponsoringService[]> {
  const services: SponsoringService[] = [];
  try {
    for (const config of configs) services.push(await create(config));
    return services;
  } catch (error) {
    // Preserve the initialization error while attempting cleanup of every network.
    await closeSponsoringServices(services).catch(() => {});
    throw error;
  }
}
