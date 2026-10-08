import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import { capacityDenial, validateSave } from "./operation-validation.js";
import type { SponsoringCoordinator, OwnerBinding, CapacityLimits } from "./coordinator.js";
export type { OwnerBinding, CapacityLimits } from "./coordinator.js";
import type { Trc20SponsoringCoordinator, Trc20SponsoringOperation } from "@bankofai/x402-tron";
type Trc20SponsoringAdmission = Awaited<ReturnType<Trc20SponsoringCoordinator["admit"]>>;

type Row = { payload: Uint8Array; checksum: string };
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** One process and one owner per durable store. The separate SQLite transaction
 * holds an OS-backed writer lock that is released automatically after SIGKILL. */
export class SqliteSponsoringCoordinator implements SponsoringCoordinator {
  private db!: DatabaseSync;
  private writer: DatabaseSync;
  private tails = new Map<string, Promise<void>>();
  readonly instanceId: string;

  constructor(file: string, readonly binding: OwnerBinding, private limits: CapacityLimits) {
    const path = resolve(file);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.writer = new DatabaseSync(`${path}.writer`);
    try {
      chmodSync(`${path}.writer`, 0o600);
      this.writer.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch (error) { this.writer.close(); throw error; }
    try {
      this.db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error("sponsor_database_version_unsupported");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), instance TEXT NOT NULL, binding TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (
          key TEXT PRIMARY KEY, payer TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
          payload BLOB NOT NULL, checksum TEXT NOT NULL, created INTEGER NOT NULL,
          first_delegate INTEGER, checked INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS recovery ON operations(status, checked);
        CREATE TABLE IF NOT EXISTS expirations (txid TEXT PRIMARY KEY, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS action_history (
          txid TEXT PRIMARY KEY, operation_key TEXT NOT NULL REFERENCES operations(key),
          kind TEXT NOT NULL, resource TEXT, signed_transaction TEXT NOT NULL
        );
        PRAGMA user_version=1;
      `);
      if (this.db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("sponsor_database_corrupt");
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES(1, ?, ?)").run(randomUUID(), JSON.stringify(binding));
      const meta = this.db.prepare("SELECT instance, binding FROM metadata WHERE id=1").get()!;
      if (meta.binding !== JSON.stringify(binding)) throw new Error("sponsor_instance_binding_invalid");
      this.instanceId = String(meta.instance);
    } catch (error) { this.db?.close(); this.writer.close(); throw error; }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private decode(row: Row): Trc20SponsoringOperation {
    if (digest(row.payload) !== row.checksum) throw new Error("sponsor_database_corrupt");
    const operation = deserialize(row.payload) as Trc20SponsoringOperation;
    if (operation.network !== this.binding.network || !Number.isSafeInteger(operation.revision) ||
        !Array.isArray(operation.actions) || !Array.isArray(operation.plan?.legs) ||
        typeof operation.budgetUnits !== "bigint") throw new Error("sponsor_database_corrupt");
    return operation;
  }

  private read(key: string): Trc20SponsoringOperation | undefined {
    const row = this.db.prepare("SELECT payload, checksum FROM operations WHERE key=?").get(key);
    return row ? this.decode(row as unknown as Row) : undefined;
  }

  async get(key: string): Promise<Trc20SponsoringOperation | undefined> { return this.read(key); }

  private active(): Trc20SponsoringOperation[] {
    return this.db.prepare("SELECT payload, checksum FROM operations WHERE status != 'recovered' ORDER BY checked, created")
      .all().map(row => this.decode(row as unknown as Row));
  }

  async admit(operation: Trc20SponsoringOperation): Promise<Trc20SponsoringAdmission> {
    return this.transaction(() => {
      if (operation.network !== this.binding.network) throw new Error("sponsor_operation_owner_mismatch");
      const previous = this.read(operation.key);
      if (previous) return previous.requestDigest === operation.requestDigest
        ? { kind: "existing", operation: previous } : { kind: "conflict", reason: "approval_transaction_reused" };
      const active = this.active();
      const reason = capacityDenial(active, operation, this.limits);
      if (reason) return { kind: "denied", reason };
      const bytes = serialize(operation);
      this.db.prepare("INSERT INTO operations(key,payer,status,revision,payload,checksum,created) VALUES(?,?,?,?,?,?,?)")
        .run(operation.key, operation.payer, operation.status, operation.revision, bytes, digest(bytes), operation.createdAtMs);
      this.archiveActions(operation);
      return { kind: "created", operation: structuredClone(operation) };
    });
  }

  async save(operation: Trc20SponsoringOperation): Promise<Trc20SponsoringOperation> {
    return this.transaction(() => {
      const current = this.read(operation.key);
      validateSave(current, operation);
      const next = { ...operation, revision: operation.revision + 1 };
      const bytes = serialize(next);
      this.archiveActions(next);
      this.db.prepare("UPDATE operations SET status=?,revision=?,payload=?,checksum=? WHERE key=?")
        .run(next.status, next.revision, bytes, digest(bytes), next.key);
      return structuredClone(next);
    });
  }

  private archiveActions(operation: Trc20SponsoringOperation): void {
    for (const action of operation.actions) {
      const previous = this.db.prepare("SELECT * FROM action_history WHERE txid=?").get(action.txID);
      if (previous && (previous.operation_key !== operation.key || previous.kind !== action.kind ||
          previous.resource !== (action.resource ?? null) || previous.signed_transaction !== action.signedTransaction))
        throw new Error("sponsor_immutable_action_changed");
      this.db.prepare("INSERT OR IGNORE INTO action_history VALUES(?,?,?,?,?)")
        .run(action.txID, operation.key, action.kind, action.resource ?? null, action.signedTransaction);
    }
  }

  async markRecovered(operation: Trc20SponsoringOperation): Promise<Trc20SponsoringOperation> {
    return this.save({ ...operation, status: "recovered" });
  }

  async listRecoverable(limit: number): Promise<readonly Trc20SponsoringOperation[]> {
    return this.active().slice(0, Math.max(0, limit));
  }

  /** Rotation prevents one permanently failing operation starving later jobs. */
  checked(key: string): void { this.db.prepare("UPDATE operations SET checked=? WHERE key=?").run(Date.now(), key); }

  noteDelegate(key: string, now: number): void {
    if (!this.read(key)) throw new Error("sponsor_operation_missing");
    this.db.prepare("UPDATE operations SET first_delegate=COALESCE(first_delegate,?) WHERE key=?").run(now, key);
  }

  deadlines(key: string): { businessDeadline: number; forceReclaimAt?: number } {
    const row = this.db.prepare("SELECT created,first_delegate FROM operations WHERE key=?").get(key);
    if (!row) throw new Error("sponsor_operation_missing");
    return { businessDeadline: Number(row.created) + 480_000,
      ...(row.first_delegate == null ? {} : { forceReclaimAt: Number(row.first_delegate) + 600_000 }) };
  }

  async findAction(txID: string): Promise<Trc20SponsoringOperation | undefined> {
    return this.active().find(op => op.approvalTxID === txID || op.actions.some(action => action.txID === txID));
  }

  async findApproval(bytes: string): Promise<Trc20SponsoringOperation | undefined> {
    return this.active().find(op => op.request.signedTransaction === bytes);
  }

  rememberExpiration(txID: string, expiration: number): void {
    this.db.prepare("INSERT INTO expirations VALUES(?,?) ON CONFLICT(txid) DO NOTHING").run(txID.toLowerCase(), expiration);
  }

  expiration(txID: string): number | undefined {
    const row = this.db.prepare("SELECT expires FROM expirations WHERE txid=?").get(txID.toLowerCase());
    return row ? Number(row.expires) : undefined;
  }

  async runExclusive<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(scope) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => pending);
    this.tails.set(scope, tail);
    await previous;
    try { return await work(); }
    finally { release(); if (this.tails.get(scope) === tail) this.tails.delete(scope); }
  }

  async assertOwnership(): Promise<void> { /* The process holds the SQLite writer lock. */ }
  close(): void { this.db.close(); this.writer.close(); }
}
