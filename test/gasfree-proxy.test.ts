/**
 * Ported from legacy/tests/test_gasfree_open_proxy.py — keeps the HMAC signing,
 * path mapping and header policy byte-faithful to v1.
 */
import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateApiSignature,
  resolveUpstream,
  registerGasFreeProxy,
  type GasFreeProxySettings,
} from "../src/gasfree-proxy.js";

function nodeStyleSignature(method: string, path: string, ts: number, secret: string): string {
  return createHmac("sha256", secret).update(`${method.toUpperCase()}${path}${ts}`, "utf8").digest("base64");
}

const NILE_SETTINGS: GasFreeProxySettings = {
  nileCreds: { key: "gf-key", secret: "gf-secret" },
  mainnetCreds: null,
  upstreamNile: "https://open-test.gasfree.io",
  upstreamMainnet: "https://open.gasfree.io",
};

/** Build an app with the proxy registered and a captured fetch mock. */
function appWith(settings: GasFreeProxySettings, response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  const app = new Hono();
  registerGasFreeProxy(app, () => settings);
  return { app, fetchMock };
}

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers)) out[k.toLowerCase()] = v;
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("generateApiSignature", () => {
  it.each([
    ["GET", "/nile/api/v1/config/token/all", 1700000000, "test-secret"],
    ["POST", "/tron/api/v1/gasfree/submit", 1735689600, "rPX7NXuJQUhbnS_ApFoB79WnKWzzXTwHqbovgGdKwmg"],
  ] as const)("matches node-style HMAC (%s %s)", (method, path, ts, secret) => {
    expect(generateApiSignature(method, path, ts, secret)).toBe(nodeStyleSignature(method, path, ts, secret));
  });
});

describe("resolveUpstream", () => {
  it.each([
    ["/mainnet", "/tron/"],
    ["/mainnet/", "/tron/"],
    ["/mainnet/api/v1/foo", "/tron/api/v1/foo"],
    ["/nile", "/nile/"],
    ["/nile/api/v1/config/token/all", "/nile/api/v1/config/token/all"],
  ])("maps %s -> %s", (clientPath, expectedPath) => {
    const out = resolveUpstream(clientPath, "https://open.gasfree.io", "https://open-test.gasfree.io");
    expect(out).not.toBeNull();
    expect(out!.path).toBe(expectedPath);
    expect(out!.base).toBe(out!.profile === "mainnet" ? "https://open.gasfree.io" : "https://open-test.gasfree.io");
  });

  it("returns null for unknown prefix", () => {
    expect(resolveUpstream("/verify", "https://a.io", "https://b.io")).toBeNull();
  });
});

describe("proxy request", () => {
  it("forwards GasFree auth and strips client Authorization / secrets", async () => {
    const resp = new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    const { app, fetchMock } = appWith(NILE_SETTINGS, resp);

    await app.request("/nile/api/v1/config/token/all", {
      headers: {
        Authorization: "Bearer user-token",
        Accept: "application/json",
        "X-API-KEY": "facilitator-secret-must-not-leak",
        Cookie: "session=evil",
        "X-Custom": "1",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://open-test.gasfree.io/nile/api/v1/config/token/all");
    const h = sentHeaders(fetchMock);
    expect(h["authorization"]).toMatch(/^ApiKey gf-key:/);
    expect(h["timestamp"]).toBeDefined();
    expect(h["accept"]).toBe("application/json");
    expect(h["authorization"]).not.toContain("Bearer");
    expect(h["x-api-key"]).toBeUndefined();
    expect(h["cookie"]).toBeUndefined();
    expect(h["x-custom"]).toBeUndefined();
    expect(h["content-type"]).toBeUndefined();
  });

  it("sets application/json content-type when POST has a body", async () => {
    const resp = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { app, fetchMock } = appWith(NILE_SETTINGS, resp);
    await app.request("/nile/api/v1/gasfree/submit", { method: "POST", body: "{}" });
    expect(sentHeaders(fetchMock)["content-type"]).toBe("application/json");
  });

  it("preserves client JSON charset on POST", async () => {
    const resp = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { app, fetchMock } = appWith(NILE_SETTINGS, resp);
    const ct = "application/json; charset=utf-8";
    await app.request("/nile/api/v1/gasfree/submit", { method: "POST", body: "{}", headers: { "Content-Type": ct } });
    expect(sentHeaders(fetchMock)["content-type"]).toBe(ct);
  });

  it("overrides non-JSON content-type when POST has a body", async () => {
    const resp = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { app, fetchMock } = appWith(NILE_SETTINGS, resp);
    await app.request("/nile/api/v1/gasfree/submit", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "text/plain" },
    });
    expect(sentHeaders(fetchMock)["content-type"]).toBe("application/json");
  });

  it("strips content-encoding from the upstream response", async () => {
    const resp = new Response(gzipSync(Buffer.from('{"ok":true}')), {
      status: 200,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    const { app } = appWith(NILE_SETTINGS, resp);
    const r = await app.request("/nile/api/v1/config/token/all");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBeNull();
  });

  it("returns 503 when credentials are missing for the resolved network", async () => {
    const resp = new Response("{}", { status: 200 });
    const { app } = appWith(NILE_SETTINGS, resp);
    const r = await app.request("/mainnet/api/v1/config/token/all");
    expect(r.status).toBe(503);
  });

  it("returns 404 for an unknown prefix", async () => {
    const resp = new Response("{}", { status: 200 });
    const { app } = appWith(NILE_SETTINGS, resp);
    const r = await app.request("/unknown/path");
    expect(r.status).toBe(404);
  });
});
