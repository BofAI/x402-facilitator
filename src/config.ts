/**
 * Configuration loading + secret resolution. Faithful port of legacy/src/config.py.
 *
 * The YAML shape is unchanged from v1 (minus /fee/quote). Secrets are resolved on
 * demand: each value under `onepassword.*` is a `vault/item/field` reference resolved
 * via @1password/sdk when OP_SERVICE_ACCOUNT_TOKEN (or onepassword.token) is set.
 * Environment variables always take precedence over 1Password.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { getSecretFromOnePassword, isUsableToken, parseOpRef } from "./onepassword.js";
import { logger, type Level } from "./logger.js";
import { normalize } from "./network.js";

/** Payment schemes a network can enable. `exact_gasfree` (TRON) rides with `exact`. */
export type Scheme = "exact" | "upto" | "batch-settlement";

/** Every payment scheme — the default registered for a network when `schemes` is omitted. */
export const ALL_SCHEMES: readonly Scheme[] = ["exact", "upto", "batch-settlement"];
const BASE_USDC_ASSETS: Readonly<Record<string, string>> = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};

export interface NetworkConfig {
  /** Schemes to register for this network. Defaults to all schemes when omitted. */
  schemes?: Scheme[];
  /** Optional production RPC override. */
  rpc_url?: string;
  rpcUrl?: string;
  /** Optional token contract allowlist for verify/settle. */
  assets?: string[];
  /** Whether this network participates in the ERC-20 gas-sponsoring extension. */
  gas_sponsoring?: boolean;
}

export interface FacilitatorConfig {
  server?: { host?: string; port?: number };
  logging?: {
    level?: "debug" | "info" | "warn" | "error";
    /** Directory for the log file; combined with `filename`. File logging is off unless both are set. */
    dir?: string;
    /** Log file name (fixed; not timestamped). Written in append mode across restarts. */
    filename?: string;
  };
  database: {
    url: string;
    ssl_mode?: string;
    max_open_conns?: number;
    max_idle_conns?: number;
    max_life_time?: number;
  };
  onepassword?: Record<string, string | undefined> & { token?: string };
  rate_limit?: {
    api_key_refresh_interval?: number;
    authenticated?: string;
    anonymous?: string;
  };
  monitoring?: { port?: number; endpoint?: string };
  facilitator: {
    trongrid_api_key?: string;
    networks: Record<string, NetworkConfig>;
  };
}

const DEFAULT_PATH = process.env.FACILITATOR_CONFIG_PATH
  ? resolve(process.env.FACILITATOR_CONFIG_PATH)
  : resolve(process.cwd(), "config/facilitator.config.yaml");

/**
 * Load, parse and validate the facilitator YAML config from disk.
 *
 * @param path - Optional explicit path; defaults to FACILITATOR_CONFIG_PATH or config/facilitator.config.yaml.
 * @returns The parsed configuration object.
 */
export function loadConfig(path: string = DEFAULT_PATH): FacilitatorConfig {
  const raw = readFileSync(path, "utf8");
  const cfg = (parse(raw) as FacilitatorConfig) ?? ({} as FacilitatorConfig);
  validateRequired(cfg);
  return cfg;
}

/** Force a startup failure when critical config is missing (mirrors v1 _validate_required). */
function validateRequired(cfg: FacilitatorConfig): void {
  const errors: string[] = [];
  if (!cfg.database?.url) errors.push("database.url is required and must be non-empty");
  const networks = cfg.facilitator?.networks;
  if (!networks || typeof networks !== "object" || Object.keys(networks).length === 0) {
    errors.push("facilitator.networks is required and must be a non-empty object");
  }
  if (errors.length) {
    throw new Error("Configuration validation failed. " + errors.join(" "));
  }
}

/** List of enabled CAIP network ids from config (listed = enabled). */
export function enabledNetworks(cfg: FacilitatorConfig): string[] {
  return Object.keys(cfg.facilitator.networks ?? {});
}

/** Canonical per-network asset allowlists used by the HTTP verify/settle boundary. */
export function configuredAssetAllowlists(
  cfg: FacilitatorConfig,
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [network, value] of Object.entries(cfg.facilitator.networks ?? {})) {
    const canonical = normalize(network);
    const baseUsdc = BASE_USDC_ASSETS[canonical];
    if (baseUsdc) {
      const configured = value.assets?.map(asset => asset.toLowerCase()) ?? [baseUsdc];
      if (configured.some(asset => asset !== baseUsdc)) {
        throw new Error(`${network}.assets supports only the official Base USDC contract`);
      }
      out[canonical] = [baseUsdc];
    } else if (value.assets?.length) {
      out[canonical] = [...new Set(value.assets.map(asset => asset.toLowerCase()))];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

/** The 1Password service-account token: env OP_SERVICE_ACCOUNT_TOKEN, else config. */
function opToken(cfg: FacilitatorConfig): string | undefined {
  return process.env.OP_SERVICE_ACCOUNT_TOKEN || cfg.onepassword?.token;
}

/** Resolve a single `onepassword.<key>` reference, or undefined if absent/unusable. */
async function resolveOpField(cfg: FacilitatorConfig, key: string): Promise<string | undefined> {
  const ref = parseOpRef(cfg.onepassword?.[key]);
  const token = opToken(cfg);
  if (!ref || !isUsableToken(token)) return undefined;
  try {
    return await getSecretFromOnePassword(ref, token);
  } catch {
    return undefined;
  }
}

/** TronGrid API key: env, then YAML literal, then 1Password. */
export async function getTrongridApiKey(cfg: FacilitatorConfig): Promise<string | undefined> {
  return (
    process.env.TRON_GRID_API_KEY ||
    cfg.facilitator?.trongrid_api_key ||
    (await resolveOpField(cfg, "trongrid_api_key"))
  );
}

/** Agent-wallet unlock password: env, then 1Password. */
export async function getAgentWalletPassword(cfg: FacilitatorConfig): Promise<string | undefined> {
  return process.env.AGENT_WALLET_PASSWORD || (await resolveOpField(cfg, "agent_wallet_password"));
}

/** Resolve the agent-wallet password and inject it into AGENT_WALLET_PASSWORD (if not already set). */
export async function injectAgentWalletPasswordEnv(cfg: FacilitatorConfig): Promise<void> {
  const password = await getAgentWalletPassword(cfg);
  if (password && !process.env.AGENT_WALLET_PASSWORD) {
    process.env.AGENT_WALLET_PASSWORD = password;
  }
}

/** Database password from 1Password (local dev puts it directly in database.url). */
async function getDatabasePassword(cfg: FacilitatorConfig): Promise<string | undefined> {
  return resolveOpField(cfg, "database_password");
}

/** Database URL with the resolved password injected into the userinfo (if any). */
export async function getDatabaseUrl(cfg: FacilitatorConfig): Promise<string> {
  const rawUrl = cfg.database?.url;
  if (!rawUrl) throw new Error("database.url is required");
  const password = await getDatabasePassword(cfg);
  if (!password) return rawUrl;

  const u = new URL(rawUrl);
  // URL setter handles percent-encoding of special chars in the password.
  u.password = password;
  return u.toString();
}

/** GasFree Open API credentials for a network. Env per-suffix/global first, then 1Password. */
export async function getGasFreeCredentials(
  cfg: FacilitatorConfig,
  network: string,
): Promise<{ key?: string; secret?: string }> {
  const suffix = network.split(":").pop()!.toUpperCase();
  let key =
    (process.env[`GASFREE_API_KEY_${suffix}`] || process.env.GASFREE_API_KEY || "").trim() ||
    undefined;
  let secret =
    (process.env[`GASFREE_API_SECRET_${suffix}`] || process.env.GASFREE_API_SECRET || "").trim() ||
    undefined;
  if (key && secret) return { key, secret };

  const lower = suffix.toLowerCase();
  key =
    key ||
    (await resolveOpField(cfg, `gasfree_api_key_${lower}`)) ||
    (await resolveOpField(cfg, "gasfree_api_key"));
  secret =
    secret ||
    (await resolveOpField(cfg, `gasfree_api_secret_${lower}`)) ||
    (await resolveOpField(cfg, "gasfree_api_secret"));
  return { key, secret };
}

// ---------------------------------------------------------------------------
// Plain getters with defaults (mirror legacy Config properties)
// ---------------------------------------------------------------------------

export const serverHost = (cfg: FacilitatorConfig): string => cfg.server?.host ?? "0.0.0.0";
export const serverPort = (cfg: FacilitatorConfig): number => {
  // YAML server.port is the source of truth, but an explicit SERVER_PORT env
  // wins so container orchestrators (and the Dockerfile HEALTHCHECK) can pin
  // the listen port without mounting a config file.
  const envPort = Number(process.env.SERVER_PORT);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return cfg.server?.port ?? 8001;
};
export const logLevel = (cfg: FacilitatorConfig): Level => {
  // Case-insensitive so legacy configs using "INFO"/"DEBUG" (uppercase) still apply.
  const raw = (cfg.logging?.level as string | undefined)?.toLowerCase();
  return raw === "debug" || raw === "warn" || raw === "error" ? raw : "info";
};

/**
 * Resolved log file path (`dir/filename`), or null when file logging is off.
 * Mirrors legacy: file logging is enabled only when both `logging.dir` and
 * `logging.filename` are set. The name is fixed (not timestamped); the file is
 * appended to across restarts.
 */
export const logFilePath = (cfg: FacilitatorConfig): string | null => {
  const { dir, filename } = cfg.logging ?? {};
  if (!dir || !filename) return null;
  return resolve(dir, filename);
};

export const apiKeyRefreshInterval = (cfg: FacilitatorConfig): number =>
  cfg.rate_limit?.api_key_refresh_interval ?? 60;
export const rateLimitAuthenticated = (cfg: FacilitatorConfig): string =>
  cfg.rate_limit?.authenticated ?? "1000/minute";
export const rateLimitAnonymous = (cfg: FacilitatorConfig): string =>
  cfg.rate_limit?.anonymous ?? "10/minute";

export const monitoringPort = (cfg: FacilitatorConfig): number =>
  cfg.monitoring?.port ?? serverPort(cfg);
export const monitoringEndpoint = (cfg: FacilitatorConfig): string =>
  cfg.monitoring?.endpoint ?? "/metrics";

export const databaseSslMode = (cfg: FacilitatorConfig): string =>
  cfg.database?.ssl_mode ?? "disable";
export const databaseMaxOpenConns = (cfg: FacilitatorConfig): number =>
  cfg.database?.max_open_conns ?? 25;
export const databaseMaxIdleConns = (cfg: FacilitatorConfig): number =>
  cfg.database?.max_idle_conns ?? 15;
export const databaseMaxLifeTime = (cfg: FacilitatorConfig): number =>
  cfg.database?.max_life_time ?? 600;

/** Max request body size in bytes (env MAX_REQUEST_BODY_BYTES, default 1 MiB). */
export const maxRequestBodyBytes = (): number => {
  const raw = Number(process.env.MAX_REQUEST_BODY_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 1024 * 1024;
};

/** Log a one-line summary of which secrets resolved (without values). */
export function logSecretSummary(cfg: FacilitatorConfig): void {
  logger.debug("onepassword token present", { present: isUsableToken(opToken(cfg)) });
}
