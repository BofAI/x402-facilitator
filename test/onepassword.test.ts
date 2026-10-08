import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { initSecrets } from "../src/runtime.js";
import { parseOpRef, isUsableToken, getSecretFromOnePassword } from "../src/onepassword.js";
import { getDatabaseUrl, getGasFreeCredentials, getTrongridApiKey, type FacilitatorConfig } from "../src/config.js";

const sdk = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@1password/sdk", () => ({ createClient: async () => ({ secrets: sdk }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const ref = { vault: "test-vault", item: "credentials", field: "password" };
const connect = { mode: "connect" as const, host: "http://connect.local:8080" };
function connectResponse(fields = [{ id: "password", label: "password", value: "p@ss/word" }]) {
  vi.stubGlobal("fetch", vi.fn(async (url: URL, options: RequestInit) => {
    if (options.headers && new Headers(options.headers).get("Authorization") !== "Bearer connect-test-token")
      return new Response("unauthorized", { status: 401 });
    const path = new URL(url).pathname;
    if (path === "/v1/vaults") return Response.json([{ id: "a".repeat(26), name: "test-vault" }]);
    if (path === `/v1/vaults/${"a".repeat(26)}/items`) return Response.json([{ id: "b".repeat(26), title: "credentials" }]);
    if (path === `/v1/vaults/${"a".repeat(26)}/items/${"b".repeat(26)}`) return Response.json({ fields });
    return new Response(null, { status: 404 });
  }));
}

describe("1Password providers", () => {
  const redisConfig: FacilitatorConfig = { database: { url: "postgresql://localhost/db" },
    facilitator: { networks: { "tron:3448148188": {} } },
    onepassword: { mode: "connect", redis_password: "test-vault/credentials/password" } };

  it("uses YAML Redis settings at startup unless environment overrides them", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", undefined);
    vi.stubEnv("RATE_LIMIT_REDIS_URL", undefined);
    vi.stubEnv("REDIS_URL", undefined);
    vi.stubEnv("RATE_LIMIT_REDIS_PASSWORD", "test-only-password");
    const cfg = { ...redisConfig, rate_limit: { store: "redis" as const, redis_url: "rediss://yaml.example:6379" } };
    await initSecrets(cfg);
    expect(process.env.RATE_LIMIT_STORE).toBe("redis");
    expect(process.env.RATE_LIMIT_REDIS_URL).toBe("rediss://yaml.example:6379");
    vi.stubEnv("RATE_LIMIT_STORE", "memory");
    vi.stubEnv("RATE_LIMIT_REDIS_URL", undefined);
    vi.stubEnv("REDIS_URL", "rediss://override.example:6379");
    vi.stubEnv("RATE_LIMIT_REDIS_PASSWORD", undefined);
    await initSecrets(cfg);
    expect(process.env.RATE_LIMIT_STORE).toBe("memory");
    expect(process.env.RATE_LIMIT_REDIS_URL).toBeUndefined();
  });

  it("loads the Valkey password through Connect during startup", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "redis");
    vi.stubEnv("RATE_LIMIT_REDIS_PASSWORD", undefined);
    vi.stubEnv("OP_CONNECT_HOST", connect.host);
    vi.stubEnv("OP_CONNECT_TOKEN", "connect-test-token");
    connectResponse();
    await initSecrets(redisConfig);
    expect(process.env.RATE_LIMIT_REDIS_PASSWORD).toBe("p@ss/word");
  });

  it("prefers an explicit Valkey password without resolving the provider", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "redis");
    vi.stubEnv("RATE_LIMIT_REDIS_PASSWORD", " @:#/ pass ");
    vi.stubEnv("OP_CONNECT_TOKEN", undefined);
    await initSecrets(redisConfig);
    expect(process.env.RATE_LIMIT_REDIS_PASSWORD).toBe(" @:#/ pass ");
  });

  it("fails startup on a configured but unavailable Valkey secret even with URL credentials", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "redis");
    vi.stubEnv("RATE_LIMIT_REDIS_PASSWORD", undefined);
    vi.stubEnv("RATE_LIMIT_REDIS_URL", "rediss://:old-password@localhost:6379");
    vi.stubEnv("OP_CONNECT_TOKEN", undefined);
    await expect(initSecrets(redisConfig)).rejects.toThrow(/redis_password.*OP_CONNECT_TOKEN/);
  });

  it("loads the Valkey password through Service Accounts too", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "redis");
    vi.stubEnv("RATE_LIMIT_REDIS_PASSWORD", undefined);
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "service-test-token");
    sdk.resolve.mockResolvedValue("service-redis-password");
    await initSecrets({ ...redisConfig, onepassword: { ...redisConfig.onepassword, mode: "service_account" } });
    expect(process.env.RATE_LIMIT_REDIS_PASSWORD).toBe("service-redis-password");
  });

  it("does not read the Valkey secret for memory storage", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "memory");
    vi.stubEnv("RATE_LIMIT_REDIS_PASSWORD", undefined);
    vi.stubEnv("OP_CONNECT_TOKEN", undefined);
    await initSecrets(redisConfig);
    expect(process.env.RATE_LIMIT_REDIS_PASSWORD).toBeUndefined();
  });
  it("resolves Connect names and IDs using bearer authentication", async () => {
    connectResponse();
    expect(await getSecretFromOnePassword(ref, "connect-test-token", connect)).toBe("p@ss/word");
    expect(await getSecretFromOnePassword({ vault: "a".repeat(26), item: "b".repeat(26), field: "password" }, "connect-test-token", connect)).toBe("p@ss/word");
  });

  it("rejects missing and ambiguous fields", async () => {
    connectResponse([]);
    await expect(getSecretFromOnePassword(ref, "connect-test-token", connect)).rejects.toThrow(/field/);
    connectResponse([{ id: "1", label: "password", value: "one" }, { id: "2", label: "password", value: "two" }]);
    await expect(getSecretFromOnePassword(ref, "connect-test-token", connect)).rejects.toThrow(/field/);
  });

  it.each([401, 403, 429, 500, 302])("rejects HTTP %s without leaking upstream response bodies", async (status) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret-upstream-body", { status })));
    await expect(getSecretFromOnePassword(ref, "connect-test-token", connect)).rejects.toThrow(`HTTP ${status}`);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret-upstream-body|connect-test-token/);
  });

  it("bounds requests with a timeout and sanitizes transport errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (_url: URL, options: RequestInit) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.redirect).toBe("error");
      throw new DOMException("secret-transport-detail", "TimeoutError");
    }));
    await expect(getSecretFromOnePassword(ref, "connect-test-token", connect)).rejects.toThrow(/request failed/);
  });

  it.each([undefined, "file:///tmp/connect", "https://user:password@connect.local", "https://connect.local?token=secret"])("rejects invalid Connect host %s", async (host) => {
    await expect(getSecretFromOnePassword(ref, "connect-test-token", { mode: "connect", host })).rejects.toThrow(/OP_CONNECT_HOST/);
  });

  it("retains service account resolution when Connect environment variables exist", async () => {
    vi.stubEnv("OP_CONNECT_HOST", connect.host);
    vi.stubEnv("OP_CONNECT_TOKEN", "connect-test-token");
    sdk.resolve.mockResolvedValue("sdk-secret");
    expect(await getSecretFromOnePassword(ref, "service-test-token")).toBe("sdk-secret");
    expect(sdk.resolve).toHaveBeenCalledWith("op://test-vault/credentials/password");
  });

  it("reads a field through a real Connect-compatible HTTP endpoint", async () => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer connect-test-token" ||
          req.url !== `/v1/vaults/${"a".repeat(26)}/items/${"b".repeat(26)}`) {
        res.writeHead(401).end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ fields: [{ id: "password", value: "http-secret" }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    try {
      expect(await getSecretFromOnePassword({ vault: "a".repeat(26), item: "b".repeat(26), field: "password" },
        "connect-test-token", { mode: "connect", host: `http://127.0.0.1:${address.port}` })).toBe("http-secret");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts a stalled real HTTP response within the timeout", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = createServer((_req, res) => { res.writeHead(200); res.write("["); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    try {
      await expect(getSecretFromOnePassword(ref, "connect-test-token", {
        mode: "connect", host: `http://127.0.0.1:${address.port}`,
      })).rejects.toThrow(/request failed/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it("does not use a service token when Connect credentials are missing", async () => {
    vi.stubEnv("OP_CONNECT_TOKEN", "");
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "service-test-token");
    const cfg: FacilitatorConfig = { database: { url: "postgresql://localhost/db" }, facilitator: { networks: { "tron:3448148188": {} } },
      onepassword: { mode: "connect", database_user: "test-vault/credentials/user", database_password: "test-vault/credentials/password" } };
    await expect(getDatabaseUrl(cfg)).rejects.toThrow(/OP_CONNECT_TOKEN/);
  });

  it("rejects duplicate vault names instead of selecting a secret arbitrarily", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([
      { id: "a".repeat(26), name: "test-vault" }, { id: "c".repeat(26), name: "test-vault" },
    ])));
    await expect(getSecretFromOnePassword(ref, "connect-test-token", connect)).rejects.toThrow(/ambiguous/);
  });

  it("uses Connect for database, RPC and GasFree without a service account token", async () => {
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "");
    vi.stubEnv("OP_CONNECT_HOST", connect.host);
    vi.stubEnv("OP_CONNECT_TOKEN", "connect-test-token");
    for (const name of ["TRON_GRID_API_KEY", "GASFREE_API_KEY", "GASFREE_API_SECRET", "GASFREE_API_KEY_NILE", "GASFREE_API_SECRET_NILE"])
      vi.stubEnv(name, "");
    connectResponse();
    const cfg: FacilitatorConfig = { database: { url: "postgresql://localhost/db" }, facilitator: { networks: { "tron:3448148188": {} } },
      onepassword: { mode: "connect", database_user: "test-vault/credentials/password", database_password: "test-vault/credentials/password",
        trongrid_api_key: "test-vault/credentials/password", gasfree_api_key_nile: "test-vault/credentials/password", gasfree_api_secret_nile: "test-vault/credentials/password" } };
    expect(await getDatabaseUrl(cfg)).toBe("postgresql://p%40ss%2Fword:p%40ss%2Fword@localhost/db");
    expect(await getTrongridApiKey(cfg)).toBe("p@ss/word");
    expect(await getGasFreeCredentials(cfg, "tron:nile")).toEqual({ key: "p@ss/word", secret: "p@ss/word" });
  });
});

describe("parseOpRef", () => {
  it("parses a valid vault/item/field reference", () => {
    expect(parseOpRef("vault/item/field")).toEqual({ vault: "vault", item: "item", field: "field" });
  });

  it("trims surrounding whitespace", () => {
    expect(parseOpRef("  v / i / f ")).toEqual({ vault: "v", item: "i", field: "f" });
  });

  it("returns null for malformed references", () => {
    expect(parseOpRef("")).toBeNull();
    expect(parseOpRef("only/two")).toBeNull();
    expect(parseOpRef("a/b/c/d")).toBeNull();
    expect(parseOpRef("a//c")).toBeNull();
    expect(parseOpRef(undefined)).toBeNull();
  });
});

describe("isUsableToken", () => {
  it("accepts a real token and rejects placeholders/empties", () => {
    expect(isUsableToken("ops_realtoken")).toBe(true);
    expect(isUsableToken("your-op-token")).toBe(false);
    expect(isUsableToken("your-service-account-token")).toBe(false);
    expect(isUsableToken("")).toBe(false);
    expect(isUsableToken(undefined)).toBe(false);
  });
});
