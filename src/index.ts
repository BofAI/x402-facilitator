/**
 * x402 Facilitator v2 entry point.
 *
 * Startup mirrors v1 (legacy/src/main.py lifespan):
 *   load config -> resolve secrets (1Password) -> init DB -> start API-key
 *   refresher -> inject TronGrid key -> resolve signers & register schemes ->
 *   wire GasFree proxy -> serve HTTP (+ optional separate metrics port).
 */
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import {
  loadConfig,
  injectAgentWalletPasswordEnv,
  getTrongridApiKey,
  getDatabaseUrl,
  getGasFreeCredentials,
  serverHost,
  serverPort,
  logLevel,
  apiKeyRefreshInterval,
  rateLimitAuthenticated,
  rateLimitAnonymous,
  monitoringPort,
  monitoringEndpoint,
  databaseSslMode,
  databaseMaxOpenConns,
  databaseMaxIdleConns,
  databaseMaxLifeTime,
} from "./config.js";
import { initDatabase, disposeDatabase } from "./db/index.js";
import { startApiKeyRefresher, stopApiKeyRefresher } from "./auth.js";
import { buildFacilitator } from "./facilitator.js";
import { createApp } from "./server.js";
import { metricsHandler } from "./metrics.js";
import type { GasFreeProxySettings } from "./gasfree-proxy.js";
import { logger, setLogLevel } from "./logger.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  setLogLevel(logLevel(cfg));
  logger.info("Configuration loaded");

  // Secrets (env first, then 1Password).
  await injectAgentWalletPasswordEnv(cfg);
  const trongridKey = await getTrongridApiKey(cfg);
  if (trongridKey) {
    process.env.TRON_GRID_API_KEY = trongridKey;
    logger.info("TronGrid API key injected");
  } else {
    logger.warn("TronGrid API key not configured; default rate limits apply");
  }

  // Database.
  const databaseUrl = await getDatabaseUrl(cfg);
  await initDatabase({
    url: databaseUrl,
    poolSize: databaseMaxIdleConns(cfg),
    maxOverflow: Math.max(0, databaseMaxOpenConns(cfg) - databaseMaxIdleConns(cfg)),
    maxLifeTime: databaseMaxLifeTime(cfg),
    sslMode: databaseSslMode(cfg),
  });

  // API-key cache + periodic refresh.
  await startApiKeyRefresher(apiKeyRefreshInterval(cfg));

  // GasFree proxy settings (creds for nile/mainnet; upstream bases overridable via env).
  const nile = await getGasFreeCredentials(cfg, "tron:nile");
  const mainnet = await getGasFreeCredentials(cfg, "tron:mainnet");
  const gasfreeSettings: GasFreeProxySettings = {
    nileCreds: nile.key && nile.secret ? { key: nile.key, secret: nile.secret } : null,
    mainnetCreds: mainnet.key && mainnet.secret ? { key: mainnet.key, secret: mainnet.secret } : null,
    upstreamNile: (process.env.UPSTREAM_NILE_BASE ?? "https://open-test.gasfree.io").replace(/\/+$/, ""),
    upstreamMainnet: (process.env.UPSTREAM_MAINNET_BASE ?? "https://open.gasfree.io").replace(/\/+$/, ""),
  };

  // The GasFree scheme client points at our own proxy; only enable per-network when
  // credentials are present (the proxy could not authenticate upstream otherwise).
  const selfBase = `http://127.0.0.1:${serverPort(cfg)}`;
  const gasfreeBaseUrlFor = (network: string): string | null => {
    if (network === "tron:nile" && gasfreeSettings.nileCreds) return `${selfBase}/nile`;
    if (network === "tron:mainnet" && gasfreeSettings.mainnetCreds) return `${selfBase}/mainnet`;
    return null;
  };

  const facilitator = await buildFacilitator(cfg, { gasfreeBaseUrlFor });
  logger.info("Facilitator initialized", { networks: Object.keys(cfg.facilitator.networks ?? {}) });

  const sameMetricsPort = monitoringPort(cfg) === serverPort(cfg);
  const app = createApp(facilitator, {
    rateLimit: { authenticated: rateLimitAuthenticated(cfg), anonymous: rateLimitAnonymous(cfg) },
    gasfreeSettings: () => gasfreeSettings,
    metricsOnMainPort: sameMetricsPort,
    metricsEndpoint: monitoringEndpoint(cfg),
  });

  const host = serverHost(cfg);
  const port = serverPort(cfg);
  const servers: ServerType[] = [];

  servers.push(
    serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      logger.info("X402 Facilitator listening", { host: info.address, port: info.port });
    }),
  );

  // Separate metrics server when monitoring uses a different port.
  if (!sameMetricsPort) {
    const metricsApp = new Hono();
    metricsApp.get(monitoringEndpoint(cfg), metricsHandler);
    servers.push(
      serve({ fetch: metricsApp.fetch, hostname: host, port: monitoringPort(cfg) }, (info) => {
        logger.info("Metrics endpoint listening", { port: info.port, path: monitoringEndpoint(cfg) });
      }),
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("Shutting down", { signal });
    stopApiKeyRefresher();
    for (const s of servers) s.close();
    await disposeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("Fatal startup error", { err: String(err) });
  process.exit(1);
});
