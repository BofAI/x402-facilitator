import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, enabledNetworks, getDatabaseUrl } from "../src/config.js";

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
      base_fee:
        USDT: 100
    bsc:testnet:
      base_fee:
        USDC: 100
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
});

describe("getDatabaseUrl", () => {
  it("returns the url unchanged when no password is configured", async () => {
    const cfg = loadConfig(writeConfig(VALID));
    expect(await getDatabaseUrl(cfg)).toBe("postgresql://user@localhost:5432/db");
  });

  it("injects a literal password from config", async () => {
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
    const url = await getDatabaseUrl(cfg);
    expect(url).toContain("@localhost:5432/db");
    // special chars are percent-encoded
    expect(url).toContain("p%40ss");
  });
});
