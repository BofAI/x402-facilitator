import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { normalizeTronNetwork, type Trc20SponsoringOperation } from "@bankofai/x402-tron";
import { TronWeb } from "tronweb";
import type { SponsoringCoordinator, OwnerBinding, CapacityLimits } from "./coordinator.js";
import { capacityDenial, validateSave } from "./operation-validation.js";

type Operation = Trc20SponsoringOperation;
type Context = { client: PoolClient; valid: boolean; tail: Promise<unknown> };
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const lockKey = (value: string) => BigInt.asIntN(64, BigInt(`0x${digest(value).slice(0, 16)}`)).toString();
function normalize(binding: OwnerBinding): OwnerBinding {
  return { network: normalizeTronNetwork(binding.network),
    owner: TronWeb.isAddress(binding.owner) ? TronWeb.address.toHex(binding.owner).toLowerCase() : binding.owner,
    permissionId: binding.permissionId };
}

/** Caller owns the pool. Each execution holds a dedicated session advisory lock;
 * transaction locks alone cannot protect suspended RPC work between mutations. */
export class PostgresSponsoringCoordinator implements SponsoringCoordinator {
  private readonly context = new AsyncLocalStorage<Context>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(private readonly pool: Pool, readonly binding: OwnerBinding,
    private readonly limits: CapacityLimits, readonly instanceId: string, private readonly ownerLock: string) {}

  static async create(pool: Pool, binding: OwnerBinding, limits: CapacityLimits): Promise<PostgresSponsoringCoordinator> {
    binding = normalize(binding);
    if (!Number.isSafeInteger(binding.permissionId) || binding.permissionId < 0 ||
        Object.values(limits).some(value => typeof value !== "bigint" || value < 0n)) throw new Error("sponsor_instance_binding_invalid");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize boot DDL across processes, including the first schema creation.
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [lockKey("x402:sponsoring:schema:v1")]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS sponsoring_version (id integer PRIMARY KEY CHECK(id=1), version integer NOT NULL);
        INSERT INTO sponsoring_version VALUES(1,1) ON CONFLICT DO NOTHING;
      `);
      const version = await client.query("SELECT version FROM sponsoring_version WHERE id=1");
      if (version.rows[0].version !== 1) throw new Error("sponsor_database_version_unsupported");
      await client.query(`
        CREATE TABLE IF NOT EXISTS sponsoring_pools (
          id text PRIMARY KEY, network text NOT NULL, owner text NOT NULL, permission integer NOT NULL,
          limits bytea NOT NULL, UNIQUE(network,owner));
        CREATE TABLE IF NOT EXISTS sponsoring_operations (
          key text PRIMARY KEY, pool text NOT NULL REFERENCES sponsoring_pools(id),
          network text NOT NULL, approval text NOT NULL, payer text NOT NULL, status text NOT NULL,
          revision integer NOT NULL, payload bytea NOT NULL, checksum text NOT NULL,
          created bigint NOT NULL, first_delegate bigint, checked bigint NOT NULL DEFAULT 0,
          approval_bytes text, approval_hash text, UNIQUE(network,approval));
        CREATE INDEX IF NOT EXISTS sponsoring_recovery ON sponsoring_operations(pool,status,checked,created);
        CREATE INDEX IF NOT EXISTS sponsoring_approval_bytes ON sponsoring_operations(pool,approval_hash);
        CREATE TABLE IF NOT EXISTS sponsoring_actions (
          pool text NOT NULL REFERENCES sponsoring_pools(id), txid text NOT NULL,
          operation_key text NOT NULL REFERENCES sponsoring_operations(key), kind text NOT NULL,
          resource text, signed_transaction text NOT NULL, PRIMARY KEY(pool,txid));
        CREATE TABLE IF NOT EXISTS sponsoring_expirations (
          pool text NOT NULL REFERENCES sponsoring_pools(id), txid text NOT NULL, expires bigint NOT NULL,
          PRIMARY KEY(pool,txid));
      `);
      await client.query("INSERT INTO sponsoring_pools VALUES($1,$2,$3,$4,$5) ON CONFLICT(network,owner) DO NOTHING",
        [randomUUID(), binding.network, binding.owner, binding.permissionId, serialize(limits)]);
      const result = await client.query("SELECT * FROM sponsoring_pools WHERE network=$1 AND owner=$2", [binding.network, binding.owner]);
      const row = result.rows[0];
      if (row.permission !== binding.permissionId || !isDeepStrictEqual(deserialize(row.limits), limits))
        throw new Error("sponsor_instance_binding_invalid");
      await client.query("COMMIT");
      return new PostgresSponsoringCoordinator(pool, Object.freeze({ ...binding }), Object.freeze({ ...limits }), row.id,
        lockKey(JSON.stringify([binding.network, binding.owner])));
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private requireValid(context: Context): void {
    if (!context.valid || this.closed) throw new Error("sponsor_ownership_lost");
  }

  async runExclusive<T>(_scope: string, work: () => Promise<T>): Promise<T> {
    const nested = this.context.getStore();
    if (nested) { this.requireValid(nested); return work(); }
    if (this.closed) throw new Error("sponsor_coordinator_closed");
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    let client: PoolClient | undefined;
    try {
      if (this.closed) throw new Error("sponsor_coordinator_closed");
      client = await this.pool.connect();
      const held = client;
      const context: Context = { client, valid: true, tail: Promise.resolve() };
      const invalidate = () => { context.valid = false; };
      client.on("error", invalidate); client.on("end", invalidate);
      let locked = false;
      let destroy = false;
      try {
        const result = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [this.ownerLock]);
        locked = result.rows[0].locked;
        if (!locked) throw new Error("sponsor_owner_busy");
        return await this.context.run(context, work);
      } finally {
        destroy = !context.valid;
        context.valid = false;
        // Drain already queued work before returning a connection to its caller.
        await context.tail.catch(() => {});
        if (locked && !destroy) {
          try { await held.query("SELECT pg_advisory_unlock($1::bigint)", [this.ownerLock]); }
          catch { destroy = true; }
        }
        held.removeListener("error", invalidate); held.removeListener("end", invalidate);
        held.release(destroy); client = undefined;
      }
    } finally { client?.release(true); release(); }
  }

  private async serial<T>(context: Context, work: () => Promise<T>): Promise<T> {
    this.requireValid(context);
    const result = context.tail.then(async () => { this.requireValid(context); return work(); });
    context.tail = result.catch(() => {});
    return result;
  }

  async assertOwnership(): Promise<void> {
    const context = this.context.getStore();
    if (!context) throw new Error("sponsor_ownership_required");
    await this.serial(context, async () => {
      try { await context.client.query("SELECT 1"); this.requireValid(context); }
      catch { context.valid = false; throw new Error("sponsor_ownership_lost"); }
    });
  }

  private async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    const context = this.context.getStore();
    if (context) return this.serial(context, async () => {
      const result = await context.client.query<T>(sql, values);
      this.requireValid(context);
      return result.rows;
    });
    if (this.closed) throw new Error("sponsor_coordinator_closed");
    return (await this.pool.query<T>(sql, values)).rows;
  }

  private async mutate<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const context = this.context.getStore();
    if (!context) return this.runExclusive("owner", () => this.mutate(work));
    return this.serial(context, async () => {
      const client = context.client;
      await client.query("BEGIN");
      try { const value = await work(client); this.requireValid(context); await client.query("COMMIT"); return value; }
      catch (error) {
        try { await client.query("ROLLBACK"); } catch { context.valid = false; }
        throw error;
      }
    });
  }

  private decode(row: QueryResultRow): Operation {
    if (digest(row.payload) !== row.checksum) throw new Error("sponsor_database_corrupt");
    const op = deserialize(row.payload) as Operation;
    if (normalizeTronNetwork(op.network) !== this.binding.network || !Number.isSafeInteger(op.revision) ||
        !Array.isArray(op.actions) || !Array.isArray(op.plan?.legs) || typeof op.budgetUnits !== "bigint")
      throw new Error("sponsor_database_corrupt");
    return op;
  }
  async get(key: string): Promise<Operation | undefined> {
    const rows = await this.query("SELECT payload,checksum FROM sponsoring_operations WHERE pool=$1 AND key=$2", [this.instanceId, key]);
    return rows[0] ? this.decode(rows[0]) : undefined;
  }
  async admit(operation: Operation): ReturnType<SponsoringCoordinator["admit"]> {
    return this.mutate(async client => {
      if (normalizeTronNetwork(operation.network) !== this.binding.network) throw new Error("sponsor_operation_owner_mismatch");
      const previous = await client.query("SELECT * FROM sponsoring_operations WHERE key=$1 OR (network=$2 AND approval=$3)",
        [operation.key, this.binding.network, operation.approvalTxID]);
      if (previous.rows.length) {
        const row = previous.rows[0];
        if (row.pool !== this.instanceId) return { kind: "conflict", reason: "approval_transaction_reused" };
        const op = this.decode(row);
        return op.key === operation.key && op.requestDigest === operation.requestDigest
          ? { kind: "existing", operation: op } : { kind: "conflict", reason: "approval_transaction_reused" };
      }
      const active = await client.query("SELECT payload,checksum FROM sponsoring_operations WHERE pool=$1 AND status!='recovered'", [this.instanceId]);
      const reason = capacityDenial(active.rows.map(row => this.decode(row)), operation, this.limits);
      if (reason) return { kind: "denied", reason };
      const bytes = serialize(operation);
      const inserted = await client.query(`INSERT INTO sponsoring_operations
        (key,pool,network,approval,payer,status,revision,payload,checksum,created,approval_bytes,approval_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING key`,
      [operation.key, this.instanceId, this.binding.network, operation.approvalTxID, operation.payer,
        operation.status, operation.revision, bytes, digest(bytes), operation.createdAtMs, operation.request.signedTransaction,
        operation.request.signedTransaction === undefined ? null : digest(operation.request.signedTransaction)]);
      if (!inserted.rowCount) return { kind: "conflict", reason: "approval_transaction_reused" };
      await this.archive(client, operation);
      return { kind: "created", operation: structuredClone(operation) };
    });
  }
  private async archive(client: PoolClient, op: Operation): Promise<void> {
    for (const action of op.actions) {
      const previous = await client.query("SELECT * FROM sponsoring_actions WHERE pool=$1 AND txid=$2", [this.instanceId, action.txID]);
      const row = previous.rows[0];
      if (row && (row.operation_key !== op.key || row.kind !== action.kind || row.resource !== (action.resource ?? null) || row.signed_transaction !== action.signedTransaction))
        throw new Error("sponsor_immutable_action_changed");
      await client.query("INSERT INTO sponsoring_actions VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [this.instanceId, action.txID, op.key, action.kind, action.resource ?? null, action.signedTransaction]);
    }
  }
  async save(operation: Operation): Promise<Operation> {
    return this.mutate(async client => {
      const rows = await client.query("SELECT payload,checksum FROM sponsoring_operations WHERE pool=$1 AND key=$2", [this.instanceId, operation.key]);
      validateSave(rows.rows[0] ? this.decode(rows.rows[0]) : undefined, operation);
      const next = { ...operation, revision: operation.revision + 1 };
      await this.archive(client, next);
      const bytes = serialize(next);
      await client.query("UPDATE sponsoring_operations SET status=$1,revision=$2,payload=$3,checksum=$4 WHERE pool=$5 AND key=$6",
        [next.status, next.revision, bytes, digest(bytes), this.instanceId, next.key]);
      return structuredClone(next);
    });
  }
  async markRecovered(operation: Operation): Promise<Operation> { return this.save({ ...operation, status: "recovered" }); }
  async listRecoverable(limit: number): Promise<readonly Operation[]> {
    if (!Number.isSafeInteger(limit)) throw new Error("sponsor_invalid_limit");
    return (await this.query("SELECT payload,checksum FROM sponsoring_operations WHERE pool=$1 AND status!='recovered' ORDER BY checked,created LIMIT $2",
      [this.instanceId, Math.max(0, limit)])).map(row => this.decode(row));
  }
  async checked(key: string): Promise<void> {
    await this.mutate(async client => { await client.query("UPDATE sponsoring_operations SET checked=$1 WHERE pool=$2 AND key=$3", [Date.now(), this.instanceId, key]); });
  }
  async noteDelegate(key: string, now: number): Promise<void> {
    await this.mutate(async client => {
      const result = await client.query("UPDATE sponsoring_operations SET first_delegate=COALESCE(first_delegate,$1) WHERE pool=$2 AND key=$3", [now, this.instanceId, key]);
      if (!result.rowCount) throw new Error("sponsor_operation_missing");
    });
  }
  async deadlines(key: string): Promise<{ businessDeadline: number; forceReclaimAt?: number }> {
    const [row] = await this.query("SELECT created,first_delegate FROM sponsoring_operations WHERE pool=$1 AND key=$2", [this.instanceId, key]);
    if (!row) throw new Error("sponsor_operation_missing");
    return { businessDeadline: Number(row.created) + 480_000, ...(row.first_delegate == null ? {} : { forceReclaimAt: Number(row.first_delegate) + 600_000 }) };
  }
  async findAction(txID: string): Promise<Operation | undefined> {
    const [row] = await this.query(`
      SELECT payload,checksum FROM sponsoring_operations
        WHERE pool=$1 AND network=$3 AND approval=$2 AND status!='recovered'
      UNION ALL
      SELECT o.payload,o.checksum FROM sponsoring_actions a JOIN sponsoring_operations o ON o.key=a.operation_key
        WHERE a.pool=$1 AND a.txid=$2 AND o.pool=$1 AND o.status!='recovered'
      LIMIT 1`, [this.instanceId, txID, this.binding.network]);
    return row ? this.decode(row) : undefined;
  }
  async findApproval(bytes: string): Promise<Operation | undefined> {
    const [row] = await this.query("SELECT payload,checksum FROM sponsoring_operations WHERE pool=$1 AND approval_hash=$2 AND approval_bytes=$3 AND status!='recovered' LIMIT 1", [this.instanceId, digest(bytes), bytes]);
    return row ? this.decode(row) : undefined;
  }
  async rememberExpiration(txID: string, expiration: number): Promise<void> {
    await this.mutate(async client => { await client.query("INSERT INTO sponsoring_expirations VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [this.instanceId, txID.toLowerCase(), expiration]); });
  }
  async expiration(txID: string): Promise<number | undefined> {
    const [row] = await this.query("SELECT expires FROM sponsoring_expirations WHERE pool=$1 AND txid=$2", [this.instanceId, txID.toLowerCase()]);
    return row ? Number(row.expires) : undefined;
  }
  /** Stop new work and drain this coordinator's executions only. Called inside
   * its own callback, close cannot await itself: that callback's finally releases
   * the session. Pool owners should close from outside before ending the pool. */
  async close(): Promise<void> {
    this.closed = true;
    if (!this.context.getStore()) await this.tail;
  }
}
