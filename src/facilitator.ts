/**
 * Builds the x402Facilitator and registers scheme/network handlers from config.
 * Each network's `schemes` list (default: all schemes) selects what to register:
 *   - exact            -> TRON: eip3009/permit2 (+ exact_gasfree when creds resolve)
 *                         EVM:  eip3009/permit2 (+ ERC-20 approval gas sponsoring)
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
import {
  createErc20ApprovalGasSponsoringExtension,
  type Erc20ApprovalGasSponsoringSigner,
} from "@bankofai/x402-extensions";
import type { GasSponsoringFacilitatorEvmSigner } from "@bankofai/x402-evm/adapters/agent-wallet";
import {
  buildTronFacilitatorSigner,
  buildEvmFacilitatorSigner,
  buildTronAuthorizerSigner,
  buildEvmAuthorizerSigner,
  toCaip,
} from "./signer.js";
import {
  type FacilitatorConfig,
  type NetworkConfig,
  type Scheme,
  ALL_SCHEMES,
  enabledNetworks,
} from "./config.js";
import { logger } from "./logger.js";

export interface BuildFacilitatorOptions {
  /** Returns the co-located GasFree proxy base URL for a TRON network, or null to skip gasfree. */
  gasfreeBaseUrlFor: (network: string) => string | null;
}

const isTron = (n: string) => n.startsWith("tron:");
const isEvm = (n: string) => n.startsWith("bsc:") || n.startsWith("eip155:") || n.startsWith("eth:");

/** Per-network registration context shared by the chain handlers. */
interface NetworkSetup {
  facilitator: x402Facilitator;
  /** Raw config network string (gasfree lookup + logging). */
  network: string;
  /** CAIP-2 form the scheme registrars / `register` expect. */
  caip: `${string}:${string}`;
  /** Whether a scheme is enabled for this network. */
  has: (s: Scheme) => boolean;
}

/**
 * Register the enabled schemes for one TRON network. One signer serves every
 * scheme (built once); batch-settlement additionally resolves the receiver-
 * authorizer (same agent-wallet, exposing its typed-data signing role).
 */
async function registerTronNetwork(setup: NetworkSetup, opts: BuildFacilitatorOptions): Promise<void> {
  const { facilitator, network, caip, has } = setup;
  const signer = await buildTronFacilitatorSigner(network);

  if (has("exact")) {
    registerExactTronScheme(facilitator, { signer, networks: caip });

    const gasfreeBase = opts.gasfreeBaseUrlFor(caip);
    if (gasfreeBase) {
      // Point the GasFree client at this service's co-located proxy, which adds
      // HMAC auth and forwards to the official relayer.
      registerExactGasFreeTronScheme(facilitator, {
        signer,
        networks: caip,
        apiBaseUrls: { [caip]: gasfreeBase },
      });
      logger.info("Registered exact + exact_gasfree", { network, gasfreeBase });
    } else {
      logger.info("Registered exact (GasFree creds absent; gasfree skipped)", { network });
    }
  }

  if (has("upto")) {
    // beta.3 aligned TRON with EVM: register the scheme class directly.
    facilitator.register(caip, new UptoTronScheme(signer));
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
 * handler; EVM has no gasfree variant.
 */
async function registerEvmNetwork(setup: NetworkSetup): Promise<GasSponsoringFacilitatorEvmSigner> {
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

  return signer;
}

function registerEvmGasSponsoringExtension(
  facilitator: x402Facilitator,
  signers: Record<string, GasSponsoringFacilitatorEvmSigner>,
): void {
  const defaultSigner = Object.values(signers)[0];
  if (!defaultSigner) return;

  facilitator.registerExtension(
    createErc20ApprovalGasSponsoringExtension(
      defaultSigner as Erc20ApprovalGasSponsoringSigner,
      network => signers[network] as Erc20ApprovalGasSponsoringSigner | undefined,
    ),
  );
  logger.info("Registered ERC-20 approval gas-sponsoring extension (EVM)", {
    networks: Object.keys(signers),
  });
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
  const evmGasSponsoringSigners: Record<string, GasSponsoringFacilitatorEvmSigner> = {};

  for (const network of enabledNetworks(cfg)) {
    const net = networks[network];
    const setup: NetworkSetup = {
      facilitator,
      network,
      // enabledNetworks yields raw config ids; normalize to canonical CAIP-2 for
      // the scheme registrars / `register` (e.g. config `bsc:testnet` -> eip155:97).
      caip: toCaip(network),
      // Schemes default to all schemes when omitted.
      has: (s: Scheme) => (net?.schemes ?? ALL_SCHEMES).includes(s),
    };

    if (isTron(network)) {
      await registerTronNetwork(setup, opts);
    } else if (isEvm(network)) {
      evmGasSponsoringSigners[setup.caip] = await registerEvmNetwork(setup);
    } else {
      logger.warn("Unsupported network; skipped", { network });
    }
  }

  registerEvmGasSponsoringExtension(facilitator, evmGasSponsoringSigners);

  return facilitator;
}
