/**
 * Unified network registry (P2-01).
 *
 * Single source of truth for every supported network: canonical CAIP-2, friendly
 * aliases, chain family, RPC, and chain id. Config may use any registered form
 * (alias or canonical); everything is normalized to the canonical key once, and
 * all downstream code (signer construction, scheme registration, /supported,
 * GasFree wiring) operates exclusively on canonical identifiers.
 *
 * This replaces the scattered TRON_CAIP_ALIASES / EVM_CHAINS / toCaip / isTron /
 * isEvm logic, closing P0-04 (canonical ids weren't accepted) and P1-10 (alias +
 * canonical of the same chain registered twice) by resolving any input to one
 * canonical key before registration.
 */
import { TRON_MAINNET, TRON_NILE, TRON_SHASTA } from "@bankofai/x402-tron";

export type NetworkFamily = "tron" | "evm";

/**
 * Canonical CAIP-2 identifier (e.g. "eip155:97", "tron:0xcd8690dc").
 *
 * Typed as a template-literal so it is assignable to the SDK's `Network`
 * (`${string}:${string}`) without a cast, while still reading as "the normalized
 * form" at call sites — only `normalize()` produces this type.
 */
export type CanonicalNetwork = `${string}:${string}`;

/** Raw network id as written in config (alias or canonical, unvalidated). */
export type ConfigNetwork = string;

interface NetworkEntry {
  canonical: CanonicalNetwork;
  aliases: readonly string[];
  family: NetworkFamily;
  rpc: string;
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
    aliases: ["tron:mainnet"],
    family: "tron",
    rpc: "https://api.trongrid.io",
  },
  {
    canonical: TRON_NILE as CanonicalNetwork,
    aliases: ["tron:nile"],
    family: "tron",
    rpc: "https://nile.trongrid.io",
  },
  {
    canonical: TRON_SHASTA as CanonicalNetwork,
    aliases: ["tron:shasta"],
    family: "tron",
    rpc: "https://api.shasta.trongrid.io",
  },
  {
    canonical: "eip155:97" as CanonicalNetwork,
    aliases: ["bsc:testnet"],
    family: "evm",
    rpc: "https://bsc-testnet-rpc.publicnode.com",
    chainId: 97,
  },
  {
    canonical: "eip155:56" as CanonicalNetwork,
    aliases: ["bsc:mainnet"],
    family: "evm",
    rpc: "https://bsc-rpc.publicnode.com",
    chainId: 56,
  },
];

/** Lookup table: every accepted input (canonical + aliases) -> entry. */
const BY_INPUT: Map<string, NetworkEntry> = (() => {
  const m = new Map<string, NetworkEntry>();
  for (const e of REGISTRY) {
    m.set(e.canonical, e);
    for (const a of e.aliases) m.set(a, e);
  }
  return m;
})();

/**
 * Normalize any registered input (alias or canonical) to its canonical CAIP-2.
 * Throws on unknown networks so misconfiguration fails fast at startup.
 */
export function normalize(input: ConfigNetwork): CanonicalNetwork {
  const entry = BY_INPUT.get(input);
  if (!entry) throw new Error(`Unsupported or unknown network: ${input}`);
  return entry.canonical;
}

/** Chain family for a canonical network, or null if unregistered. */
export function familyOf(canonical: CanonicalNetwork): NetworkFamily {
  const entry = BY_INPUT.get(canonical);
  if (!entry) throw new Error(`Unsupported or unknown network: ${canonical}`);
  return entry.family;
}

/** RPC endpoint for a canonical network. */
export function rpcFor(canonical: CanonicalNetwork): string {
  const entry = BY_INPUT.get(canonical);
  if (!entry) throw new Error(`Unsupported or unknown network: ${canonical}`);
  return entry.rpc;
}

/** Numeric chain id for an EVM canonical network (undefined for TRON). */
export function chainIdOf(canonical: CanonicalNetwork): number | undefined {
  const entry = BY_INPUT.get(canonical);
  if (!entry) throw new Error(`Unsupported or unknown network: ${canonical}`);
  return entry.chainId;
}
