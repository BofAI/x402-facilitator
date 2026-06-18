/**
 * Database access layer (drizzle + node-postgres).
 *
 * v2 query surface:
 *   - getAllApiKeys / getApiKeyByKey          (auth cache, shared api_keys_plus)
 *   - saveSettlement                          (one row per settle attempt)
 *   - getSettlementsByTxHash                  (GET /payments/tx/:hash)
 *   - getSettlementsByAuthorization           (GET /payments?network=&nonce=...)
 *   - getSettlementsBySeller                  (GET /payments seller feed)
 *
 * On init the `settlements` table is ensured (CREATE TABLE IF NOT EXISTS); v1's
 * `payment_records` is neither created nor touched. `sellers` / `api_keys_plus`
 * are shared and only ensured for local-dev convenience.
 */
import { Pool } from "pg";
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { apiKeys, settlements, sellers, type ApiKeyRow, type Settlement } from "./schema.js";
import { logger } from "../logger.js";

export type { Settlement, ApiKeyRow } from "./schema.js";

export interface DbInitOptions {
  url: string;
  poolSize: number;
  maxOverflow: number;
  maxLifeTime: number;
  sslMode: string;
}

let pool: Pool | null = null;
let db: NodePgDatabase | null = null;

/**
 * Ensure the facilitator-owned `settlements` table and the shared auth tables.
 * The partial unique index enforces "an authorization settles at most once
 * successfully" — the facilitator-side dedup complementing on-chain nonce burn.
 */
const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS sellers (
  id BIGSERIAL PRIMARY KEY,
  seller_id VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_keys_plus (
  id BIGSERIAL PRIMARY KEY,
  seller_id VARCHAR(64) NOT NULL,
  wallet_address VARCHAR(128) NOT NULL,
  name VARCHAR(64) NOT NULL DEFAULT 'default',
  key VARCHAR(64) NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_api_keys_plus_seller_id ON api_keys_plus (seller_id);
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
  pool = new Pool({
    connectionString: opts.url,
    max: opts.poolSize + opts.maxOverflow,
    idleTimeoutMillis: opts.maxLifeTime * 1000,
    ssl: sslFor(opts.sslMode),
  });
  db = drizzle(pool);
  await pool.query(CREATE_TABLES_SQL);
  logger.info("Database initialized");
}

/** Close the pool and release all connections. */
export async function disposeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

function getDb(): NodePgDatabase {
  if (!db) throw new Error("Database not initialized. Call initDatabase first.");
  return db;
}

/** All active API key strings (for the in-memory auth cache). */
export async function getAllApiKeys(): Promise<string[]> {
  const rows = await getDb()
    .select({ key: apiKeys.key })
    .from(apiKeys)
    .where(eq(apiKeys.isActive, true));
  return rows.map((r) => r.key);
}

/** A single active API key row by plaintext key, or null. */
export async function getApiKeyByKey(key: string): Promise<ApiKeyRow | null> {
  const rows = await getDb()
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.key, key), eq(apiKeys.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
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
