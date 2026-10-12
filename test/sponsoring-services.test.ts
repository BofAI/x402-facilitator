import { describe, expect, it } from "vitest";
import { createSponsoringServices, closeSponsoringServices } from "../src/sponsoring/services.js";
import type { SponsoringService } from "../src/sponsoring/service.js";
import type { SponsoringConfig } from "../src/sponsoring/config.js";

describe("multi-network sponsoring lifecycle", () => {
  it("closes already initialized services if a later network fails to initialize", async () => {
    const closed: string[] = [];
    const configs = [{ network: "tron:3448148188" }, { network: "tron:2494104990" }] as SponsoringConfig[];
    await expect(createSponsoringServices(configs, async config => {
      if (config.network === "tron:2494104990") throw new Error("shasta signer unavailable");
      return { close: async () => { closed.push(config.network); } } as SponsoringService;
    })).rejects.toThrow("shasta signer unavailable");
    expect(closed).toEqual(["tron:3448148188"]);
  });

  it("waits for all networks to close even if one close fails", async () => {
    const closed: string[] = [];
    const services = [
      { close: async () => { throw new Error("failed close"); } },
      { close: async () => { await new Promise(resolve => setImmediate(resolve)); closed.push("shasta"); } },
    ] as SponsoringService[];
    await expect(closeSponsoringServices(services)).rejects.toThrow();
    expect(closed).toEqual(["shasta"]);
  });
});
