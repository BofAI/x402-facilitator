/**
 * Unified network registry (P2-01).
 *
 * Single source of truth for every supported canonical CAIP-2 network, its chain
 * family, RPC, and chain id. Configuration uses these identifiers directly, so
 * they flow unchanged to signers, scheme registration, /supported, and GasFree.
 */
import { TRON_MAINNET, TRON_NILE, TRON_SHASTA } from "@bankofai/x402-tron";

export type NetworkFamily = "tron" | "evm";

/**
 * Canonical CAIP-2 identifier (e.g. "eip155:97", "tron:0xcd8690dc").
 *
 * Typed as a template-literal so it is assignable to the SDK's `Network`
 * (`${string}:${string}`) without a cast.
 */
export type CanonicalNetwork = `${string}:${string}`;

interface NetworkEntry {
  canonical: CanonicalNetwork;
  family: NetworkFamily;
  rpc: string;
  /** Optional environment override for the primary RPC. */
  rpcEnv?: string;
  /** Independent endpoint used only to confirm EVM transaction receipts. */
  receiptRpc?: string;
  /** Optional environment override for the receipt fallback RPC. */
  receiptRpcEnv?: string;
  /** Numeric chain id for EVM; undefined for TRON. */
  chainId?: number;
}

/**
 * The registry. Add a network here once and it flows to signers, scheme
 * registration, /supported, and GasFree wiring.
 */
const REGISTRY: readonly NetworkEntry[] = [
  {
    canonical: TRON_MAINNET as CanonicalNetwork,
    family: "tron",
    rpc: "https://api.trongrid.io",
  },
  {
    canonical: TRON_NILE as CanonicalNetwork,
    family: "tron",
    rpc: "https://nile.trongrid.io",
  },
  {
    canonical: TRON_SHASTA as CanonicalNetwork,
    family: "tron",
    rpc: "https://api.shasta.trongrid.io",
  },
  {
    canonical: "eip155:97" as CanonicalNetwork,
    family: "evm",
    rpc: "https://bsc-testnet-rpc.publicnode.com",
    chainId: 97,
  },
  {
    canonical: "eip155:56" as CanonicalNetwork,
    family: "evm",
    rpc: "https://bsc-dataseed.bnbchain.org",
    rpcEnv: "BSC_MAINNET_RPC_URL",
    receiptRpc: "https://bsc-dataseed-public.bnbchain.org",
    receiptRpcEnv: "BSC_MAINNET_RECEIPT_RPC_URL",
    chainId: 56,
  },
  {
    canonical: "eip155:8453" as CanonicalNetwork,
    family: "evm",
    rpc: "https://mainnet.base.org",
    chainId: 8453,
  },
  {
    canonical: "eip155:84532" as CanonicalNetwork,
    family: "evm",
    rpc: "https://sepolia.base.org",
    chainId: 84532,
  },
];

/** Lookup table of supported canonical CAIP-2 identifiers. */
const BY_CAIP: Map<string, NetworkEntry> = (() => {
  const m = new Map<string, NetworkEntry>();
  for (const e of REGISTRY) m.set(e.canonical, e);
  return m;
})();

/**
 * Validate a canonical CAIP-2 identifier from configuration. The returned value is
 * exactly the input; no alias resolution or identifier conversion is performed.
 */
export function requireCanonicalNetwork(input: string): CanonicalNetwork {
  if (!BY_CAIP.has(input)) throw new Error(`Unsupported canonical CAIP-2 network: ${input}`);
  return input as CanonicalNetwork;
}

/** Chain family for a supported canonical network. */
export function familyOf(canonical: CanonicalNetwork): NetworkFamily {
  const entry = BY_CAIP.get(canonical);
  if (!entry) throw new Error(`Unsupported or unknown network: ${canonical}`);
  return entry.family;
}

/** RPC endpoint for a supported canonical network. */
export function rpcFor(canonical: CanonicalNetwork): string {
  const entry = BY_CAIP.get(canonical);
  if (!entry) throw new Error(`Unsupported or unknown network: ${canonical}`);
  const override = entry.rpcEnv ? process.env[entry.rpcEnv]?.trim() : undefined;
  return override || entry.rpc;
}

/** Optional independent RPC used only when the primary receipt query fails. */
export function receiptRpcFor(canonical: CanonicalNetwork): string | undefined {
  const entry = BY_CAIP.get(canonical);
  if (!entry) throw new Error(`Unsupported or unknown network: ${canonical}`);
  const override = entry.receiptRpcEnv
    ? process.env[entry.receiptRpcEnv]?.trim()
    : undefined;
  return override || entry.receiptRpc;
}

/** Numeric chain id for an EVM canonical network (undefined for TRON). */
export function chainIdOf(canonical: CanonicalNetwork): number | undefined {
  const entry = BY_CAIP.get(canonical);
  if (!entry) throw new Error(`Unsupported or unknown network: ${canonical}`);
  return entry.chainId;
}
