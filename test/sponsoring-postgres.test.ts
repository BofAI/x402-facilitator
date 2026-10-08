import { createHash, randomUUID } from "node:crypto";
import { serialize } from "node:v8";
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

  it("uses only three tables and takes changed limits from configuration without losing debt", async () => {
    const a = await create();
    await a.admit(operation());
    await a.close();
    const b = await PostgresSponsoringCoordinator.create(pool, { ...binding, permissionId: 3 }, { ...limits, energy: 5_000_000n });
    expect(b.instanceId).toBe(a.instanceId);
    expect((await b.listRecoverable(100)).map(op => op.key)).toEqual(["approval-a"]);
    expect((await b.admit(operation("next"))).kind).toBe("denied");
    expect((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows.map(row => row.tablename))
      .toEqual(["sponsoring_actions", "sponsoring_expirations", "sponsoring_operations"]);
  });

  it("isolates the same owner and transaction IDs across networks while sharing one database", async () => {
    const nile = await create();
    const shasta = await PostgresSponsoringCoordinator.create(pool, { ...binding, network: "tron:2494104990" }, limits);
    const first = operation("tron:3448148188:same");
    first.approvalTxID = "same";
    const second = { ...operation("tron:2494104990:same"), network: "tron:2494104990", approvalTxID: "same" };
    second.request = { ...second.request, network: second.network };
    await nile.runExclusive("owner", async () => {
      expect((await nile.admit(first)).kind).toBe("created");
      expect((await shasta.admit(second)).kind).toBe("created");
      await nile.rememberExpiration("tx", 1000);
      await shasta.rememberExpiration("tx", 2000);
    });
    expect(await nile.get(second.key)).toBeUndefined();
    expect(await shasta.get(first.key)).toBeUndefined();
    expect(await nile.expiration("tx")).toBe(1000);
    expect(await shasta.expiration("tx")).toBe(2000);
    expect((await nile.listRecoverable(100)).map(op => op.key)).toEqual([first.key]);
    expect((await shasta.listRecoverable(100)).map(op => op.key)).toEqual([second.key]);
  });

  async function seedOldSchema() {
    await pool.query(`
      CREATE TABLE sponsoring_version (id integer PRIMARY KEY CHECK(id=1), version integer NOT NULL);
      INSERT INTO sponsoring_version VALUES(1,1);
      CREATE TABLE sponsoring_pools (id text PRIMARY KEY, network text NOT NULL, owner text NOT NULL,
        permission integer NOT NULL, limits bytea NOT NULL, UNIQUE(network,owner));
      CREATE TABLE sponsoring_operations (
        key text PRIMARY KEY, pool text NOT NULL REFERENCES sponsoring_pools(id),
        network text NOT NULL, approval text NOT NULL, payer text NOT NULL, status text NOT NULL,
        revision integer NOT NULL, payload bytea NOT NULL, checksum text NOT NULL,
        created bigint NOT NULL, first_delegate bigint, checked bigint NOT NULL DEFAULT 0,
        approval_bytes text, approval_hash text, UNIQUE(network,approval));
      CREATE TABLE sponsoring_actions (pool text NOT NULL REFERENCES sponsoring_pools(id), txid text NOT NULL,
        operation_key text NOT NULL REFERENCES sponsoring_operations(key), kind text NOT NULL,
        resource text, signed_transaction text NOT NULL, PRIMARY KEY(pool,txid));
      CREATE TABLE sponsoring_expirations (pool text NOT NULL REFERENCES sponsoring_pools(id), txid text NOT NULL,
        expires bigint NOT NULL, PRIMARY KEY(pool,txid));
    `);
    const op = operation();
    op.status = "failed_recovering";
    op.actions = [{ kind: "undelegate", resource: "ENERGY", txID: "old-action", signedTransaction: "exact-bytes", status: "unknown" }];
    const bytes = serialize(op);
    await pool.query("INSERT INTO sponsoring_pools VALUES($1,$2,$3,$4,$5)",
      ["old-pool", "tron:3448148188", binding.owner, 2, serialize(limits)]);
    await pool.query(`INSERT INTO sponsoring_operations
      (key,pool,network,approval,payer,status,revision,payload,checksum,created,first_delegate,checked,approval_bytes,approval_hash)
      VALUES($1,'old-pool','tron:3448148188',$2,$3,$4,0,$5,$6,1000,4000,9000,$7,$8)`,
      [op.key, op.approvalTxID, op.payer, op.status, bytes, createHash("sha256").update(bytes).digest("hex"),
        op.request.signedTransaction, createHash("sha256").update(op.request.signedTransaction).digest("hex")]);
    await pool.query("INSERT INTO sponsoring_actions VALUES('old-pool','old-action',$1,'undelegate','ENERGY','exact-bytes')", [op.key]);
    await pool.query("INSERT INTO sponsoring_expirations VALUES('old-pool','old-action',8000)");
    return op;
  }

  it("migrates the old five-table ledger atomically and preserves recovery records on repeat startup", async () => {
    const op = await seedOldSchema();
    const [a, b] = await Promise.all([create(), create()]);
    expect(a.instanceId).toBe(b.instanceId);
    expect(await a.get(op.key)).toEqual(op);
    expect((await b.findAction("old-action"))?.actions[0].signedTransaction).toBe("exact-bytes");
    expect(await b.findApproval(op.request.signedTransaction)).toEqual(op);
    expect(await a.expiration("old-action")).toBe(8000);
    expect(await a.deadlines(op.key)).toEqual({ businessDeadline: 481000, forceReclaimAt: 604000 });
    expect((await pool.query("SELECT checked FROM sponsoring_operations")).rows[0].checked).toBe("9000");
    expect((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename")).rows.map(row => row.tablename))
      .toEqual(["sponsoring_actions", "sponsoring_expirations", "sponsoring_operations"]);
    await a.save({ ...op, status: "recovered" });
    expect(await b.listRecoverable(100)).toEqual([]);
  });

  it("refuses migration while an old owner worker holds its execution lock", async () => {
    await seedOldSchema();
    const held = await pool.connect();
    const hash = createHash("sha256").update(JSON.stringify(["tron:3448148188", binding.owner])).digest("hex");
    const lock = BigInt.asIntN(64, BigInt("0x" + hash.slice(0, 16))).toString();
    try {
      await held.query("SELECT pg_advisory_lock($1::bigint)", [lock]);
      await expect(create()).rejects.toThrow("sponsor_migration_owner_busy");
      expect((await pool.query("SELECT pool FROM sponsoring_operations")).rows[0].pool).toBe("old-pool");
      expect((await pool.query("SELECT count(*) FROM sponsoring_pools")).rows[0].count).toBe("1");
    } finally { await held.query("SELECT pg_advisory_unlock($1::bigint)", [lock]); held.release(); }
    expect((await (await create()).listRecoverable(100))).toHaveLength(1);
  });

  it("migrates all stored networks, even if only one is configured at first startup", async () => {
    await seedOldSchema();
    await pool.query("INSERT INTO sponsoring_pools VALUES($1,$2,$3,$4,$5)",
      ["old-shasta", "tron:2494104990", binding.owner, 2, serialize(limits)]);
    await pool.query("INSERT INTO sponsoring_expirations VALUES('old-shasta','old-action',12000)");
    const nile = await create();
    const shasta = await PostgresSponsoringCoordinator.create(pool, { ...binding, network: "tron:2494104990" }, limits);
    expect(await nile.expiration("old-action")).toBe(8000);
    expect(await shasta.expiration("old-action")).toBe(12000);
    expect(await shasta.listRecoverable(100)).toEqual([]);
  });

  it("rolls back pool remapping when unexpected dependencies prevent dropping the old pool table", async () => {
    const op = await seedOldSchema();
    await pool.query("CREATE TABLE external_reference (pool text REFERENCES sponsoring_pools(id))");
    await expect(create()).rejects.toThrow(/depend/);
    expect((await pool.query("SELECT pool FROM sponsoring_operations WHERE key=$1", [op.key])).rows[0].pool).toBe("old-pool");
    expect((await pool.query("SELECT pool FROM sponsoring_actions")).rows[0].pool).toBe("old-pool");
    expect((await pool.query("SELECT version FROM sponsoring_version")).rows[0].version).toBe(1);
    await pool.query("DROP TABLE external_reference");
    expect(await (await create()).get(op.key)).toEqual(op);
  });

  it("refuses an unknown old schema version before changing recovery records", async () => {
    await seedOldSchema();
    await pool.query("UPDATE sponsoring_version SET version=999");
    await expect(create()).rejects.toThrow("sponsor_database_version_unsupported");
    expect((await pool.query("SELECT pool FROM sponsoring_operations")).rows[0].pool).toBe("old-pool");
  });

  it("refuses duplicate canonical owners instead of merging their recovery ledgers", async () => {
    await seedOldSchema();
    await pool.query("INSERT INTO sponsoring_pools VALUES($1,$2,$3,$4,$5)",
      ["duplicate", "tron:0xcd8690dc", binding.owner, 2, serialize(limits)]);
    await expect(create()).rejects.toThrow("sponsor_migration_duplicate_owner");
    expect((await pool.query("SELECT pool FROM sponsoring_operations")).rows[0].pool).toBe("old-pool");
    expect((await pool.query("SELECT count(*) FROM sponsoring_pools")).rows[0].count).toBe("2");
  });

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

  it("detects corrupt payloads", async () => {
    const a = await create();
    await a.admit(operation());
    await pool.query("UPDATE sponsoring_operations SET payload=$1 WHERE pool=$2", [Buffer.from("corrupt"), a.instanceId]);
    await expect(a.get(operation().key)).rejects.toThrow("sponsor_database_corrupt");
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

  it("reuses records but refuses conflicting identity and cross-owner adoption", async () => {
    const a = await create(), b = await create();
    expect(a.instanceId).toBe(b.instanceId);
    await a.admit(operation());
    expect((await b.admit(operation())).kind).toBe("existing");
    expect((await b.admit({ ...operation(), requestDigest: "changed" })).kind).toBe("conflict");
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
