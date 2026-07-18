/**
 * Prometheus metrics. Mirrors v1's prometheus-fastapi-instrumentator default
 * metric set (legacy/src/monitoring.py -> Instrumentator().instrument(app)) so
 * existing dashboards/alerts keep working. The instrumentator default emits:
 *   - http_requests_total{method,status,handler}      (Counter)
 *   - http_request_size_bytes{handler}                (Summary, sum+count only)
 *   - http_response_size_bytes{handler}               (Summary, sum+count only)
 *   - http_request_duration_highr_seconds             (Histogram, no labels)
 *   - http_request_duration_seconds{method,handler}   (Histogram, few buckets)
 * plus default process/runtime metrics (process_* overlap with the Python
 * client; nodejs_* replace the python_* families, which can't be reproduced).
 *
 * Label values follow the instrumentator defaults: status is grouped to "Nxx"
 * (should_group_status_codes=True) and untemplated routes report handler="none"
 * (should_group_untemplated=True).
 */
import { collectDefaultMetrics, Counter, Histogram, Summary, Registry } from "prom-client";
import type { Context, MiddlewareHandler } from "hono";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of requests by method, status and handler.",
  labelNames: ["method", "status", "handler"] as const,
  registers: [registry],
});

const httpRequestSizeBytes = new Summary({
  name: "http_request_size_bytes",
  help: "Content length of incoming requests by handler.",
  labelNames: ["handler"] as const,
  // Empty percentiles => only _sum and _count, matching the Python client.
  percentiles: [],
  registers: [registry],
});

const httpResponseSizeBytes = new Summary({
  name: "http_response_size_bytes",
  help: "Content length of outgoing responses by handler.",
  labelNames: ["handler"] as const,
  percentiles: [],
  registers: [registry],
});

// High-resolution latency histogram with many buckets but no labels.
const httpRequestDurationHighr = new Histogram({
  name: "http_request_duration_highr_seconds",
  help: "Latency with many buckets but no API specific labels.",
  buckets: [
    0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4,
    4.5, 5, 7.5, 10, 30, 60,
  ],
  registers: [registry],
});

// Low-resolution latency histogram labelled by method + handler.
const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Latency with only few buckets by handler.",
  labelNames: ["method", "handler"] as const,
  buckets: [0.1, 0.5, 1],
  registers: [registry],
});

/**
 * Middleware recording the instrumentator default metrics. Uses the matched
 * route to bound label cardinality; untemplated/unmatched requests report
 * handler="none" (mirrors should_group_untemplated).
 */
export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  const start = process.hrtime.bigint();
  try {
    await next();
  } finally {
    const routePath = c.req.routePath;
    const handler = routePath && routePath !== "/*" ? routePath : "none";
    const method = c.req.method;
    // Group status codes into "Nxx" (mirrors should_group_status_codes).
    const status = `${String(c.res.status)[0]}xx`;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;

    httpRequestsTotal.inc({ method, status, handler });
    httpRequestSizeBytes.observe({ handler }, Number(c.req.header("content-length") ?? 0));
    // Hono JSON responses are streamed and typically omit content-length, so the
    // header-based count was always 0. Read the actual finalized body length via a
    // cloned Response (cloning avoids consuming the stream the client receives).
    let respBytes = Number(c.res.headers.get("content-length") ?? 0);
    if (!respBytes) {
      try {
        const buf = await c.res.clone().arrayBuffer();
        respBytes = buf.byteLength;
      } catch {
        /* body unreadable (e.g. streaming/no body) — leave at 0 */
      }
    }
    httpResponseSizeBytes.observe({ handler }, respBytes);
    httpRequestDurationHighr.observe(seconds);
    httpRequestDuration.observe({ method, handler }, seconds);
  }
};

/** Hono handler returning the Prometheus exposition text. */
export async function metricsHandler(c: Context): Promise<Response> {
  const body = await registry.metrics();
  return c.body(body, 200, { "Content-Type": registry.contentType });
}
