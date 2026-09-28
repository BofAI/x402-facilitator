import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { providers } from "tronweb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrc20ApprovalResourceSponsoringRuntime, type FacilitatorTronSigner,
  type Trc20ApprovalResourceSponsoringRequest, type Trc20ResourceSponsoringChain } from "@bankofai/x402-tron";
import { sponsoringConfigSchema } from "../src/sponsoring/config.js";
import { createSponsoringService, type SponsoringService } from "../src/sponsoring/service.js";
import { PostgresSponsoringCoordinator } from "../src/sponsoring/postgres-store.js";
import { createApp } from "../src/server.js";
import { setApiKeyCacheForTest } from "../src/auth.js";
import type { x402Facilitator } from "@bankofai/x402-core/facilitator";

const fake = vi.hoisted(() => ({ chain: undefined as unknown as Trc20ResourceSponsoringChain, failInitialization: false }));
vi.mock("@bankofai/x402-tron", async original => ({ ...await original<object>(),
  createTronWebResourceSponsoringChain: async () => fake.chain }));
vi.mock("../src/sponsoring/signer.js", () => ({ buildResourceOwnerSigner: async () => {
  if (fake.failInitialization) throw new Error("signer initialization failed");
  return {
  getAddress: async () => "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8",
  signResourceTransaction: async () => { throw new Error("unexpected signing"); },
}; } }));

const url = process.env.SPONSORING_TEST_DATABASE_URL;
if (process.env.SPONSORING_REQUIRE_POSTGRES === "1" && !url) throw new Error("SPONSORING_TEST_DATABASE_URL required");
if (url && (!["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).pathname !== "/sponsoring_test"))
  throw new Error("Only the localhost sponsoring_test database is permitted");
const owner = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8", payer = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
const config = sponsoringConfigSchema.parse({ network: "tron:3448148188", storage: { type: "postgres" },
  owner, wallet_id: "unused", permission_id: 2, assets: [owner], pay_to: [payer],
  energy_stake_sun: "1000000000", bandwidth_stake_sun: "1000000000", budget_sun: "100000000", management_bandwidth: "10000" });
const settlement = { getAddresses: () => [payer], readContract: async () => 0n } as unknown as FacilitatorTronSigner;
function request(id = "a"): Trc20ApprovalResourceSponsoringRequest {
  const requirements = { scheme: "exact", network: config.network, asset: owner, amount: "1", payTo: payer, maxTimeoutSeconds: 600 };
  return { network: config.network, approvalTxID: id.repeat(64), approvalTimestamp: String(Date.now()),
    approvalExpiration: String(Date.now() + 600000), approvalFeeLimitSun: "100000000", approvalRefBlockBytes: "1234",
    approvalRefBlockHash: "0102030405060708", payer, asset: owner, spender: payer, amount: String((1n << 256n) - 1n),
    requiredAllowance: "1", signedTransaction: `approval-${id}`, paymentRequirements: requirements,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: {} } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe.skipIf(!url)("service with shared PostgreSQL coordinator", () => {
  let admin: Pool, pool: Pool, schema: string;
  let remote: PostgresSponsoringCoordinator;
  const services: SponsoringService[] = [];
  const binding = { network: config.network, owner, permissionId: 2 };
  const limits = { energy: 1000000000n, bandwidth: 1000000000n, budget: 100000000n, management: 10000n };
  beforeEach(async () => {
    fake.failInitialization = false;
    admin = new Pool({ connectionString: url });
    schema = `sponsoring_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, application_name: schema });
    remote = await PostgresSponsoringCoordinator.create(pool, binding, limits);
    vi.spyOn(providers.HttpProvider.prototype, "request").mockImplementation(async path => {
      if (path === "walletsolidity/getdelegatedresourceaccountindexv2" || path === "walletsolidity/getdelegatedresourcev2") return {};
      throw new Error(`Unexpected RPC: ${path}`);
    });
    fake.chain = {
      preflight: vi.fn(async () => ({ accountActivated: true, accountIsContract: false, allowance: 0n, tokenBalance: 100n,
        estimatedEnergy: 100n, estimatedBandwidth: 100n, managementBandwidthAvailable: 10000n, replacementCost: 1n,
        resources: { energyAvailable: 0n, stakedBandwidthAvailable: 1000n, freeBandwidthAvailable: 0n,
          totalEnergyLimit: 1000n, totalEnergyWeight: 100n, totalBandwidthLimit: 1000n, totalBandwidthWeight: 100n } })),
      prepareDelegate: vi.fn(async () => ({ txID: "delegate", signedTransaction: "original-delegate" })),
      prepareUndelegate: vi.fn(async () => ({ txID: "reclaim", signedTransaction: "original-reclaim" })),
      broadcast: vi.fn(async action => action.txID), broadcastApproval: vi.fn(async () => "approval"),
      confirm: vi.fn(async () => "unknown"), allowanceSufficient: vi.fn(async () => false),
      resourcesVisible: vi.fn(async () => true), capacityRecovered: vi.fn(async () => false),
    };
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.close()));
    await remote?.close();
    await pool?.end();
    if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
    vi.restoreAllMocks();
  });
  async function service(start = true) {
    const value = await createSponsoringService(config, settlement, { pool });
    services.push(value);
    if (start) { value.start(); await vi.waitFor(() => expect(value.readiness().mode).toBe("READY")); }
    return value;
  }
  async function seed(req = request()) {
    const sdk = createTrc20ApprovalResourceSponsoringRuntime({ chain: fake.chain, coordinator: remote,
      policy: { preview: async () => ({ allowed: true, budgetUnits: 1n }) }, approvalPolicy: { strategyFor: () => "zero-first" } });
    await remote.runExclusive("owner", () => sdk.sponsor(req));
    expect((await remote.get(`${config.network}:${req.approvalTxID}`))?.actions.some(action => action.status === "unknown")).toBe(true);
    vi.mocked(fake.chain.preflight).mockClear();
    vi.mocked(fake.chain.broadcast).mockClear();
    return req;
  }

  it("requires an existing shared pool for PostgreSQL", async () => {
    await expect(createSponsoringService(config, settlement)).rejects.toThrow("sponsor_postgres_pool_required");
  });
  it("awaits async close on initialization failure and leaves the shared Pool open", async () => {
    const original = PostgresSponsoringCoordinator.prototype.close;
    const entered = deferred(), release = deferred();
    const close = vi.spyOn(PostgresSponsoringCoordinator.prototype, "close").mockImplementation(async function() {
      entered.resolve(); await release.promise; await original.call(this);
    });
    fake.failInitialization = true;
    let finished = false;
    const pending = createSponsoringService(config, settlement, { pool }).catch(error => { finished = true; return error; });
    await entered.promise;
    try { expect(finished).toBe(false); }
    finally { release.resolve(); }
    expect(await pending).toMatchObject({ message: "signer initialization failed" });
    close.mockRestore();
    expect((await pool.query("SELECT 1 AS value")).rows[0].value).toBe(1);
  });
  it("returns owner busy without degrading a ready standby and closes without the remote lock", async () => {
    const value = await service();
    const held = deferred(), release = deferred();
    const execution = remote.runExclusive("owner", async () => { held.resolve(); await release.promise; });
    await held.promise;
    try {
      expect(await value.runtime.sponsor(request())).toMatchObject({ success: false, errorReason: "sponsor_owner_busy" });
      expect(value.readiness().mode).toBe("READY");
      expect(await value.runtime.verify(request())).toMatchObject({ isValid: true });
      await value.close();
      expect((await pool.query("SELECT 1 AS value")).rows[0].value).toBe(1);
    } finally { release.resolve(); await execution; }
  });
  it("rechecks shared pending operations despite stale local READY", async () => {
    const value = await service();
    await seed();
    expect(value.readiness().ready).toBe(true);
    expect(await value.runtime.sponsor(request("b"))).toMatchObject({ success: false, errorReason: "sponsor_recovery_in_progress" });
    expect(fake.chain.preflight).not.toHaveBeenCalled();
    expect(fake.chain.broadcast).not.toHaveBeenCalled();
    expect(await remote.get(`${config.network}:${"b".repeat(64)}`)).toBeUndefined();
    expect(value.readiness()).toMatchObject({ ready: false, mode: "RECOVERING" });
  });
  it("loses execution authority when its PG session dies even after another owner session acquires the lock", async () => {
    const value = await service();
    const req = await seed();
    const before = await remote.get(`${config.network}:${req.approvalTxID}`);
    const held = deferred(), release = deferred();
    vi.mocked(fake.chain.confirm).mockImplementationOnce(async () => { held.resolve(); await release.promise; return "unknown"; });
    const pending = value.runtime.sponsor(req);
    await held.promise;
    try {
      const clients = await admin.query(`SELECT DISTINCT a.pid FROM pg_stat_activity a JOIN pg_locks l ON a.pid=l.pid
        WHERE a.application_name=$1 AND l.locktype='advisory' AND l.granted`, [schema]);
      expect(clients.rows).toHaveLength(1);
      await admin.query("SELECT pg_terminate_backend($1)", [clients.rows[0].pid]);
      await remote.runExclusive("fresh", async () => {
        await remote.assertOwnership();
        release.resolve();
        expect(await pending).toMatchObject({ success: false, errorReason: "sponsor_storage_unavailable" });
      });
      expect(value.readiness().mode).toBe("DEGRADED");
      expect(value.access().canRetryExisting).toBe(false);
      expect(fake.chain.broadcast).not.toHaveBeenCalled();
      expect((await remote.get(before!.key))?.actions).toEqual(before!.actions);
    } finally { release.resolve(); await pending; }
  });
  it("HTTP recovery gate reaches real runtime for existing retries and rejects fresh or unauthenticated requests", async () => {
    const req = await seed();
    const value = await service(false);
    value.start();
    await vi.waitFor(() => expect(value.access().canRetryExisting).toBe(true));
    setApiKeyCacheForTest(["retry-test"]);
    const facilitator = { getSupported: () => ({}),
      verify: async (payload: { payload: { request: Trc20ApprovalResourceSponsoringRequest } }) => value.runtime.verify(payload.payload.request),
      settle: async (payload: { payload: { request: Trc20ApprovalResourceSponsoringRequest } }) => value.runtime.sponsor(payload.payload.request) };
    const app = createApp(facilitator as unknown as x402Facilitator, { rateLimit: { authenticated: "1000/minute", anonymous: "1000/minute" },
      gasfreeSettings: () => null, metricsOnMainPort: false, metricsEndpoint: "/metrics", maxRequestBodyBytes: 100000, sponsoring: value });
    for (const route of ["/verify", "/settle"]) {
      for (const [candidate, authenticated, status] of [[req, true, 200], [request("b"), true, 503], [req, false, 403]] as const) {
        const response = await app.request(route, { method: "POST", headers: { "content-type": "application/json",
          ...(authenticated ? { "X-API-KEY": "retry-test" } : {}) }, body: JSON.stringify({ paymentRequirements: candidate.paymentRequirements,
          paymentPayload: { ...candidate.paymentPayload, payload: { request: candidate }, extensions: { trc20ApprovalResourceSponsoring: {} } } }) });
        expect(response.status).toBe(status);
        if (status === 503) expect(response.headers.get("Retry-After")).toBe("15");
        const body = await response.json();
        if (!authenticated) expect(body).toMatchObject(route === "/verify" ? { invalidReason: "sponsor_auth_required" } : { errorReason: "sponsor_auth_required" });
        else if (candidate === req) expect(body).toMatchObject(route === "/verify" ? { isValid: true } : { errorReason: "unknown_chain_state" });
      }
    }
    expect(fake.chain.broadcast).not.toHaveBeenCalled();
    expect(await remote.get(`${config.network}:${"b".repeat(64)}`)).toBeUndefined();
    expect(value.readiness().ready).toBe(false);
  });
  it("recovers on startup and routes only unchanged existing retries through SDK state handling", async () => {
    const req = await seed();
    const value = await service(false);
    expect(value.access().canRetryExisting).not.toBe(true);
    value.start();
    await vi.waitFor(() => expect(value.readiness().mode).toBe("RECOVERING"));
    await vi.waitFor(() => expect(value.access().canRetryExisting).toBe(true));
    expect(await value.runtime.verify(req)).toMatchObject({ isValid: true });
    expect(await value.runtime.verify({ ...req, amount: "5" })).toMatchObject({ isValid: false, invalidReason: "approval_transaction_reused" });
    expect(await value.runtime.verify(request("b"))).toMatchObject({ isValid: false, invalidReason: "sponsor_recovery_in_progress" });
    const before = await remote.get(`${config.network}:${req.approvalTxID}`);
    expect(await value.runtime.sponsor(req)).toMatchObject({ success: false, errorReason: "unknown_chain_state" });
    expect(fake.chain.broadcast).not.toHaveBeenCalled();
    expect((await remote.get(before!.key))?.actions).toEqual(before!.actions);
    expect(await value.runtime.sponsor({ ...req, amount: "5" })).toMatchObject({ success: false, errorReason: "approval_transaction_reused" });
    expect((await remote.get(before!.key))?.request).toEqual(before!.request);
  });
  it("keeps READY during a normal sweep while its storage read is pending", async () => {
    vi.useFakeTimers();
    const value = await service();
    const original = PostgresSponsoringCoordinator.prototype.listRecoverable;
    const held = deferred(), release = deferred();
    vi.spyOn(PostgresSponsoringCoordinator.prototype, "listRecoverable").mockImplementation(async function(limit) {
      held.resolve(); await release.promise; return original.call(this, limit);
    });
    try {
      await vi.advanceTimersByTimeAsync(15000);
      await held.promise;
      expect(value.readiness().mode).toBe("READY");
    } finally { release.resolve(); await value.close(); vi.useRealTimers(); }
  });
});
