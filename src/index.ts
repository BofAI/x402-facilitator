/**
 * x402 Facilitator v2 entry point.
 *
 * Startup is staged via buildRuntimeConfig (src/runtime.ts):
 *   load config -> logging -> secrets -> DB -> auth -> GasFree -> serve HTTP.
 * Each stage has its own error context; the assembled RuntimeConfig carries
 * everything createApp / buildFacilitator need, so index.ts only wires the
 * HTTP servers and the shutdown handler.
 */
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { disposeDatabase } from "./db/index.js";
import { stopApiKeyRefresher } from "./auth.js";
import { buildFacilitator } from "./facilitator.js";
import { createApp } from "./server.js";
import { metricsHandler } from "./metrics.js";
import { buildRuntimeConfig } from "./runtime.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const rt = await buildRuntimeConfig(cfg);

  const facilitator = await buildFacilitator(cfg, {
    gasfreeBaseUrlFor: rt.gasfreeBaseUrlFor,
  });
  logger.info("Facilitator initialized", { networks: Object.keys(cfg.facilitator.networks ?? {}) });

  const app = createApp(facilitator, {
    rateLimit: rt.rateLimit,
    gasfreeSettings: () => rt.gasfreeSettings,
    metricsOnMainPort: rt.metricsOnMainPort,
    metricsEndpoint: rt.metricsEndpoint,
    maxRequestBodyBytes: rt.maxRequestBodyBytes,
  });

  const servers: ServerType[] = [];
  servers.push(
    serve({ fetch: app.fetch, hostname: rt.host, port: rt.port }, (info) => {
      logger.info("X402 Facilitator listening", { host: info.address, port: info.port });
    }),
  );

  // Separate metrics server when monitoring uses a different port.
  if (!rt.metricsOnMainPort) {
    const metricsApp = new Hono();
    metricsApp.get(rt.metricsEndpoint, metricsHandler);
    servers.push(
      serve({ fetch: metricsApp.fetch, hostname: rt.host, port: rt.metricsPort }, (info) => {
        logger.info("Metrics endpoint listening", { port: info.port, path: rt.metricsEndpoint });
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
