/**
 * Database access layer (drizzle + node-postgres).
 *
 * v2 query surface:
 *   - getActiveApiKeyAuth                      (auth+seller cache, shared api_keys_plus)
 *   - saveSettlement                          (one row per settle attempt)
 *   - getSettlementsByTxHash                  (GET /payments/tx/:hash)
 *   - getSettlementsByAuthorization           (GET /payments?network=&nonce=...)
 *   - getSettlementsBySeller                  (GET /payments seller feed)
 *
 * Startup ensures the settlements schema. DevCenter owns the API key table.
 */
import { Pool } from "pg";
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { apiKeys, settlements, type Settlement } from "./schema.js";
import { logger } from "../logger.js";

export type { Settlement } from "./schema.js";

export interface DbInitOptions {
  url: string;
  poolSize: number;
  maxOverflow: number;
  maxLifeTime: number;
  sslMode: string;
  apiKeyDatabase: { url: string; sslMode: "disable" | "verify-full" };
}

let pool: Pool | null = null;
let permit2LockPool: Pool | null = null;
let db: NodePgDatabase | null = null;
let apiKeyPool: Pool | null = null;
let apiKeyDb: NodePgDatabase | null = null;

/** Facilitator-owned schema, including deduplication of successful settlements. */
export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS settlements (
  id BIGSERIAL PRIMARY KEY,
  seller_id VARCHAR(64),
  network VARCHAR(32) NOT NULL,
  scheme VARCHAR(32) NOT NULL,
  asset VARCHAR(128),
  payer VARCHAR(128),
  nonce VARCHAR(80),
  amount VARCHAR(80),
  tx_hash VARCHAR(128),
  status VARCHAR(32) NOT NULL,
  error_reason VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_settlements_seller_created ON settlements (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_settlements_tx_hash ON settlements (tx_hash);
CREATE INDEX IF NOT EXISTS ix_settlements_authorization ON settlements (network, nonce);
CREATE UNIQUE INDEX IF NOT EXISTS uq_settlements_auth_success
  ON settlements (network, asset, payer, nonce) WHERE status = 'success';
`;

function sslFor(sslMode: string): false | { rejectUnauthorized: boolean } {
  if (sslMode.trim().toLowerCase() === "disable") return false;
  return { rejectUnauthorized: sslMode.trim().toLowerCase().startsWith("verify") };
}

/** Initialize the connection pool and ensure tables. */
export async function initDatabase(opts: DbInitOptions): Promise<void> {
  const poolOptions = {
    connectionString: opts.url,
    max: opts.poolSize + opts.maxOverflow,
    // v1's max_life_time is the connection *lifetime* (SQLAlchemy pool_recycle), not
    // an idle timeout — map it to pg's maxLifetimeSeconds so long-lived connections
    // are recycled. pg has no test-on-borrow (v1 pool_pre_ping), but recycling plus a
    // bounded connect timeout lets requests fail fast over stale connections.
    maxLifetimeSeconds: opts.maxLifeTime,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: sslFor(opts.sslMode),
  };
  pool = new Pool(poolOptions);
  // SDK settlement may borrow the business pool for sponsoring. Advisory locks
  // use a separate lazy pool so a pool size of one cannot deadlock itself.
  permit2LockPool = new Pool(poolOptions);
  try {
    await pool.query(CREATE_TABLES_SQL);
    apiKeyPool = new Pool({
      connectionString: opts.apiKeyDatabase.url,
      ssl: sslFor(opts.apiKeyDatabase.sslMode),
      max: 1,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      query_timeout: 6_000,
      options: "-c default_transaction_read_only=on",
    });
    apiKeyPool.on("error", () => logger.error("Idle API key database connection failed"));
    apiKeyDb = drizzle(apiKeyPool);
    db = drizzle(pool);
  } catch (error) {
    try { await disposeDatabase(); }
    catch (cleanupError) { logger.error("Database initialization cleanup failed", { err: String(cleanupError) }); }
    throw error;
  }
  logger.info("Database initialized");
}

/** Close the pool and release all connections. */
export async function disposeDatabase(): Promise<void> {
  const pools = [pool, permit2LockPool, apiKeyPool];
  pool = null;
  permit2LockPool = null;
  db = null;
  apiKeyPool = null;
  apiKeyDb = null;
  const results = await Promise.allSettled(pools.filter((pool): pool is Pool => pool !== null).map(pool => pool.end()));
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

function getDb(): NodePgDatabase {
  if (!db) throw new Error("Database not initialized. Call initDatabase first.");
  return db;
}

/** Borrow the initialized pool. Its lifecycle remains owned by this module. */
export function getDatabasePool(): Pool {
  if (!pool || !db) throw new Error("Database not initialized. Call initDatabase first.");
  return pool;
}

/** Session locks must not occupy connections required by SDK sponsorship work. */
export function getPermit2LockPool(): Pool {
  if (!permit2LockPool || !db) throw new Error("Database not initialized. Call initDatabase first.");
  return permit2LockPool;
}

/** Active API keys with their seller id (for the in-memory auth + seller cache). */
export async function getActiveApiKeyAuth(): Promise<{ key: string; sellerId: string }[]> {
  if (!apiKeyDb) throw new Error("API key database not initialized. Call initDatabase first.");
  return apiKeyDb
    .select({ key: apiKeys.key, sellerId: apiKeys.sellerId })
    .from(apiKeys)
    .where(eq(apiKeys.isActive, true));
}

export interface SettlementInput {
  sellerId: string | null;
  network: string;
  scheme: string;
  asset: string | null;
  payer: string | null;
  nonce: string | null;
  amount: string | null;
  txHash: string | null;
  status: string;
  errorReason: string | null;
}

/** Insert one settlement row and return it. */
export async function saveSettlement(input: SettlementInput): Promise<Settlement> {
  const rows = await getDb().insert(settlements).values(input).returning();
  return rows[0];
}

/** Settlements matching a tx hash (id DESC), optionally seller-scoped. */
export async function getSettlementsByTxHash(
  txHash: string,
  sellerId?: string | null,
): Promise<Settlement[]> {
  const where = sellerId
    ? and(eq(settlements.txHash, txHash), eq(settlements.sellerId, sellerId))
    : eq(settlements.txHash, txHash);
  return getDb().select().from(settlements).where(where).orderBy(desc(settlements.id));
}

export interface AuthorizationQuery {
  network: string;
  nonce: string;
  asset?: string | null;
  payer?: string | null;
  sellerId?: string | null;
}

/** Settlements matching an authorization identity (id DESC), optionally narrowed. */
export async function getSettlementsByAuthorization(q: AuthorizationQuery): Promise<Settlement[]> {
  const filters = [eq(settlements.network, q.network), eq(settlements.nonce, q.nonce)];
  if (q.asset) filters.push(eq(settlements.asset, q.asset));
  if (q.payer) filters.push(eq(settlements.payer, q.payer));
  if (q.sellerId) filters.push(eq(settlements.sellerId, q.sellerId));
  return getDb()
    .select()
    .from(settlements)
    .where(and(...filters))
    .orderBy(desc(settlements.id));
}

/** A seller's settlement feed (latest first), paginated. */
export async function getSettlementsBySeller(
  sellerId: string,
  limit: number,
  offset: number,
): Promise<Settlement[]> {
  return getDb()
    .select()
    .from(settlements)
    .where(eq(settlements.sellerId, sellerId))
    .orderBy(desc(settlements.id))
    .limit(limit)
    .offset(offset);
}
