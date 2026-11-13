/**
 * Configuration loading and secret resolution.
 *
 * The YAML shape is unchanged from v1 (minus /fee/quote). Secrets are resolved on
 * demand: secret fields under `onepassword.*` are `vault/item/field` references
 * resolved through the configured Connect or Service Account provider.
 * Environment variables always take precedence over 1Password.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { getSecretFromOnePassword, isUsableToken, parseOpRef, type OnePasswordOptions } from "./onepassword.js";
import { logger, type Level } from "./logger.js";
import { requireCanonicalNetwork } from "./network.js";
import { sponsoringConfigSchema, sponsoringConfigsSchema, type SponsoringConfig } from "./sponsoring/config.js";

/** Payment schemes a network can enable. `exact_gasfree` (TRON) rides with `exact`. */
export type Scheme = "exact" | "upto" | "batch-settlement";

/** Every payment scheme — the default registered for a network when `schemes` is omitted. */
export const ALL_SCHEMES: readonly Scheme[] = ["exact", "upto", "batch-settlement"];

const port = z.number().int().min(1).max(65_535);
const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();
const schemeSchema = z.enum(["exact", "upto", "batch-settlement"]);

const networkConfigSchema = z
  .object({ schemes: z.array(schemeSchema).min(1).optional() })
  .strict()
  .superRefine((network, ctx) => {
    if (network.schemes && new Set(network.schemes).size !== network.schemes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schemes"], message: "must not contain duplicates" });
    }
  });

const facilitatorConfigSchema = z
  .object({
    resource_sponsoring: sponsoringConfigsSchema.optional(),
    server: z.object({ host: z.string().min(1).optional(), port: port.optional() }).strict().optional(),
    logging: z
      .object({
        level: z
          .string()
          .transform((value) => value.toLowerCase())
          .pipe(z.enum(["debug", "info", "warn", "error"]))
          .optional(),
        dir: z.string().min(1).optional(),
        filename: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    database: z
      .object({
        url: z.string().min(1).optional(),
        ssl_mode: z.enum(["disable", "require", "verify-ca", "verify-full"]).optional(),
        max_open_conns: positiveInt.optional(),
        max_idle_conns: nonNegativeInt.optional(),
        max_life_time: positiveInt.optional(),
      })
      .strict(),
    api_key_database: z.object({
      url: z.string().min(1).optional(),
      ssl_mode: z.enum(["disable", "verify-full"]).optional(),
    }).strict().optional(),
    onepassword: z.record(z.string(), z.string().optional()).refine(
      (cfg) => cfg.mode === undefined || cfg.mode === "connect" || cfg.mode === "service_account",
      { message: "mode must be connect or service_account", path: ["mode"] },
    ).optional(),
    rate_limit: z
      .object({
        store: z.enum(["memory", "redis"]).optional(),
        redis_url: z.string().min(1).optional(),
        api_key_refresh_interval: positiveInt.optional(),
        authenticated: z.string().min(1).optional(),
        anonymous: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    monitoring: z.object({ port: port.optional(), endpoint: z.string().startsWith("/").optional() }).strict().optional(),
    facilitator: z
      .object({
        trongrid_api_key: z.string().min(1).optional(),
        networks: z.record(z.string(), networkConfigSchema).refine((networks) => Object.keys(networks).length > 0, {
          message: "must be a non-empty object",
        }),
      })
      .strict(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.database.url && !cfg.onepassword?.database_url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["database", "url"],
        message: "database.url or onepassword.database_url is required" });
    }
    if (cfg.api_key_database && !cfg.api_key_database.url && cfg.onepassword?.api_key_database_url === undefined) {
      ctx.addIssue({ code: "custom", path: ["api_key_database", "url"],
        message: "api_key_database.url or onepassword.api_key_database_url is required" });
    }
    const missingOwners = cfg.resource_sponsoring?.filter(config => config.owner === undefined).length ?? 0;
    if (missingOwners > 1) {
      ctx.addIssue({ code: "custom", path: ["resource_sponsoring"],
        message: "only one entry may use onepassword.sponsoring_owner; configure owner on the other entries" });
    } else if (missingOwners === 1 && !parseOpRef(cfg.onepassword?.sponsoring_owner)) {
      ctx.addIssue({ code: "custom", path: ["onepassword", "sponsoring_owner"],
        message: "a vault/item/field reference is required when resource_sponsoring.owner is omitted" });
    }
    const { max_open_conns: open, max_idle_conns: idle } = cfg.database;
    if (open !== undefined && idle !== undefined && idle > open) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["database", "max_idle_conns"],
        message: "must not exceed database.max_open_conns",
      });
    }
  });

export type NetworkConfig = z.infer<typeof networkConfigSchema>;
export type FacilitatorConfig = z.infer<typeof facilitatorConfigSchema>;

/** Resolve the runtime config path from an explicit path or service environment. */
export function configPath(): string {
  if (process.env.FACILITATOR_CONFIG_PATH) {
    return resolve(process.env.FACILITATOR_CONFIG_PATH);
  }

  switch (process.env.FACILITATOR_SERVICE_ENV) {
    case undefined:
    case "":
      throw new Error(
        "Configuration source is required. Set FACILITATOR_SERVICE_ENV=dev|prod or FACILITATOR_CONFIG_PATH=/path/to/config.yaml",
      );
    case "dev":
      return resolve(process.cwd(), "config/facilitator.config.dev.yaml");
    case "prod":
      return resolve(process.cwd(), "config/facilitator.config.prod.yaml");
    default:
      throw new Error("FACILITATOR_SERVICE_ENV must be either 'dev' or 'prod'");
  }
}

/**
 * Load, parse and validate the facilitator YAML config from disk.
 *
 * @param path - Optional explicit path; otherwise uses FACILITATOR_CONFIG_PATH,
 * FACILITATOR_SERVICE_ENV or FACILITATOR_CONFIG_PATH.
 * @returns The parsed configuration object.
 */
export function loadConfig(path: string = configPath()): FacilitatorConfig {
  const raw = readFileSync(path, "utf8");
  const parsed = facilitatorConfigSchema.safeParse(parse(raw));
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuration validation failed. ${errors}`);
  }
  const cfg = parsed.data;
  for (const network of Object.keys(cfg.facilitator.networks)) {
    try {
      requireCanonicalNetwork(network);
    } catch (err) {
      throw new Error(`Configuration validation failed. facilitator.networks.${network}: ${String(err)}`);
    }
  }
  const canonicalNetworks = Object.keys(cfg.facilitator.networks).map(requireCanonicalNetwork);
  if (new Set(canonicalNetworks).size !== canonicalNetworks.length) throw new Error("Duplicate canonical network configuration");
  for (const sponsoring of cfg.resource_sponsoring ?? []) {
    if (!canonicalNetworks.includes(requireCanonicalNetwork(sponsoring.network)))
      throw new Error("resource_sponsoring.network must be enabled in facilitator.networks");
  }
  return cfg;
}

/** List of enabled CAIP network ids from config (listed = enabled). */
export function enabledNetworks(cfg: FacilitatorConfig): string[] {
  return Object.keys(cfg.facilitator.networks ?? {});
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

/** Explicit mode selection avoids accidentally using a token for the wrong provider. */
function opOptions(cfg: FacilitatorConfig): OnePasswordOptions {
  return { mode: cfg.onepassword?.mode === "connect" ? "connect" : "service_account", host: process.env.OP_CONNECT_HOST };
}

function opToken(cfg: FacilitatorConfig): string | undefined {
  if (opOptions(cfg).mode === "connect") return process.env.OP_CONNECT_TOKEN;
  return process.env.OP_SERVICE_ACCOUNT_TOKEN || cfg.onepassword?.token;
}

/** Resolve a single `onepassword.<key>` reference, or undefined if absent/unusable. */
async function resolveOpField(cfg: FacilitatorConfig, key: string): Promise<string | undefined> {
  const ref = parseOpRef(cfg.onepassword?.[key]);
  const token = opToken(cfg);
  if (!ref || !isUsableToken(token)) return undefined;
  try {
    return await getSecretFromOnePassword(ref, token, opOptions(cfg));
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

/** Build a lazy reader for the password managed by Facilitator. */
export function getWalletCliPasswordSource(cfg: FacilitatorConfig): (() => Promise<string>) | undefined {
  const reference = cfg.onepassword?.agent_wallet_password;
  if (reference === undefined) return undefined;
  if (!parseOpRef(reference)) throw new Error("onepassword.agent_wallet_password must be a vault/item/field reference");
  return () => resolveRequiredOpField(cfg, "onepassword.agent_wallet_password", reference);
}

/** Inject resolved database credentials into a connection URL. */
export function databaseUrlWithCredentials(
  rawUrl: string,
  user?: string,
  password?: string,
): string {
  if (!user && !password) return rawUrl;
  const url = new URL(rawUrl);
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
}

/** Database URL with resolved 1Password credentials injected into the userinfo. */
export async function getDatabaseUrl(cfg: FacilitatorConfig): Promise<string> {
  // An explicitly configured secret is authoritative; never fall back if it fails.
  const urlRef = cfg.onepassword?.database_url;
  const rawUrl = urlRef !== undefined
    ? await resolveRequiredSecret(cfg, "database_url", urlRef)
    : cfg.database?.url;
  const source = urlRef !== undefined ? "onepassword.database_url" : "database.url";
  if (!rawUrl) throw new Error("database.url or onepassword.database_url is required");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${source} must be a valid connection URL before resolving credentials`);
  }

  if (!["postgresql:", "postgres:", "postgresql+asyncpg:"].includes(url.protocol) || !url.hostname) {
    throw new Error(`${source} must be a PostgreSQL connection URL`);
  }
  const urlHasUser = Boolean(url.username);
  const urlHasPassword = Boolean(url.password);
  const userRef = cfg.onepassword?.database_user;
  const passwordRef = cfg.onepassword?.database_password;
  if (urlHasUser && urlHasPassword) return rawUrl;
  if (urlHasUser || urlHasPassword) {
    if (userRef || passwordRef) {
      throw new Error(
        "database.url userinfo cannot be combined with onepassword database credential references",
      );
    }
    return rawUrl;
  }
  if (!userRef && !passwordRef) return rawUrl;
  if (!userRef || !passwordRef) {
    throw new Error(
      "onepassword.database_user and onepassword.database_password must be configured together when database.url has no credentials",
    );
  }

  const user = await resolveRequiredSecret(cfg, "database_user", userRef);
  const password = await resolveRequiredSecret(cfg, "database_password", passwordRef);
  return databaseUrlWithCredentials(rawUrl, user, password);
}

/** Resolve the required DevCenter connection. */
export async function getApiKeyDatabaseOptions(cfg: FacilitatorConfig): Promise<{
  url: string;
  sslMode: "disable" | "verify-full";
}> {
  const secretRef = cfg.onepassword?.api_key_database_url;
  const database = cfg.api_key_database;

  const source = secretRef === undefined ? "api_key_database.url" : "onepassword.api_key_database_url";
  const rawUrl = secretRef === undefined
    ? database?.url
    : await resolveRequiredSecret(cfg, "api_key_database_url", secretRef);
  if (!rawUrl) throw new Error("api_key_database.url or onepassword.api_key_database_url is required");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${source} must be a valid PostgreSQL connection URL`);
  }
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !url.hostname) {
    throw new Error(`${source} must be a valid PostgreSQL connection URL`);
  }
  if (!url.username || url.pathname.length <= 1) {
    throw new Error(`${source} must specify the DevCenter database name and role`);
  }
  // pg merges connection-string parameters after the explicit client options.
  if (["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation"].some(key => url.searchParams.has(key))) {
    throw new Error(`${source} must use api_key_database.ssl_mode for TLS settings`);
  }
  if (["options", "statement_timeout", "query_timeout"].some(key => url.searchParams.has(key))) {
    throw new Error(`${source} must omit options, statement_timeout and query_timeout`);
  }
  return { url: url.href, sslMode: database?.ssl_mode ?? "verify-full" };
}

/** Resolve configured Owner addresses before creating sponsoring services. */
export async function getSponsoringConfigs(cfg: FacilitatorConfig): Promise<SponsoringConfig[]> {
  return Promise.all((cfg.resource_sponsoring ?? []).map(async (config, index) => {
    const ownerInput = config.owner;
    if (ownerInput !== undefined && !parseOpRef(ownerInput)) return { ...config, owner: ownerInput };

    const source = ownerInput === undefined ? "onepassword.sponsoring_owner" : `resource_sponsoring.${index}.owner`;
    const value = await resolveRequiredOpField(cfg, source, ownerInput ?? cfg.onepassword?.sponsoring_owner);
    const owner = sponsoringConfigSchema.shape.owner.safeParse(value.trim());
    if (!owner.success) throw new Error(`${source}: invalid TRON address from 1Password`);
    return { ...config, owner: owner.data };
  }));
}

/** Resolve a required credential reference before creating service clients. */
async function resolveRequiredSecret(
  cfg: FacilitatorConfig,
  key: "database_url" | "database_user" | "database_password" | "redis_password" | "api_key_database_url",
  value: string,
): Promise<string> {
  return resolveRequiredOpField(cfg, `onepassword.${key}`, value);
}

async function resolveRequiredOpField(cfg: FacilitatorConfig, source: string, value: string | undefined): Promise<string> {
  const ref = parseOpRef(value);
  if (!ref) throw new Error(`${source} must be a vault/item/field reference`);
  const token = opToken(cfg);
  if (!isUsableToken(token)) {
    if (opOptions(cfg).mode === "connect") throw new Error(`${source} requires a valid OP_CONNECT_TOKEN`);
    throw new Error(`${source} requires a valid OP_SERVICE_ACCOUNT_TOKEN or onepassword.token`);
  }
  try {
    const secret = await getSecretFromOnePassword(ref, token, opOptions(cfg));
    if (!secret) throw new Error("resolved to an empty value");
    return secret;
  } catch (err) {
    if (source === "onepassword.database_url" || source === "onepassword.api_key_database_url") {
      throw new Error(`Unable to resolve ${source}`);
    }
    throw new Error(`Unable to resolve ${source}: ${err instanceof Error ? err.message : "provider error"}`);
  }
}

/** Explicit env first, then 1Password; undefined preserves URL credentials. */
export async function getRateLimitRedisPassword(cfg: FacilitatorConfig): Promise<string | undefined> {
  const password = process.env.RATE_LIMIT_REDIS_PASSWORD;
  if (password !== undefined) {
    if (!password) throw new Error("RATE_LIMIT_REDIS_PASSWORD must not be empty");
    return password;
  }
  const ref = cfg.onepassword?.redis_password;
  return ref === undefined ? undefined : resolveRequiredSecret(cfg, "redis_password", ref);
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
