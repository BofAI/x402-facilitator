/**
 * Builds the x402Facilitator and registers scheme/network handlers from config,
 * mirroring the v1 registration flow:
 *   - TRON networks  -> exact (eip3009/permit2) + exact_gasfree (when GasFree creds resolve)
 *   - EVM  networks  -> exact
 *
 * The SDK's GasFreeAPIClient performs no HMAC auth of its own; like v1 it is pointed
 * at this service's co-located GasFree proxy (/nile, /mainnet), which signs and
 * forwards to the official relayer. `gasfreeBaseUrlFor` supplies that proxy base per
 * network (or null to skip exact_gasfree registration).
 */
import { x402Facilitator } from "@bankofai/x402-core/facilitator";
import { registerExactTronScheme } from "@bankofai/x402-tron/exact/facilitator";
import { registerExactGasFreeTronScheme } from "@bankofai/x402-tron/gasfree/facilitator";
import { registerExactEvmScheme } from "@bankofai/x402-evm/exact/facilitator";
import type { ExactTronFeeConfig } from "@bankofai/x402-tron";
import { buildTronFacilitatorSigner, buildEvmFacilitatorSigner } from "./signer.js";
import { type FacilitatorConfig, enabledNetworks, type NetworkConfig } from "./config.js";
import { logger } from "./logger.js";

export interface BuildFacilitatorOptions {
  /** Returns the co-located GasFree proxy base URL for a TRON network, or null to skip gasfree. */
  gasfreeBaseUrlFor: (network: string) => string | null;
}

const isTron = (n: string) => n.startsWith("tron:");
const isEvm = (n: string) => n.startsWith("bsc:") || n.startsWith("eip155:") || n.startsWith("eth:");

/** Map config `base_fee` (symbol -> number|string) to the scheme fee config. */
function toFeeConfig(net: NetworkConfig): ExactTronFeeConfig | undefined {
  if (!net.base_fee) return undefined;
  const baseFee: Record<string, string> = {};
  for (const [symbol, amount] of Object.entries(net.base_fee)) {
    // The scheme looks up baseFee by `symbol.toUpperCase()`; normalize keys so a
    // lowercase config entry can't silently miss.
    baseFee[symbol.toUpperCase()] = String(amount);
  }
  // feeTo is left unset: the scheme defaults it to the facilitator signer address.
  return { baseFee };
}

/**
 * Build and fully register an x402Facilitator from the loaded config.
 *
 * @param cfg - The facilitator configuration.
 * @param opts - Build options (GasFree proxy wiring).
 * @returns A configured x402Facilitator instance.
 */
export async function buildFacilitator(
  cfg: FacilitatorConfig,
  opts: BuildFacilitatorOptions,
): Promise<x402Facilitator> {
  const facilitator = new x402Facilitator();
  const networks = cfg.facilitator.networks ?? {};

  for (const network of enabledNetworks(cfg)) {
    // enabledNetworks yields plain strings; the scheme registrars expect a CAIP-2
    // network id (`namespace:reference`).
    const caip = network as `${string}:${string}`;
    const fee = toFeeConfig(networks[network]);

    if (isTron(network)) {
      const signer = await buildTronFacilitatorSigner(network);
      registerExactTronScheme(facilitator, { signer, networks: caip, fee });

      const gasfreeBase = opts.gasfreeBaseUrlFor(network);
      if (gasfreeBase) {
        // Point the GasFree client at this service's co-located proxy, which adds
        // HMAC auth and forwards to the official relayer.
        registerExactGasFreeTronScheme(facilitator, {
          signer,
          networks: caip,
          fee,
          apiBaseUrls: { [network]: gasfreeBase },
        });
        logger.info("Registered exact + exact_gasfree", { network, gasfreeBase });
      } else {
        logger.info("Registered exact (GasFree creds absent; gasfree skipped)", { network });
      }
    } else if (isEvm(network)) {
      const signer = await buildEvmFacilitatorSigner(network);
      registerExactEvmScheme(facilitator, { signer, networks: caip });
      logger.info("Registered exact (EVM)", { network });
    } else {
      logger.warn("Unsupported network; skipped", { network });
    }
  }

  return facilitator;
}
