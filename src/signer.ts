/**
 * Facilitator signer construction.
 *
 * Wallets are resolved through the @bankofai/agent-wallet provider. External
 * wallet_cli/Privy providers keep keys outside this process; raw_secret providers
 * hold keys inside the wallet. Only signing operations cross the SDK boundary.
 *
 * The SDK's `create*FacilitatorSigner` factories take the agent-wallet
 * directly and build the chain client (TronWeb / viem) internally from the CAIP-2
 * network id. The transaction is built by the SDK, handed to the wallet to sign,
 * then broadcast — the raw key never enters the SDK.
 */
import { resolveWallet, type Wallet, type Eip712Capable } from "@bankofai/agent-wallet";
import {
  createFacilitatorTronSigner,
  createAuthorizerTronSigner,
  type FacilitatorTronSigner,
  type TronAuthorizerSignerLike,
} from "@bankofai/x402-tron";
import {
  rpcFor,
  receiptRpcFor,
  chainIdOf,
  type CanonicalNetwork,
} from "./network.js";
import { createReceiptWaiter, withReceiptFallback } from "./evm-receipt.js";
import {
  createFacilitatorEvmSigner,
  createAuthorizerEvmSigner,
  type EvmAuthorizerSigner,
  type GasSponsoringFacilitatorEvmSigner,
} from "@bankofai/x402-evm/adapters/agent-wallet";

/**
 * The base Wallet contract does not promise typed-data capability. Check it
 * before constructing the batch-settlement receiver-authorizer.
 */
function requireTypedData(wallet: Wallet): Wallet & Eip712Capable {
  if (!("signTypedData" in wallet) || typeof wallet.signTypedData !== "function") {
    throw new Error("Wallet does not support typed-data signing");
  }
  return wallet as Wallet & Eip712Capable;
}

/**
 * Build a TRON facilitator signer for a given network, backed by the active
 * agent-wallet. The SDK builds TronWeb
 * internally from the network id; `rpcUrl` pins our fullHost and `apiKey`
 * forwards the optional TronGrid key.
 *
 * @param network - Canonical CAIP-2 network id (e.g. "tron:0xcd8690dc").
 * @returns A FacilitatorTronSigner bound to that network's TronWeb host.
 */
export async function buildTronFacilitatorSigner(canonical: CanonicalNetwork): Promise<FacilitatorTronSigner> {
  const fullHost = rpcFor(canonical);
  const wallet = await resolveWallet({ network: canonical });
  return createFacilitatorTronSigner({
    getAddress: () => wallet.getAddress(),
    async signTransaction(payload) {
      const signed = await wallet.signTransaction(payload);
      if (signed.family !== "tron") throw new Error("Expected TRON signed transaction artifact");
      return signed.transaction;
    },
  }, {
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
 * @param network - Canonical CAIP-2 network id (e.g. "eip155:97").
 * @returns A FacilitatorEvmSigner for that chain.
 */
export async function buildEvmFacilitatorSigner(
  canonical: CanonicalNetwork,
): Promise<GasSponsoringFacilitatorEvmSigner> {
  const chainId = chainIdOf(canonical);
  if (chainId === undefined) throw new Error(`Not an EVM network: ${canonical}`);

  const wallet = await resolveWallet({ network: canonical });

  // The SDK derives the chainId from the CAIP-2 reference (eip155:<chainId>) and
  // resolves chain metadata from its KNOWN_CHAINS table (BSC 56/97 included),
  // using the registry RPC endpoint for the transport. The wallet signs the built tx — no raw key
  // in the SDK — and the gas-sponsoring `sendTransactions` capability rides along.
  const primaryRpcUrl = rpcFor(canonical);
  const signer = await createFacilitatorEvmSigner({
    getAddress: () => wallet.getAddress(),
    async signTransaction(payload) {
      const signed = await wallet.signTransaction(payload);
      if (signed.family !== "evm") throw new Error("Expected EVM signed transaction artifact");
      return signed.rawTransaction;
    },
  }, {
    network: `eip155:${chainId}`,
    rpcUrl: primaryRpcUrl,
  });

  const fallbackRpcUrl = receiptRpcFor(canonical);
  if (!fallbackRpcUrl || fallbackRpcUrl === primaryRpcUrl) return signer;

  return withReceiptFallback(signer, {
    network: canonical,
    primary: createReceiptWaiter(chainId, primaryRpcUrl, 15_000),
    fallback: createReceiptWaiter(chainId, fallbackRpcUrl, 45_000),
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
export async function buildEvmAuthorizerSigner(canonical: CanonicalNetwork = "eip155:1"): Promise<EvmAuthorizerSigner> {
  // Mainnet default retains legacy no-argument callers; production passes its network.
  const wallet = requireTypedData(await resolveWallet({ network: canonical }));
  return createAuthorizerEvmSigner(wallet);
}

/**
 * Build the TRON receiver-authorizer signer — the TRON counterpart of
 * {@link buildEvmAuthorizerSigner}. Signs ClaimBatch / Refund TIP-712 digests;
 * the SDK normalizes addresses to EVM-hex inside the typed data.
 *
 * @returns A TRON authorizer signer ({ address, signTypedData }).
 */
export async function buildTronAuthorizerSigner(canonical: CanonicalNetwork = "tron:728126428"): Promise<TronAuthorizerSignerLike> {
  // Mainnet default retains legacy no-argument callers; production passes its network.
  const wallet = requireTypedData(await resolveWallet({ network: canonical }));
  return createAuthorizerTronSigner(wallet);
}
