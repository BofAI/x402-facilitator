/**
 * Builds the x402Facilitator and registers scheme/network handlers from config.
 * Each network's `schemes` list (default ["exact"]) selects what to register:
 *   - exact            -> TRON: eip3009/permit2 (+ exact_gasfree when creds resolve)
 *                         EVM:  eip3009/permit2
 *   - upto             -> Permit2 up-to-max settlement (TRON + EVM)
 *   - batch-settlement -> channel deposit/voucher/claim/settle/refund (TRON + EVM);
 *                         the facilitator's agent-wallet doubles as receiverAuthorizer
 *
 * The SDK's GasFreeAPIClient performs no HMAC auth of its own; like v1 it is pointed
 * at this service's co-located GasFree proxy (/nile, /mainnet), which signs and
 * forwards to the official relayer. `gasfreeBaseUrlFor` supplies that proxy base per
 * network (or null to skip exact_gasfree registration).
 */
import { x402Facilitator } from "@bankofai/x402-core/facilitator";
import { createFacilitator } from "@bankofai/x402-core";
import { registerExactTronScheme } from "@bankofai/x402-tron/exact/facilitator";
import { registerExactGasFreeTronScheme } from "@bankofai/x402-tron/gasfree/facilitator";
import { UptoTronScheme } from "@bankofai/x402-tron/upto/facilitator";
import { BatchSettlementTronScheme } from "@bankofai/x402-tron/batch-settlement/facilitator";
import { registerExactEvmScheme } from "@bankofai/x402-evm/exact/facilitator";
import { UptoEvmScheme } from "@bankofai/x402-evm/upto/facilitator";
import { BatchSettlementEvmScheme } from "@bankofai/x402-evm/batch-settlement/facilitator";
import type { ExactTronFeeConfig } from "@bankofai/x402-tron";
import {
  buildTronFacilitatorSigner,
  buildEvmFacilitatorSigner,
  buildTronAuthorizerSigner,
  buildEvmAuthorizerSigner,
} from "./signer.js";
import {
  type FacilitatorConfig,
  type NetworkConfig,
  type Scheme,
  enabledNetworks,
} from "./config.js";
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

/** Per-network registration context shared by the chain handlers. */
interface NetworkSetup {
  facilitator: x402Facilitator;
  /** Raw config network string (gasfree lookup + logging). */
  network: string;
  /** CAIP-2 form the scheme registrars / `register` expect. */
  caip: `${string}:${string}`;
  /** Whether a scheme is enabled for this network. */
  has: (s: Scheme) => boolean;
  /** TRON facilitator fee (advertised via getExtra); unused on EVM. */
  fee?: ExactTronFeeConfig;
}

/**
 * Register the enabled schemes for one TRON network. One signer serves every
 * scheme (built once); batch-settlement additionally resolves the receiver-
 * authorizer (same agent-wallet, exposing its typed-data signing role).
 */
async function registerTronNetwork(setup: NetworkSetup, opts: BuildFacilitatorOptions): Promise<void> {
  const { facilitator, network, caip, has, fee } = setup;
  const signer = await buildTronFacilitatorSigner(network);

  if (has("exact")) {
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
  }

  if (has("upto")) {
    // beta.3 aligned TRON with EVM: register the scheme class directly.
    facilitator.register(caip, new UptoTronScheme(signer, fee));
    logger.info("Registered upto (TRON)", { network });
  }

  if (has("batch-settlement")) {
    // Same agent-wallet doubles as the receiver-authorizer (signs ClaimBatch /
    // Refund TIP-712 digests; its address is published as receiverAuthorizer).
    const authorizerSigner = await buildTronAuthorizerSigner();
    facilitator.register(caip, new BatchSettlementTronScheme(signer, authorizerSigner));
    logger.info("Registered batch-settlement (TRON)", {
      network,
      receiverAuthorizer: authorizerSigner.address,
    });
  }
}

/**
 * Register the enabled schemes for one EVM network. Symmetric with the TRON
 * handler; EVM exact takes no facilitator fee and has no gasfree variant.
 */
async function registerEvmNetwork(setup: NetworkSetup): Promise<void> {
  const { facilitator, network, caip, has } = setup;
  const signer = await buildEvmFacilitatorSigner(network);

  if (has("exact")) {
    registerExactEvmScheme(facilitator, { signer, networks: caip });
    logger.info("Registered exact (EVM)", { network });
  }

  if (has("upto")) {
    // No register helper on EVM upto — register the scheme class directly.
    facilitator.register(caip, new UptoEvmScheme(signer));
    logger.info("Registered upto (EVM)", { network });
  }

  if (has("batch-settlement")) {
    const authorizerSigner = await buildEvmAuthorizerSigner();
    facilitator.register(caip, new BatchSettlementEvmScheme(signer, authorizerSigner));
    logger.info("Registered batch-settlement (EVM)", {
      network,
      receiverAuthorizer: authorizerSigner.address,
    });
  }
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
  // createFacilitator() = new x402Facilitator() with the SDK's structured
  // verify/settle logging hooks pre-attached; output flows through the global
  // logger wired in src/index.ts.
  const facilitator = createFacilitator();
  const networks = cfg.facilitator.networks ?? {};

  for (const network of enabledNetworks(cfg)) {
    const net = networks[network];
    const setup: NetworkSetup = {
      facilitator,
      network,
      // enabledNetworks yields plain strings; the scheme registrars / `register`
      // expect a CAIP-2 network id (`namespace:reference`).
      caip: network as `${string}:${string}`,
      // Schemes default to ["exact"] when omitted (back-compat with v1 behaviour).
      has: (s: Scheme) => (net?.schemes ?? ["exact"]).includes(s),
      fee: toFeeConfig(net),
    };

    if (isTron(network)) {
      await registerTronNetwork(setup, opts);
    } else if (isEvm(network)) {
      await registerEvmNetwork(setup);
    } else {
      logger.warn("Unsupported network; skipped", { network });
    }
  }

  return facilitator;
}
