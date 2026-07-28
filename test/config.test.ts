import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { configPath, loadConfig, enabledNetworks, getDatabaseUrl, serverPort } from "../src/config.js";
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

  it("throws when database.url is missing", () => {
    expect(() => loadConfig(writeConfig(`facilitator:\n  networks:\n    tron:0xcd8690dc: {}\n`))).toThrow(
      /database.url is required/,
    );
  });

  it("throws when facilitator.networks is empty", () => {
    expect(() =>
      loadConfig(writeConfig(`database:\n  url: "x"\nfacilitator:\n  networks: {}\n`)),
    ).toThrow(/facilitator.networks is required/);
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
    // Omitted → undefined; the build step defaults it to ["exact"].
    expect(cfg.facilitator.networks["eip155:97"].schemes).toBeUndefined();
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

  it("ignores a literal database.password field (only the 1Password ref injects)", async () => {
    // The redundant `database.password` literal was dropped; the password is now
    // resolved solely from the `onepassword.database_password` ref (absent here,
    // so the url is returned unchanged). Local dev embeds the password in the url.
    const cfg = loadConfig(
      writeConfig(`
database:
  url: "postgresql://user@localhost:5432/db"
  password: "p@ss"
facilitator:
  networks:
    tron:0xcd8690dc: {}
`),
    );
    expect(await getDatabaseUrl(cfg)).toBe("postgresql://user@localhost:5432/db");
  });
});

describe("redactDatabaseUrl", () => {
  it("keeps the connection target visible while masking the password", () => {
    expect(redactDatabaseUrl("postgresql+asyncpg://ec2-user:secret@onaws.com:5432/x402_facilitator")).toBe(
      "postgresql+asyncpg://ec2-user:***@onaws.com:5432/x402_facilitator",
    );
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
