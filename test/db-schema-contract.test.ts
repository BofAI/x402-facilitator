/**
 * P2-10: schema/DDL drift contract.
 *
 * The settlements table is defined twice: once in src/db/schema.ts (Drizzle, used
 * for queries) and once in CREATE_TABLES_SQL (raw DDL, run at startup). A change
 * to one without the other silently breaks either queries or the live table. This
 * test pins the two definitions together so drift fails CI.
 */
import { describe, expect, it } from "vitest";
import { settlements } from "../src/db/schema.js";
import { CREATE_TABLES_SQL } from "../src/db/index.js";

// Each column: [schema column, expected SQL type+length, NOT NULL?]
// Keep in sync with src/db/schema.ts and CREATE_TABLES_SQL.
const SETTLEMENTS_COLUMNS: Array<[string, RegExp, boolean]> = [
  ["seller_id", /VARCHAR\(64\)/, false],
  ["network", /VARCHAR\(32\)/, true],
  ["scheme", /VARCHAR\(32\)/, true],
  ["asset", /VARCHAR\(128\)/, false],
  ["payer", /VARCHAR\(128\)/, false],
  ["nonce", /VARCHAR\(80\)/, false],
  ["amount", /VARCHAR\(80\)/, false],
  ["tx_hash", /VARCHAR\(128\)/, false],
  ["status", /VARCHAR\(32\)/, true],
  ["error_reason", /VARCHAR\(128\)/, false],
];

describe("P2-10 settlements schema/DDL contract", () => {
  it("CREATE_TABLES_SQL defines the settlements table", () => {
    expect(CREATE_TABLES_SQL).toMatch(/CREATE TABLE IF NOT EXISTS settlements/);
  });

  it.each(SETTLEMENTS_COLUMNS)(
    "DDL column %s matches schema (%s, notNull=%s)",
    (col, typeRe, notNull) => {
      // Extract the column line from the DDL's settlements block.
      const block = CREATE_TABLES_SQL.slice(
        CREATE_TABLES_SQL.indexOf("CREATE TABLE IF NOT EXISTS settlements"),
      );
      const colLine = block.split("\n").find((l) => l.trim().startsWith(`${col} `));
      expect(colLine, `column ${col} missing from DDL`).toBeDefined();
      // Match the type against the trimmed column definition (drops leading
      // whitespace and the trailing comma).
      const colDef = colLine!.trim().replace(/,$/, "");
      expect(colDef).toMatch(typeRe);
      if (notNull) {
        expect(colDef).toMatch(/NOT NULL/);
      } else {
        expect(colDef).not.toMatch(/NOT NULL/);
      }
    },
  );

  it("schema.ts declares the same columns with matching lengths", () => {
    // Drizzle varchar length is encoded on the column config.
    expect(settlements.network.length).toBe(32);
    expect(settlements.scheme.length).toBe(32);
    expect(settlements.asset.length).toBe(128);
    expect(settlements.payer.length).toBe(128);
    expect(settlements.nonce.length).toBe(80);
    expect(settlements.amount.length).toBe(80);
    expect(settlements.txHash.length).toBe(128);
    expect(settlements.status.length).toBe(32);
    expect(settlements.errorReason.length).toBe(128);
    expect(settlements.sellerId.length).toBe(64);
  });

  it("the success-dedup partial unique index exists in the DDL", () => {
    expect(CREATE_TABLES_SQL).toMatch(
      /CREATE UNIQUE INDEX.*uq_settlements_auth_success.*WHERE status = 'success'/s,
    );
  });
});
