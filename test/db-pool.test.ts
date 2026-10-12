import { afterEach, expect, it, vi } from "vitest";
import { disposeDatabase, getDatabasePool, initDatabase } from "../src/db/index.js";
import * as database from "../src/db/index.js";

const fake = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [] })), end: vi.fn(async () => {}) }));
vi.mock("pg", () => ({ Pool: class { query = fake.query; end = fake.end; } }));
const options = { url: "postgresql://unused", poolSize: 1, maxOverflow: 0, maxLifeTime: 60, sslMode: "disable" };
afterEach(async () => { await disposeDatabase(); vi.clearAllMocks(); });
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
  expect(fake.end).toHaveBeenCalledTimes(2);
  expect(() => database.getPermit2LockPool()).toThrow(/not initialized/);
});
it("disposes both pools even when one close rejects", async () => {
  await initDatabase(options);
  fake.end.mockRejectedValueOnce(new Error("end failed"));
  await expect(disposeDatabase()).rejects.toThrow("end failed");
  expect(fake.end).toHaveBeenCalledTimes(2);
  expect(() => getDatabasePool()).toThrow(/not initialized/);
});
