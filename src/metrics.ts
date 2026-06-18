/**
 * Prometheus metrics. Replaces v1's prometheus-fastapi-instrumentator
 * (legacy/src/monitoring.py) with prom-client:
 *   - default process/node metrics
 *   - per-request count + latency histogram (labelled by method, route, status)
 *   - a /metrics text handler, exposable on the main or a separate port.
 */
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";
import type { Context, MiddlewareHandler } from "hono";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "handler", "status"] as const,
  registers: [registry],
});

const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "handler", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/** Middleware recording request count and latency. Uses the matched route to bound label cardinality. */
export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  const start = process.hrtime.bigint();
  try {
    await next();
  } finally {
    const handler = c.req.routePath ?? c.req.path;
    const labels = {
      method: c.req.method,
      handler,
      status: String(c.res.status),
    };
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, seconds);
  }
};

/** Hono handler returning the Prometheus exposition text. */
export async function metricsHandler(c: Context): Promise<Response> {
  const body = await registry.metrics();
  return c.body(body, 200, { "Content-Type": registry.contentType });
}
