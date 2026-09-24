import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Trc20SponsoringOperation } from "@bankofai/x402-tron";
import { PostgresSponsoringCoordinator } from "../src/sponsoring/postgres-store.js";

const url = process.env.SPONSORING_TEST_DATABASE_URL;
if (process.env.SPONSORING_REQUIRE_POSTGRES === "1" && !url) throw new Error("SPONSORING_TEST_DATABASE_URL required");
if (url) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/sponsoring_test")
    throw new Error("Only the localhost sponsoring_test database is permitted");
}
const binding = { network: "tron:0xcd8690dc", owner: "owner-a", permissionId: 2 };
const limits = { energy: 10_000_000n, bandwidth: 10_000_000n, budget: 10_000_000n, management: 10_000n };
function operation(key = "approval-a"): Trc20SponsoringOperation {
  return { key, network: binding.network, approvalTxID: key, payer: key, requestDigest: key,
    request: { network: binding.network, approvalTxID: key, payer: key, signedTransaction: key } as Trc20SponsoringOperation["request"],
    plan: { energyRequired: 120n, bandwidthRequired: 110n, managementBandwidthRequired: 700n,
      replacementCost: 1n, legs: [{ resource: "ENERGY", requiredUnits: 120n, delegatedUnits: 120n, stakeSun: 6_000_000n }] },
    budgetUnits: 1n, status: "admitted", actions: [], revision: 0, createdAtMs: 1000 };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe.skipIf(!url)("PostgreSQL sponsoring coordination", () => {
  let admin: Pool, pool: Pool, schema: string;
  beforeEach(async () => {
    admin = new Pool({ connectionString: url });
    schema = `sponsoring_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, application_name: schema, max: 10 });
  });
  afterEach(async () => {
    await pool?.end();
    if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  const create = () => PostgresSponsoringCoordinator.create(pool, binding, limits);

  it("boots concurrently on a fresh schema and canonicalizes equivalent owner bindings", async () => {
    const canonical = { ...binding, owner: "410000000000000000000000000000000000000000" };
    const equivalent = { ...binding, network: "tron:0xCD8690DC", owner: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb" };
    const [a, b] = await Promise.all([
      PostgresSponsoringCoordinator.create(pool, canonical, limits),
      PostgresSponsoringCoordinator.create(pool, equivalent, limits),
    ]);
    expect(a.instanceId).toBe(b.instanceId);
    await a.admit(operation());
    expect((await b.admit(operation("other"))).kind).toBe("denied");
  });

  it("rolls back a failed SQL statement before the next mutation on the same held session", async () => {
    const a = await create();
    await a.runExclusive("owner", async () => {
      await a.admit(operation());
      await expect(a.rememberExpiration("bad", Number.NaN)).rejects.toThrow();
      const saved = await a.save({ ...operation(), status: "reclaiming" });
      expect(saved.revision).toBe(1);
      expect(await a.expiration("bad")).toBeUndefined();
      await a.assertOwnership();
    });
  });

  it("accepts large signed approval bytes without a PostgreSQL index row size failure", async () => {
    const a = await create(), op = operation();
    op.request.signedTransaction = Array.from({ length: 400 }, () => randomUUID()).join("");
    expect((await a.admit(op)).kind).toBe("created");
    expect((await a.findApproval(op.request.signedTransaction))?.key).toBe(op.key);
  });

  it("detects corrupt payloads and rejects unknown schema versions", async () => {
    const a = await create();
    await a.admit(operation());
    await pool.query("UPDATE sponsoring_operations SET payload=$1 WHERE pool=$2", [Buffer.from("corrupt"), a.instanceId]);
    await expect(a.get(operation().key)).rejects.toThrow("sponsor_database_corrupt");
    await pool.query("UPDATE sponsoring_version SET version=999 WHERE id=1");
    await expect(create()).rejects.toThrow("sponsor_database_version_unsupported");
  });

  it("serializes competing revisions and rolls back actions appended before an immutable conflict", async () => {
    const a = await create(), op = operation();
    op.actions = [{ kind: "delegate", resource: "ENERGY", txID: "original", signedTransaction: "aa", status: "prepared" }];
    await a.runExclusive("owner", async () => {
      await a.admit(op);
      await expect(a.save({ ...op, actions: [
        { ...op.actions[0], txID: "rolled-back" }, { ...op.actions[0], signedTransaction: "changed" },
      ] })).rejects.toThrow(/immutable/);
      expect(await a.findAction("rolled-back")).toBeUndefined();
      const results = await Promise.allSettled([a.save({ ...op, status: "reclaiming" }), a.save({ ...op, status: "recovered" })]);
      expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
      expect((await a.get(op.key))?.status).toBe("reclaiming");
    });
    await a.close();
    const b = await create();
    expect((await b.get(op.key))?.status).toBe("reclaiming");
    expect((await b.admit(operation("next"))).kind).toBe("denied");
  });

  it("closes a standby without acquiring a lock and drains local work before external close resolves", async () => {
    const a = await create(), standby = await create();
    const ready = deferred(), resume = deferred();
    const work = a.runExclusive("owner", async () => { ready.resolve(); await resume.promise; });
    await ready.promise;
    await standby.close();
    let closed = false;
    const closing = Promise.resolve(a.close()).then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    try { expect(closed).toBe(false); }
    finally { resume.resolve(); await work; await closing; }
    expect(closed).toBe(true);
    const b = await create();
    await b.runExclusive("owner", async () => { await b.close(); });
    expect((await pool.query("SELECT 1 AS alive")).rows[0].alive).toBe(1);
  });

  it("never admits two six-million reservations against ten million across instances", async () => {
    const a = await create(), b = await create();
    const results = await Promise.allSettled([a.admit(operation("a")), b.admit(operation("b"))]);
    expect(results.filter(r => r.status === "fulfilled" && r.value.kind === "created")).toHaveLength(1);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") expect(result.reason.message).toBe("sponsor_owner_busy");
      if (result.status === "rejected" || result.value.kind !== "created")
        expect((await [a, b][i].admit(operation(["a", "b"][i]))).kind).toBe("denied");
    }
    expect(await a.listRecoverable(1)).toHaveLength(1);
    expect(await a.listRecoverable(0)).toEqual([]);
  });

  it("reuses records but refuses conflicting identity, permission, limits and cross-owner adoption", async () => {
    const a = await create(), b = await create();
    expect(a.instanceId).toBe(b.instanceId);
    await a.admit(operation());
    expect((await b.admit(operation())).kind).toBe("existing");
    expect((await b.admit({ ...operation(), requestDigest: "changed" })).kind).toBe("conflict");
    await expect(PostgresSponsoringCoordinator.create(pool, { ...binding, permissionId: 3 }, limits)).rejects.toThrow(/binding/);
    await expect(PostgresSponsoringCoordinator.create(pool, binding, { ...limits, energy: 1n })).rejects.toThrow(/binding/);
    const other = await PostgresSponsoringCoordinator.create(pool, { ...binding, owner: "other" }, limits);
    expect(await other.get(operation().key)).toBeUndefined();
    expect((await other.admit(operation())).kind).toBe("conflict");
    expect(await other.findApproval(operation().request.signedTransaction)).toBeUndefined();
  });

  it("persists exact bytes, bigint, deadlines and rolls back action and revision failures", async () => {
    const a = await create();
    const op = operation(); op.plan.replacementCost = 90071992547409931234n;
    op.actions = [{ kind: "delegate", resource: "ENERGY", txID: "prepared", signedTransaction: "deadbeef", status: "prepared" }];
    await a.admit(op);
    await a.noteDelegate(op.key, 4000); await a.noteDelegate(op.key, 9000);
    await a.rememberExpiration("TX", 7000); await a.rememberExpiration("tx", 8000);
    await expect(a.save({ ...op, actions: [{ ...op.actions[0], signedTransaction: "bb" }] })).rejects.toThrow(/immutable/);
    expect(await a.get(op.key)).toEqual(op);
    const saved = await a.save({ ...op, status: "reclaiming" });
    await expect(a.save(op)).rejects.toThrow(/revision/);
    await a.close();
    const b = await create();
    expect(await b.get(op.key)).toEqual(saved);
    expect(await b.deadlines(op.key)).toEqual({ businessDeadline: 481000, forceReclaimAt: 604000 });
    expect(await b.expiration("TX")).toBe(7000);
    expect((await b.findAction("prepared"))?.key).toBe(op.key);
    expect((await b.findApproval(op.request.signedTransaction))?.key).toBe(op.key);
  });

  it("excludes competing callbacks, allows different owners and serializes nested concurrent writes", async () => {
    const a = await create(), b = await create();
    const other = await PostgresSponsoringCoordinator.create(pool, { ...binding, owner: "other" }, limits);
    await a.runExclusive("owner", async () => {
      await expect(b.runExclusive("payer", async () => { throw new Error("callback ran"); })).rejects.toThrow("sponsor_owner_busy");
      expect(await other.runExclusive("owner", async () => 42)).toBe(42);
      await a.runExclusive("payer", async () => {
        await a.admit(operation());
        await Promise.all([a.checked(operation().key), a.noteDelegate(operation().key, 1234)]);
        await a.assertOwnership();
      });
    });
    await b.runExclusive("owner", async () => { await b.assertOwnership(); });
    await expect(b.assertOwnership()).rejects.toThrow(/ownership/);
  });

  it("fences disconnected and detached contexts while keeping prepared bytes recoverable", async () => {
    const a = await create(), b = await create();
    const ready = deferred(), resume = deferred();
    const op = operation();
    op.actions = [{ kind: "delegate", resource: "ENERGY", txID: "prepared", signedTransaction: "deadbeef", status: "prepared" }];
    const suspended = a.runExclusive("owner", async () => {
      await a.admit(op); ready.resolve(); await resume.promise;
      await expect(a.assertOwnership()).rejects.toThrow(/ownership/);
      await expect(a.save(op)).rejects.toThrow(/ownership/);
      await expect(a.get(op.key)).rejects.toThrow(/ownership/);
    });
    await ready.promise;
    // Identify the held connection by its schema, without terminating unrelated backends.
    const held = await pool.query("SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.granted AND a.application_name=$1", [schema]);
    expect(held.rows).toHaveLength(1);
    await admin.query("SELECT pg_terminate_backend($1)", [held.rows[0].pid]);
    await b.runExclusive("owner", async () => { expect((await b.findAction("prepared"))?.actions[0].signedTransaction).toBe("deadbeef"); });
    resume.resolve(); await suspended;
    const late = deferred(); let detached!: Promise<void>;
    await b.runExclusive("owner", async () => { detached = late.promise.then(async () => { await expect(b.checked(op.key)).rejects.toThrow(/ownership/); }); });
    late.resolve(); await detached;
  });
});
