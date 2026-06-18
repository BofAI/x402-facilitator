import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { parseLimit, rateLimit, resetRateLimitState } from "../src/rate-limit.js";
import { authMiddleware, setApiKeyCacheForTest, type AuthVars } from "../src/auth.js";

describe("parseLimit", () => {
  it("parses N/period forms", () => {
    expect(parseLimit("1000/minute")).toEqual({ count: 1000, windowSeconds: 60 });
    expect(parseLimit("10/second")).toEqual({ count: 10, windowSeconds: 1 });
    expect(parseLimit("5/hour")).toEqual({ count: 5, windowSeconds: 3600 });
    expect(parseLimit("2/day")).toEqual({ count: 2, windowSeconds: 86400 });
  });

  it("tolerates pluralized periods", () => {
    expect(parseLimit("3/minutes").windowSeconds).toBe(60);
  });

  it("rejects invalid strings", () => {
    expect(() => parseLimit("abc/minute")).toThrow();
    expect(() => parseLimit("10/fortnight")).toThrow();
    expect(() => parseLimit("0/minute")).toThrow();
  });
});

describe("rateLimit middleware", () => {
  beforeEach(() => {
    resetRateLimitState();
    setApiKeyCacheForTest([]);
  });

  function appWith(authenticated: string, anonymous: string) {
    const app = new Hono<{ Variables: AuthVars }>();
    app.use("*", authMiddleware);
    app.post("/settle", rateLimit({ authenticated, anonymous }), (c) => c.json({ ok: true }));
    return app;
  }

  it("allows up to the anonymous limit, then 429s", async () => {
    const app = appWith("100/minute", "2/minute");
    expect((await app.request("/settle", { method: "POST" })).status).toBe(200);
    expect((await app.request("/settle", { method: "POST" })).status).toBe(200);
    const blocked = await app.request("/settle", { method: "POST" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("applies the authenticated tier for known API keys", async () => {
    setApiKeyCacheForTest(["good-key"]);
    const app = appWith("3/minute", "1/minute");
    const hdr = { "X-API-KEY": "good-key" };
    // Authenticated key gets 3 before blocking, not 1.
    expect((await app.request("/settle", { method: "POST", headers: hdr })).status).toBe(200);
    expect((await app.request("/settle", { method: "POST", headers: hdr })).status).toBe(200);
    expect((await app.request("/settle", { method: "POST", headers: hdr })).status).toBe(200);
    expect((await app.request("/settle", { method: "POST", headers: hdr })).status).toBe(429);
  });
});
