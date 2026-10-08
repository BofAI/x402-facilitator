import { describe, expect, it } from "vitest";
import { sponsoringConfigSchema } from "../src/sponsoring/config.js";
const config = { network: "tron:0xcd8690dc", database: "/data/sponsor.sqlite", owner: "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8",
  wallet_id: "resources", permission_id: 2, assets: ["TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"],
  pay_to: ["TJRabPrwbZy45sbavfcjinPJC18kjpRTv8"], energy_stake_sun: "1000000000", bandwidth_stake_sun: "1000000000",
  budget_sun: "100000000", management_bandwidth: "10000" };
describe("sponsoring config", () => {
  it.each(["tron:3448148188", "tron:0xcd8690dc", "tron:2494104990", "tron:0x94a9059e"])("does not require a receiver allowlist for %s", network => {
    const { pay_to: _payTo, ...withoutPayTo } = config;
    void _payTo;
    expect(sponsoringConfigSchema.parse({ ...withoutPayTo, network }).pay_to).toBeUndefined();
    expect(sponsoringConfigSchema.safeParse({ ...config, network, pay_to: [] }).success).toBe(true);
    expect(sponsoringConfigSchema.safeParse({ ...config, network, pay_to: ["REPLACE_WITH_DEV_PAYMENT_RECIPIENT"] }).success).toBe(true);
  });
  it.each(["tron:3448148188", "tron:0xcd8690dc"])("allows disabling API keys only for Nile %s", network => {
    expect(sponsoringConfigSchema.parse({ ...config, network, require_api_key: false }).require_api_key).toBe(false);
  });
  it("rejects disabling authentication on Shasta and non-boolean switches", () => {
    for (const network of ["tron:2494104990", "tron:0x94a9059e"]) {
      expect(sponsoringConfigSchema.safeParse({ ...config, network, require_api_key: false }).success).toBe(false);
      expect(sponsoringConfigSchema.safeParse({ ...config, network, require_api_key: true }).success).toBe(true);
    }
    expect(sponsoringConfigSchema.safeParse({ ...config, require_api_key: "false" }).success).toBe(false);
  });
  it.each(["tron:2494104990", "tron:0x94a9059e"])("accepts isolated Shasta sponsoring configuration %s", network => {
    expect(sponsoringConfigSchema.parse({ ...config, network }).network).toBe("tron:2494104990");
  });
  it.each(["tron:728126428", "tron:0x2b6653dc", "tron:1"])("rejects mainnet and unknown sponsoring network %s", network => {
    expect(sponsoringConfigSchema.safeParse({ ...config, network }).success).toBe(false);
  });
  it("selects exactly one legacy, explicit SQLite, or PostgreSQL backend", () => {
    const { database: _database, ...common } = config;
    void _database;
    expect(sponsoringConfigSchema.safeParse({ ...common, storage: { type: "sqlite", path: "/data/sponsor.sqlite" } }).success).toBe(true);
    expect(sponsoringConfigSchema.safeParse({ ...common, storage: { type: "postgres" } }).success).toBe(true);
    expect(sponsoringConfigSchema.safeParse({ ...config, storage: { type: "postgres" } }).success).toBe(false);
    expect(sponsoringConfigSchema.safeParse(common).success).toBe(false);
    expect(sponsoringConfigSchema.safeParse({ ...common, storage: { type: "sqlite", path: "relative" } }).success).toBe(false);
    expect(sponsoringConfigSchema.safeParse({ ...common, storage: { type: "postgres", path: "/tmp/unused" } }).success).toBe(false);
  });
  it("requires an explicit isolated wallet, absolute database path and test network", () => {
    expect(sponsoringConfigSchema.safeParse(config).success).toBe(true);
    for (const override of [{ network: "tron:0x2b6653dc" }, { wallet_id: "" }, { database: "local.sqlite" },
      { energy_stake_sun: "-1" }, { permission_id: 0 }, { assets: [] }, { owner: "invalid" }]) {
      expect(sponsoringConfigSchema.safeParse({ ...config, ...override }).success).toBe(false);
    }
  });
});
