/**
 * Facilitator signer construction.
 *
 * Like the v1 service, this process never holds settlement private keys. Wallets
 * are resolved through the @bankofai/agent-wallet provider (config- or env-based,
 * unlocked out-of-band via AGENT_WALLET_PASSWORD); the key stays inside the wallet
 * and only signing operations cross the boundary.
 *
 * The SDK's `create*FacilitatorSigner` factories (beta.1) take the agent-wallet
 * directly and build the chain client (TronWeb / viem) internally from the CAIP-2
 * network id. The transaction is built by the SDK, handed to the wallet to sign,
 * then broadcast — the raw key never enters the SDK.
 */
import { resolveWallet, type Wallet } from "@bankofai/agent-wallet";
import {
  createFacilitatorTronSigner,
  createAuthorizerTronSigner,
  TRON_MAINNET,
  TRON_NILE,
  TRON_SHASTA,
  type FacilitatorTronSigner,
  type TronAuthorizerSignerLike,
} from "@bankofai/x402-tron";
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
 * Human-friendly TRON network aliases -> canonical CAIP-2 (hex chain id). The
 * x402 SDK (1.0.1+) identifies TRON networks by hex chain id in CAIP-2 (e.g.
 * `tron:0x2b6653dc`); config may use friendly names which we normalize so every
 * value handed to the SDK is in canonical form.
 */
const TRON_CAIP_ALIASES: Record<string, string> = {
  "tron:mainnet": TRON_MAINNET,
  "tron:nile": TRON_NILE,
  "tron:shasta": TRON_SHASTA,
};

/** TronGrid full-host per TRON network, keyed by canonical CAIP-2 (SDK constant). */
const TRON_FULL_HOST: Record<string, string> = {
  [TRON_NILE]: "https://nile.trongrid.io",
  [TRON_SHASTA]: "https://api.shasta.trongrid.io",
  [TRON_MAINNET]: "https://api.trongrid.io",
};

/** EVM RPC + numeric chainId per supported EVM network. */
const EVM_CHAINS: Record<string, { id: number; rpc: string }> = {
  "bsc:testnet": { id: 97, rpc: "https://bsc-testnet-rpc.publicnode.com" },
  "bsc:mainnet": { id: 56, rpc: "https://bsc-rpc.publicnode.com" },
};

/**
 * Normalize a config network id to its canonical CAIP-2 form. EVM chains have no
 * `bsc` namespace in CAIP-2 — they are all `eip155:<chainId>` — so config aliases
 * like `bsc:testnet` map to `eip155:97` (chainId sourced from EVM_CHAINS, the same
 * table the signer connects with, so the registered/advertised id can't drift from
 * the chain the signer actually talks to). TRON friendly names (`tron:mainnet`)
 * normalize to the SDK's hex-chain-id CAIP-2 (`tron:0x2b6653dc`); ids already in
 * canonical form pass through unchanged. This is what the facilitator registers
 * and exposes via /supported.
 */
export function toCaip(network: string): `${string}:${string}` {
  const evm = EVM_CHAINS[network];
  if (evm) return `eip155:${evm.id}`;
  const tronAlias = TRON_CAIP_ALIASES[network];
  if (tronAlias) return tronAlias as `${string}:${string}`;
  return network as `${string}:${string}`;
}

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
export async function buildTronFacilitatorSigner(network: string): Promise<FacilitatorTronSigner> {
  const caip = toCaip(network);
  const fullHost = TRON_FULL_HOST[caip];
  if (!fullHost) throw new Error(`Unsupported TRON network: ${network}`);

  const wallet: Wallet = await resolveWallet({ network: "tron" });

  return createFacilitatorTronSigner(wallet, {
    network: caip,
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
  network: string,
): Promise<GasSponsoringFacilitatorEvmSigner> {
  const chainCfg = EVM_CHAINS[network];
  if (!chainCfg) throw new Error(`Unsupported EVM network: ${network}`);

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
    network: `eip155:${chainCfg.id}`,
    rpcUrl: chainCfg.rpc,
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
