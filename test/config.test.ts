import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { loadConfig, enabledNetworks, getDatabaseUrl, serverPort } from "../src/config.js";

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
    tron:nile:
      schemes: ["exact", "upto", "batch-settlement"]
    bsc:testnet:
      schemes: ["exact"]
`;

describe("loadConfig", () => {
  it("loads and lists enabled networks", () => {
    const cfg = loadConfig(writeConfig(VALID));
    expect(enabledNetworks(cfg)).toEqual(["tron:nile", "bsc:testnet"]);
  });

  it("throws when database.url is missing", () => {
    expect(() => loadConfig(writeConfig(`facilitator:\n  networks:\n    tron:nile: {}\n`))).toThrow(
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
    tron:nile:
      schemes: ["exact", "upto", "batch-settlement"]
    bsc:testnet: {}
`),
    );
    expect(cfg.facilitator.networks["tron:nile"].schemes).toEqual([
      "exact",
      "upto",
      "batch-settlement",
    ]);
    // Omitted → undefined; the build step defaults it to ["exact"].
    expect(cfg.facilitator.networks["bsc:testnet"].schemes).toBeUndefined();
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
    tron:nile: {}
`),
    );
    expect(await getDatabaseUrl(cfg)).toBe("postgresql://user@localhost:5432/db");
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
    tron:nile: {}
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
    tron:nile: {}
`),
    );
    expect(serverPort(cfg)).toBe(9999);
  });
});
