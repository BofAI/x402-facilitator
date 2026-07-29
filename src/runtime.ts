/**
 * Startup orchestration (P2-06).
 *
 * Replaces index.ts's linear main() with staged helpers and an immutable
 * RuntimeConfig that aggregates the config getters previously scattered across
 * index.ts. Each stage has its own error context; the assembled runtime carries
 * everything needed by createApp / buildFacilitator, so callers don't re-resolve.
 */
import { TRON_MAINNET, TRON_NILE } from "@bankofai/x402-tron";
import {
  type FacilitatorConfig,
  apiKeyRefreshInterval,
  databaseMaxIdleConns,
  databaseMaxLifeTime,
  databaseMaxOpenConns,
  databaseSslMode,
  getDatabaseUrl,
  getGasFreeCredentials,
  getTrongridApiKey,
  injectAgentWalletPasswordEnv,
  logFilePath,
  logLevel,
  maxRequestBodyBytes,
  monitoringEndpoint,
  monitoringPort,
  rateLimitAnonymous,
  rateLimitAuthenticated,
  serverHost,
  serverPort,
} from "./config.js";
import { initDatabase } from "./db/index.js";
import { startApiKeyRefresher } from "./auth.js";
import type { GasFreeProxySettings } from "./gasfree-proxy.js";
import { logger, setLogLevel, setLogFile, toSdkLogger } from "./logger.js";
import { setLogger } from "@bankofai/x402-core";

/** Aggregated, immutable runtime configuration resolved once at startup. */
export interface RuntimeConfig {
  readonly cfg: FacilitatorConfig;
  readonly host: string;
  readonly port: number;
  readonly metricsPort: number;
  readonly metricsEndpoint: string;
  readonly metricsOnMainPort: boolean;
  readonly maxRequestBodyBytes: number;
  readonly rateLimit: { authenticated: string; anonymous: string };
  readonly gasfreeSettings: GasFreeProxySettings;
  /** GasFree proxy base URL resolver handed to buildFacilitator. */
  readonly gasfreeBaseUrlFor: (network: string) => string | null;
}

/** Stage 1: logging (level + file + SDK logger wiring). */
export function initLogging(cfg: FacilitatorConfig): void {
  const logFile = logFilePath(cfg);
  if (logFile) setLogFile(logFile);
  setLogLevel(logLevel(cfg));
  setLogger(toSdkLogger());
  logger.info("Configuration loaded", logFile ? { logFile } : undefined);
}

/** Stage 2: secrets (agent-wallet password env, TronGrid key injection). */
export async function initSecrets(cfg: FacilitatorConfig): Promise<void> {
  await injectAgentWalletPasswordEnv(cfg);
  const trongridKey = await getTrongridApiKey(cfg);
  if (trongridKey) {
    process.env.TRON_GRID_API_KEY = trongridKey;
    logger.info("TronGrid API key injected");
  } else {
    logger.warn("TronGrid API key not configured; default rate limits apply");
  }
}

/** Stage 3: database pool. */
export function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = "***";
    const sensitiveKeys = new Set(["password", "pass", "pwd", "token", "secret", "api_key", "apikey"]);
    for (const [key] of url.searchParams) {
      if (sensitiveKeys.has(key.toLowerCase())) url.searchParams.set(key, "***");
    }
    return url.toString();
  } catch {
    return "<invalid database URL>";
  }
}

export async function initDb(cfg: FacilitatorConfig): Promise<void> {
  const databaseUrl = await getDatabaseUrl(cfg);
  logger.info("Initializing database", { url: redactDatabaseUrl(databaseUrl) });
  await initDatabase({
    url: databaseUrl,
    poolSize: databaseMaxIdleConns(cfg),
    maxOverflow: Math.max(0, databaseMaxOpenConns(cfg) - databaseMaxIdleConns(cfg)),
    maxLifeTime: databaseMaxLifeTime(cfg),
    sslMode: databaseSslMode(cfg),
  });
}

/** Stage 4: API-key cache + periodic refresh. */
export async function initAuth(cfg: FacilitatorConfig): Promise<void> {
  await startApiKeyRefresher(apiKeyRefreshInterval(cfg));
}

/** Stage 5: GasFree proxy settings + per-network base URL resolver. */
export async function initGasFree(cfg: FacilitatorConfig): Promise<GasFreeProxySettings> {
  const nile = await getGasFreeCredentials(cfg, "tron:nile");
  const mainnet = await getGasFreeCredentials(cfg, "tron:mainnet");
  return {
    nileCreds: nile.key && nile.secret ? { key: nile.key, secret: nile.secret } : null,
    mainnetCreds: mainnet.key && mainnet.secret ? { key: mainnet.key, secret: mainnet.secret } : null,
    upstreamNile: (process.env.UPSTREAM_NILE_BASE ?? "https://open-test.gasfree.io").replace(/\/+$/, ""),
    upstreamMainnet: (process.env.UPSTREAM_MAINNET_BASE ?? "https://open.gasfree.io").replace(/\/+$/, ""),
  };
}

/** Resolve the GasFree proxy base URL for a canonical TRON network. */
export function gasfreeBaseUrlResolver(
  cfg: FacilitatorConfig,
  settings: GasFreeProxySettings,
): (network: string) => string | null {
  const selfBase = `http://127.0.0.1:${serverPort(cfg)}`;
  return (network: string): string | null => {
    if (network === TRON_NILE && settings.nileCreds) return `${selfBase}/nile`;
    if (network === TRON_MAINNET && settings.mainnetCreds) return `${selfBase}/mainnet`;
    return null;
  };
}

/**
 * Assemble the immutable RuntimeConfig from a loaded FacilitatorConfig, running
 * the secret/db/auth/gasfree stages in order. Each stage fails with its own
 * context rather than mid-way through a monolithic main().
 */
export async function buildRuntimeConfig(cfg: FacilitatorConfig): Promise<RuntimeConfig> {
  initLogging(cfg);
  await initSecrets(cfg);
  await initDb(cfg);
  await initAuth(cfg);
  const gasfreeSettings = await initGasFree(cfg);

  return {
    cfg,
    host: serverHost(cfg),
    port: serverPort(cfg),
    metricsPort: monitoringPort(cfg),
    metricsEndpoint: monitoringEndpoint(cfg),
    metricsOnMainPort: monitoringPort(cfg) === serverPort(cfg),
    maxRequestBodyBytes: maxRequestBodyBytes(),
    rateLimit: { authenticated: rateLimitAuthenticated(cfg), anonymous: rateLimitAnonymous(cfg) },
    gasfreeSettings,
    gasfreeBaseUrlFor: gasfreeBaseUrlResolver(cfg, gasfreeSettings),
  };
}
