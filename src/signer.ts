/**
 * Facilitator signer construction.
 *
 * Like the v1 service, this process never holds settlement private keys. Wallets
 * are resolved through the @bankofai/agent-wallet provider (config- or env-based,
 * unlocked out-of-band via AGENT_WALLET_PASSWORD); the key stays inside the wallet
 * and only signing operations cross the boundary.
 *
 * The upstream signer factories accept a wallet abstraction whose `signTransaction`
 * / `signTypedData` are delegated to the resolved agent-wallet.
 */
import { TronWeb } from "tronweb";
import { resolveWallet, type Wallet } from "@bankofai/agent-wallet";
import { createFacilitatorTronSigner, type FacilitatorTronSigner } from "@bankofai/x402-tron";
import type { FacilitatorEvmSigner } from "@bankofai/x402-evm";
import {
  createFacilitatorEvmSigner,
  type FacilitatorEvmPublicClient,
} from "@bankofai/x402-evm/facilitator/agent-wallet";
import { createPublicClient, http, defineChain } from "viem";

/** TronGrid full-host per TRON network. */
const TRON_FULL_HOST: Record<string, string> = {
  "tron:nile": "https://nile.trongrid.io",
  "tron:shasta": "https://api.shasta.trongrid.io",
  "tron:mainnet": "https://api.trongrid.io",
};

/** EVM RPC + numeric chainId per supported EVM network. */
const EVM_CHAINS: Record<string, { id: number; rpc: string; name: string }> = {
  "bsc:testnet": { id: 97, rpc: "https://bsc-testnet-rpc.publicnode.com", name: "BSC Testnet" },
  "bsc:mainnet": { id: 56, rpc: "https://bsc-rpc.publicnode.com", name: "BSC Mainnet" },
};

/**
 * Build a TRON facilitator signer for a given network, backed by the active
 * agent-wallet (no private key in this process).
 *
 * @param network - CAIP network id (e.g. "tron:nile").
 * @returns A FacilitatorTronSigner bound to that network's TronWeb host.
 */
export async function buildTronFacilitatorSigner(network: string): Promise<FacilitatorTronSigner> {
  const fullHost = TRON_FULL_HOST[network];
  if (!fullHost) throw new Error(`Unsupported TRON network: ${network}`);

  const wallet: Wallet = await resolveWallet({ network: "tron" });
  const address = await wallet.getAddress();

  const headers = process.env.TRON_GRID_API_KEY
    ? { "TRON-PRO-API-KEY": process.env.TRON_GRID_API_KEY }
    : undefined;
  // No privateKey: reads/tx-building only; signing is delegated to the wallet.
  const tronWeb = new TronWeb({ fullHost, headers });
  tronWeb.setAddress(address);

  return createFacilitatorTronSigner(tronWeb, {
    address,
    signTransaction: (transaction) => wallet.signTransaction(transaction),
  });
}

/**
 * Build an EVM facilitator signer for a given network. Chain reads/verification/
 * broadcast use a viem public client; signing is delegated to the active
 * agent-wallet via the SDK's wallet-bridge factory (symmetric with TRON).
 *
 * @param network - CAIP network id (e.g. "bsc:testnet").
 * @returns A FacilitatorEvmSigner for that chain.
 */
export async function buildEvmFacilitatorSigner(network: string): Promise<FacilitatorEvmSigner> {
  const chainCfg = EVM_CHAINS[network];
  if (!chainCfg) throw new Error(`Unsupported EVM network: ${network}`);

  // agent-wallet's parseNetworkFamily accepts only "tron"/"eip155" (or their CAIP
  // forms), NOT the Network enum value "evm" — an asymmetry in agent-wallet 2.4.0
  // (Network.EVM === "evm", yet the input parser rejects "evm" and maps "eip155" to
  // it). v1 sidestepped this entirely (EvmFacilitatorSigner.create() resolved the
  // eip155 wallet with no network arg). Pass the family token agent-wallet expects;
  // the EVM key is chain-agnostic so the family alone suffices.
  const wallet: Wallet = await resolveWallet({ network: "eip155" });
  const address = (await wallet.getAddress()) as `0x${string}`;

  const chain = defineChain({
    id: chainCfg.id,
    name: chainCfg.name,
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: { default: { http: [chainCfg.rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http() });

  // createFacilitatorEvmSigner builds/signs/broadcasts internally (resolved SDK
  // issue #1); the key never leaves the wallet. It also normalizes the missing
  // `0x` prefix from agent-wallet (#2), so no workaround is needed here.
  //
  // The cast bridges SDK issue #5: FacilitatorEvmPublicClient declares
  // verifyTypedData/readContract params as Record<string,unknown>, which a real
  // viem PublicClient does NOT satisfy under strictFunctionTypes (its params are
  // stricter). viem genuinely provides every method, so narrowing the client to
  // the SDK's interface type is sound.
  return createFacilitatorEvmSigner(publicClient as unknown as FacilitatorEvmPublicClient, {
    address,
    signTransaction: (tx) => wallet.signTransaction(tx),
  });
}
