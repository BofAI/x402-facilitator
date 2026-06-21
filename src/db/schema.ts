/**
 * Drizzle schema for the facilitator's Postgres tables.
 *
 * v2 introduces a NEW table `settlements` (it does not reuse v1's `payment_records`).
 * The row is keyed on the on-chain authorization identity (network, scheme, asset,
 * payer, nonce) rather than a client-supplied payment id. v1's `payment_records`
 * is left untouched (read-only legacy / discarded).
 *
 * `sellers` and `api_keys_plus` are SHARED tables (managed by external seller
 * registration), reused unchanged for auth + seller scoping.
 */
import { bigserial, boolean, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const settlements = pgTable("settlements", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** Seller resolved from the request API key (soft FK to sellers.seller_id). */
  sellerId: varchar("seller_id", { length: 64 }),
  network: varchar("network", { length: 32 }).notNull(),
  scheme: varchar("scheme", { length: 32 }).notNull(),
  /** Token contract (TRC-20 / ERC-20). Part of the on-chain authorization identity. */
  asset: varchar("asset", { length: 128 }),
  /** Paying address (EIP-3009 `from` / Permit2 `from` / GasFree `user`). */
  payer: varchar("payer", { length: 128 }),
  /** Authorization nonce — the on-chain 1:1 anchor. */
  nonce: varchar("nonce", { length: 80 }),
  /** Actual settled amount in atomic units (SettleResponse.amount), when present. */
  amount: varchar("amount", { length: 80 }),
  /** Settlement tx hash; null on a failed settle. */
  txHash: varchar("tx_hash", { length: 128 }),
  status: varchar("status", { length: 32 }).notNull(),
  /** Failure reason from SettleResponse.errorReason, for ops/debugging. */
  errorReason: varchar("error_reason", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys_plus", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sellerId: varchar("seller_id", { length: 64 }).notNull(),
  walletAddress: varchar("wallet_address", { length: 128 }).notNull(),
  name: varchar("name", { length: 64 }).notNull().default("default"),
  key: varchar("key", { length: 64 }).notNull().unique(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sellers = pgTable("sellers", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sellerId: varchar("seller_id", { length: 64 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Settlement = typeof settlements.$inferSelect;
