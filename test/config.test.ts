import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  configPath,
  loadConfig,
  enabledNetworks,
  getDatabaseUrl,
  databaseUrlWithCredentials,
  serverPort,
} from "../src/config.js";
import { redactDatabaseUrl } from "../src/runtime.js";

function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "facilitator-cfg-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, body);
  return path;
}

const VALID = `
database:
  url: "postgresql://user@localhost:5432/db"
facilitator:
  networks:
    tron:0xcd8690dc:
      schemes: ["exact", "upto", "batch-settlement"]
    eip155:97:
      schemes: ["exact"]
`;

describe("loadConfig", () => {
  it("loads and lists enabled networks", () => {
    const cfg = loadConfig(writeConfig(VALID));
    expect(enabledNetworks(cfg)).toEqual(["tron:0xcd8690dc", "eip155:97"]);
  });

  it("loads built-in configs with uppercase logging levels", () => {
    for (const environment of ["dev", "prod"]) {
      const cfg = loadConfig(resolve(process.cwd(), `config/facilitator.config.${environment}.yaml`));
      expect(cfg.logging?.level).toBe("info");
    }
  });

  it("throws when database.url is missing", () => {
    expect(() => loadConfig(writeConfig(`facilitator:\n  networks:\n    tron:0xcd8690dc: {}\n`))).toThrow(
      /database: Required/,
    );
  });

  it("throws when facilitator.networks is empty", () => {
    expect(() =>
      loadConfig(writeConfig(`database:\n  url: "x"\nfacilitator:\n  networks: {}\n`)),
    ).toThrow(/facilitator.networks: must be a non-empty object/);
  });

  it("parses a per-network schemes list (absent on networks that omit it)", () => {
    const cfg = loadConfig(
      writeConfig(`
database:
  url: "x"
facilitator:
  networks:
    tron:0xcd8690dc:
      schemes: ["exact", "upto", "batch-settlement"]
    eip155:97: {}
`),
    );
    expect(cfg.facilitator.networks["tron:0xcd8690dc"].schemes).toEqual([
      "exact",
      "upto",
      "batch-settlement",
    ]);
    // Omitted → undefined; the build step defaults it to all supported schemes.
    expect(cfg.facilitator.networks["eip155:97"].schemes).toBeUndefined();
  });

  it("rejects invalid schemes, duplicate schemes, unsupported networks, and unknown keys", () => {
    expect(() =>
      loadConfig(
        writeConfig(`
database:
  url: "x"
facilitator:
  networks:
    eip155:97:
      schemes: ["excat", "exact"]
`),
      ),
    ).toThrow(/facilitator.networks.eip155:97.schemes.0/);

    expect(() =>
      loadConfig(
        writeConfig(`
database:
  url: "x"
facilitator:
  networks:
    eip155:97:
      schemes: ["exact", "exact"]
`),
      ),
    ).toThrow(/must not contain duplicates/);

    expect(() =>
      loadConfig(
        writeConfig(`
database:
  url: "x"
facilitator:
  networks:
    eip155:1: {}
`),
      ),
    ).toThrow(/Unsupported canonical CAIP-2 network/);

    expect(() =>
      loadConfig(
        writeConfig(`
database:
  url: "x"
  password: "not-supported"
facilitator:
  networks:
    eip155:97: {}
`),
      ),
    ).toThrow(/database: Unrecognized key/);
  });

});

describe("configPath", () => {
  const serviceEnv = process.env.FACILITATOR_SERVICE_ENV;
  const explicitPath = process.env.FACILITATOR_CONFIG_PATH;

  afterEach(() => {
    if (serviceEnv === undefined) delete process.env.FACILITATOR_SERVICE_ENV;
    else process.env.FACILITATOR_SERVICE_ENV = serviceEnv;
    if (explicitPath === undefined) delete process.env.FACILITATOR_CONFIG_PATH;
    else process.env.FACILITATOR_CONFIG_PATH = explicitPath;
  });

  it("selects the development config for FACILITATOR_SERVICE_ENV=dev", () => {
    delete process.env.FACILITATOR_CONFIG_PATH;
    process.env.FACILITATOR_SERVICE_ENV = "dev";
    expect(configPath()).toBe(resolve(process.cwd(), "config/facilitator.config.dev.yaml"));
  });

  it("selects the production config for FACILITATOR_SERVICE_ENV=prod", () => {
    delete process.env.FACILITATOR_CONFIG_PATH;
    process.env.FACILITATOR_SERVICE_ENV = "prod";
    expect(configPath()).toBe(resolve(process.cwd(), "config/facilitator.config.prod.yaml"));
  });

  it("prefers FACILITATOR_CONFIG_PATH over FACILITATOR_SERVICE_ENV", () => {
    process.env.FACILITATOR_SERVICE_ENV = "prod";
    process.env.FACILITATOR_CONFIG_PATH = "config/custom.yaml";
    expect(configPath()).toBe(resolve("config/custom.yaml"));
  });

  it("requires an explicit configuration source", () => {
    delete process.env.FACILITATOR_SERVICE_ENV;
    delete process.env.FACILITATOR_CONFIG_PATH;
    expect(configPath).toThrow(/Configuration source is required/);
  });

  it("rejects an unsupported FACILITATOR_SERVICE_ENV", () => {
    delete process.env.FACILITATOR_CONFIG_PATH;
    process.env.FACILITATOR_SERVICE_ENV = "staging";
    expect(configPath).toThrow(/must be either 'dev' or 'prod'/);
  });
});

describe("getDatabaseUrl", () => {
  it("returns the url unchanged when no password is configured", async () => {
    const cfg = loadConfig(writeConfig(VALID));
    expect(await getDatabaseUrl(cfg)).toBe("postgresql://user@localhost:5432/db");
  });

  it("does not resolve 1Password when the URL already has complete credentials", async () => {
    const cfg = loadConfig(writeConfig(`
database:
  url: "postgresql://user:password@localhost:5432/db"
onepassword:
  database_user: "invalid"
  database_password: "invalid"
facilitator:
  networks:
    tron:0xcd8690dc: {}
`));
    expect(await getDatabaseUrl(cfg)).toBe("postgresql://user:password@localhost:5432/db");
  });

  it("rejects incomplete database credential configuration before opening a pool", async () => {
    const cfg = loadConfig(writeConfig(`
database:
  url: "postgresql://localhost:5432/db"
onepassword:
  database_user: "vault/item/user"
facilitator:
  networks:
    tron:0xcd8690dc: {}
`));
    await expect(getDatabaseUrl(cfg)).rejects.toThrow(/must be configured together/);
  });

  it("rejects missing 1Password token when database credentials are required", async () => {
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    const cfg = loadConfig(writeConfig(`
database:
  url: "postgresql://localhost:5432/db"
onepassword:
  database_user: "vault/item/user"
  database_password: "vault/item/password"
facilitator:
  networks:
    tron:0xcd8690dc: {}
`));
    await expect(getDatabaseUrl(cfg)).rejects.toThrow(/requires a valid OP_SERVICE_ACCOUNT_TOKEN/);
  });

  it("injects resolved 1Password database credentials into the URL", () => {
    expect(
      databaseUrlWithCredentials(
        "postgresql+asyncpg://host:5432/x402_facilitator",
        "db-user",
        "p@ss/word",
      ),
    ).toBe("postgresql+asyncpg://db-user:p%40ss%2Fword@host:5432/x402_facilitator");
  });
});

describe("redactDatabaseUrl", () => {
  it("keeps the connection target visible while masking the password", () => {
    expect(redactDatabaseUrl("postgresql+asyncpg://ec2-user:secret@onaws.com:5432/x402_facilitator")).toBe(
      "postgresql+asyncpg://ec2-user:***@onaws.com:5432/x402_facilitator",
    );
  });

  it("masks sensitive query values without leaking a sentinel secret", () => {
    const redacted = redactDatabaseUrl(
      "postgresql://user:sentinel-userinfo@db.example/app?password=sentinel-query&TOKEN=sentinel-token&sslmode=require",
    );
    expect(redacted).not.toContain("sentinel-userinfo");
    expect(redacted).not.toContain("sentinel-query");
    expect(redacted).not.toContain("sentinel-token");
    expect(redacted).toContain("sslmode=require");
  });
});

describe("serverPort", () => {
  const prev = process.env.SERVER_PORT;
  afterEach(() => {
    if (prev === undefined) delete process.env.SERVER_PORT;
    else process.env.SERVER_PORT = prev;
  });

  it("defaults to 8001 when neither env nor YAML sets a port", () => {
    delete process.env.SERVER_PORT;
    const cfg = loadConfig(writeConfig(VALID));
    expect(serverPort(cfg)).toBe(8001);
  });

  it("SERVER_PORT env overrides the YAML server.port (Dockerfile HEALTHCHECK relies on this)", () => {
    const cfg = loadConfig(
      writeConfig(`
database:
  url: "x"
server:
  port: 9999
facilitator:
  networks:
    tron:0xcd8690dc: {}
`),
    );
    process.env.SERVER_PORT = "8001";
    expect(serverPort(cfg)).toBe(8001);
  });

  it("falls back to YAML server.port when SERVER_PORT is unset", () => {
    delete process.env.SERVER_PORT;
    const cfg = loadConfig(
      writeConfig(`
database:
  url: "x"
server:
  port: 9999
facilitator:
  networks:
    tron:0xcd8690dc: {}
`),
    );
    expect(serverPort(cfg)).toBe(9999);
  });
});
