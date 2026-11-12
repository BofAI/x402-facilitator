import { afterEach, expect, it, vi } from "vitest";
import { disposeDatabase, getDatabasePool, initDatabase } from "../src/db/index.js";
import * as database from "../src/db/index.js";

const fake = vi.hoisted(() => ({
  query: vi.fn<(query: string | { text: string }) => Promise<{ rows: unknown[][] }>>(async () => ({ rows: [] })),
  end: vi.fn(async () => {}),
}));
vi.mock("pg", () => ({ Pool: class {
  constructor(private readonly options: { connectionString: string }) {}
  get url() { return this.options.connectionString; }
  query = fake.query;
  end = fake.end;
  on() {}
} }));
const apiKeyDatabase = { url: "postgresql://unused/devcenter", sslMode: "verify-full" as const };
const options = { url: "postgresql://unused", poolSize: 1, maxOverflow: 0, maxLifeTime: 60, sslMode: "disable", apiKeyDatabase };
afterEach(async () => { await disposeDatabase(); vi.resetAllMocks(); });
it("only exposes the shared pool after successful initialization and before disposal", async () => {
  expect(() => getDatabasePool()).toThrow(/not initialized/);
  await initDatabase(options);
  expect(getDatabasePool()).toBe(getDatabasePool());
  await getDatabasePool().query("SELECT 1");
  expect(fake.query).toHaveBeenLastCalledWith("SELECT 1");
  await disposeDatabase();
  expect(() => getDatabasePool()).toThrow(/not initialized/);
});
it("does not expose a pool after failed schema initialization", async () => {
  fake.query.mockRejectedValueOnce(new Error("connection failed"));
  await expect(initDatabase(options)).rejects.toThrow("connection failed");
  expect(() => getDatabasePool()).toThrow(/not initialized/);
  expect(fake.end).toHaveBeenCalledTimes(2);
});
it("keeps Permit2 locks on a separate lazy pool with the database's lifecycle", async () => {
  await initDatabase(options);
  expect(typeof database.getPermit2LockPool).toBe("function");
  expect(database.getPermit2LockPool()).not.toBe(getDatabasePool());
  expect(database.getPermit2LockPool()).toBe(database.getPermit2LockPool());
  await disposeDatabase();
  expect(fake.end).toHaveBeenCalledTimes(3);
  expect(() => database.getPermit2LockPool()).toThrow(/not initialized/);
});
it("disposes all three pools even when one close rejects", async () => {
  await initDatabase(options);
  fake.end.mockRejectedValueOnce(new Error("end failed"));
  await expect(disposeDatabase()).rejects.toThrow("end failed");
  expect(fake.end).toHaveBeenCalledTimes(3);
  expect(() => getDatabasePool()).toThrow(/not initialized/);
});

it("loads only active keys from DevCenter and keeps business queries and DDL on the main database", async () => {
  fake.query.mockImplementation(async function (this: { url: string }, query: string | { text: string }) {
    const sql = typeof query === "string" ? query : query.text;
    if (this.url === apiKeyDatabase.url) {
      expect(sql).toMatch(/select "key", "seller_id" from "api_keys_plus" where "api_keys_plus"\."is_active" =/i);
      return { rows: [["test-devcenter-key", "original-seller"]] };
    }
    expect(sql).not.toMatch(/api_keys_plus|CREATE TABLE IF NOT EXISTS sellers/);
    return { rows: [] };
  });

  await initDatabase(options);
  expect(await database.getActiveApiKeyAuth()).toEqual([
    { key: "test-devcenter-key", sellerId: "original-seller" },
  ]);
  await database.getSettlementsBySeller("original-seller", 10, 0);
  await disposeDatabase();
  expect(fake.end).toHaveBeenCalledTimes(3);
});
