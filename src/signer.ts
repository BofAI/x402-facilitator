/**
 * Facilitator signer construction.
 *
 * Like the v1 service, this process never holds settlement private keys. Wallets
 * are resolved through the @bankofai/agent-wallet provider (config- or env-based,
 * unlocked out-of-band via AGENT_WALLET_PASSWORD); the key stays inside the wallet
 * and only signing operations cross the boundary.
 *
 * The SDK's `create*FacilitatorSigner` factories take the agent-wallet
 * directly and build the chain client (TronWeb / viem) internally from the CAIP-2
 * network id. The transaction is built by the SDK, handed to the wallet to sign,
 * then broadcast — the raw key never enters the SDK.
 */
import { resolveWallet, type Wallet } from "@bankofai/agent-wallet";
import {
  createFacilitatorTronSigner,
  createAuthorizerTronSigner,
  type FacilitatorTronSigner,
  type TronAuthorizerSignerLike,
} from "@bankofai/x402-tron";
import {
  rpcFor,
  chainIdOf,
  type CanonicalNetwork,
} from "./network.js";
import {
  createFacilitatorEvmSigner,
  createAuthorizerEvmSigner,
  type EvmAuthorizerSigner,
  type GasSponsoringFacilitatorEvmSigner,
} from "@bankofai/x402-evm/adapters/agent-wallet";

/**
 * A resolved agent-wallet that also signs typed data. `resolveWallet` is typed as
 * the base `Wallet` (no `signTypedData`), but for `evm`/`tron` it returns an
 * `EvmSigner`/`TronSigner` (both `Eip712Capable`). The batch-settlement scheme
 * uses `signTypedData` to act as the receiver-authorizer.
 */
type SignerWallet = Wallet & {
  signTypedData(data: Record<string, unknown>, options?: unknown): Promise<string>;
};

/**
 * Build a TRON facilitator signer for a given network, backed by the active
 * agent-wallet (no private key in this process). The SDK builds TronWeb
 * internally from the network id; `rpcUrl` pins our fullHost and `apiKey`
 * forwards the optional TronGrid key.
 *
 * @param network - Config network id (e.g. "tron:nile"); normalized to canonical
 *   CAIP-2 (hex chain id) before being handed to the SDK.
 * @returns A FacilitatorTronSigner bound to that network's TronWeb host.
 */
export async function buildTronFacilitatorSigner(canonical: CanonicalNetwork): Promise<FacilitatorTronSigner> {
  const fullHost = rpcFor(canonical);
  const wallet: Wallet = await resolveWallet({ network: "tron" });
  return createFacilitatorTronSigner(wallet, {
    network: canonical,
    rpcUrl: fullHost,
    apiKey: process.env.TRON_GRID_API_KEY,
  });
}

/**
 * Build an EVM facilitator signer for a given network. The SDK builds the viem
 * public client (reads / verification / broadcast) internally from the CAIP-2
 * network id; `rpcUrl` pins our endpoint. Signing is delegated to the active
 * agent-wallet (symmetric with TRON).
 *
 * @param network - Config network id (e.g. "bsc:testnet").
 * @returns A FacilitatorEvmSigner for that chain.
 */
export async function buildEvmFacilitatorSigner(
  canonical: CanonicalNetwork,
  rpcUrl?: string,
): Promise<GasSponsoringFacilitatorEvmSigner> {
  const chainId = chainIdOf(canonical);
  if (chainId === undefined) throw new Error(`Not an EVM network: ${canonical}`);

  // agent-wallet's parseNetworkFamily accepts only "tron"/"eip155" (or their CAIP
  // forms), NOT the Network enum value "evm" — an asymmetry in agent-wallet 2.4.0
  // (Network.EVM === "evm", yet the input parser rejects "evm" and maps "eip155" to
  // it). v1 sidestepped this entirely (EvmFacilitatorSigner.create() resolved the
  // eip155 wallet with no network arg). Pass the family token agent-wallet expects;
  // the EVM key is chain-agnostic so the family alone suffices.
  const wallet: Wallet = await resolveWallet({ network: "eip155" });

  // The SDK derives the chainId from the CAIP-2 reference (eip155:<chainId>) and
  // resolves chain metadata from its KNOWN_CHAINS table (BSC 56/97 included),
  // using `rpcUrl` for the transport. The wallet signs the built tx — no raw key
  // in the SDK — and the gas-sponsoring `sendTransactions` capability rides along.
  return createFacilitatorEvmSigner(wallet, {
    network: `eip155:${chainId}`,
    rpcUrl: rpcFor(canonical, rpcUrl),
  });
}

/**
 * Build the EVM receiver-authorizer signer (typed-data only), backed by the same
 * agent-wallet as the settlement signer. The batch-settlement scheme uses it to
 * sign ClaimBatch / Refund EIP-712 digests; its address is published as
 * `receiverAuthorizer` and embedded by the server into every channel config. In
 * production this may be a separate key (the receiver retaining claim authority).
 *
 * @returns An EvmAuthorizerSigner ({ address, signTypedData }).
 */
export async function buildEvmAuthorizerSigner(): Promise<EvmAuthorizerSigner> {
  // Same family token as buildEvmFacilitatorSigner — one wallet, two roles.
  const wallet = (await resolveWallet({ network: "eip155" })) as SignerWallet;
  return createAuthorizerEvmSigner(wallet);
}

/**
 * Build the TRON receiver-authorizer signer — the TRON counterpart of
 * {@link buildEvmAuthorizerSigner}. Signs ClaimBatch / Refund TIP-712 digests;
 * the SDK normalizes addresses to EVM-hex inside the typed data.
 *
 * @returns A TRON authorizer signer ({ address, signTypedData }).
 */
export async function buildTronAuthorizerSigner(): Promise<TronAuthorizerSignerLike> {
  const wallet = (await resolveWallet({ network: "tron" })) as SignerWallet;
  return createAuthorizerTronSigner(wallet);
}
