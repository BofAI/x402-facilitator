import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Trc20SponsoringOperation } from "@bankofai/x402-tron";
import { SqliteSponsoringCoordinator } from "../src/sponsoring/store.js";

const binding = { network: "tron:0xcd8690dc", owner: "owner-a", permissionId: 2 };
const limits = { energy: 10_000_000n, bandwidth: 10_000_000n, budget: 10_000_000n, management: 10_000n };
function operation(key = "approval-a", payer = "payer-a"): Trc20SponsoringOperation {
  return {
    key, network: binding.network, approvalTxID: key, payer, requestDigest: key,
    request: { network: binding.network, approvalTxID: key, payer } as Trc20SponsoringOperation["request"],
    plan: { energyRequired: 120n, bandwidthRequired: 110n, managementBandwidthRequired: 700n,
      replacementCost: 1n, legs: [{ resource: "ENERGY", requiredUnits: 120n, delegatedUnits: 120n, stakeSun: 6_000_000n }] },
    budgetUnits: 1n, status: "admitted", actions: [], revision: 0, createdAtMs: 1000,
  };
}
function path() { return join(mkdtempSync(join(tmpdir(), "sponsoring-test-")), "store.sqlite"); }

describe("SQLite sponsorship coordinator", () => {
  it("admits other payers only within remaining capacity while reclaimed debt survives restart", async () => {
    const file = path();
    let store = new SqliteSponsoringCoordinator(file, binding, limits);
    const debt = { ...operation(), status: "sponsored_recovering" as const };
    await store.admit(debt); store.close();
    store = new SqliteSponsoringCoordinator(file, binding, limits);
    try {
      const next = operation("next", "payer-b");
      next.plan.legs[0].stakeSun = 4_000_000n;
      expect((await store.admit(next)).kind).toBe("created");
      expect((await store.admit(operation("over-limit", "payer-c"))).kind).toBe("denied");
      expect((await store.admit(operation("same-payer", "payer-a"))).kind).toBe("denied");
      expect(await store.listRecoverable(100)).toHaveLength(2);
      await store.markRecovered(debt);
      expect((await store.admit(operation("after-recovery", "payer-c"))).kind).toBe("created");
    } finally { store.close(); }
  });

  it("does not over-reserve when different payers race for the final capacity", async () => {
    const store = new SqliteSponsoringCoordinator(path(), binding, limits);
    try {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.admit(operation(`op-${i}`, `payer-${i}`))));
      expect(results.filter(result => result.kind === "created")).toHaveLength(1);
      expect(results.filter(result => result.kind === "denied")).toHaveLength(19);
      expect(await store.listRecoverable(100)).toHaveLength(1);
    } finally { store.close(); }
  });

  it("releases a rejected exclusive task so the next task can run", async () => {
    const store = new SqliteSponsoringCoordinator(path(), binding, limits);
    const events: string[] = [];
    try {
      const tasks = [store.runExclusive("owner", async () => { events.push("first"); throw new Error("RPC failed"); }),
        store.runExclusive("owner", async () => { events.push("second"); return store.admit(operation()); })];
      const results = await Promise.allSettled(tasks);
      expect(results.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
      expect(events).toEqual(["first", "second"]);
      expect(await store.get("approval-a")).toBeDefined();
    } finally { store.close(); }
  });

  it("rolls back both state and revision if immutable action validation fails", async () => {
    const store = new SqliteSponsoringCoordinator(path(), binding, limits);
    try {
      const op = { ...operation(), actions: [{ kind: "delegate" as const, resource: "ENERGY" as const,
        txID: "original", signedTransaction: "aa", status: "prepared" as const }] };
      await store.admit(op);
      await expect(store.save({ ...op, status: "recovered", actions: [{ ...op.actions[0], signedTransaction: "bb" }] }))
        .rejects.toThrow(/immutable/);
      expect(await store.get(op.key)).toEqual(op);
      expect((await store.admit(operation("other", "other-payer"))).kind).toBe("denied");
    } finally { store.close(); }
  });

  it("detects corrupted operation bytes after reopening", async () => {
    const file = path();
    const store = new SqliteSponsoringCoordinator(file, binding, limits);
    await store.admit(operation()); store.close();
    const db = new DatabaseSync(file);
    db.prepare("UPDATE operations SET payload=? WHERE key=?").run(Buffer.from("corrupt"), "approval-a"); db.close();
    const reopened = new SqliteSponsoringCoordinator(file, binding, limits);
    try { await expect(reopened.listRecoverable(100)).rejects.toThrow("sponsor_database_corrupt"); }
    finally { reopened.close(); }
  });

  it("refuses an unknown schema without leaving the writer locked", () => {
    const file = path();
    const db = new DatabaseSync(file); db.exec("PRAGMA user_version=999"); db.close();
    expect(() => new SqliteSponsoringCoordinator(file, binding, limits)).toThrow("sponsor_database_version_unsupported");
    const writer = new DatabaseSync(`${file}.writer`);
    try { expect(() => writer.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE")).not.toThrow(); }
    finally { writer.close(); }
  });

  it("restores exact bigint, prepared bytes, identity and deadlines after reopening", async () => {
    const file = path();
    let store = new SqliteSponsoringCoordinator(file, binding, limits);
    const identity = store.instanceId;
    const op = operation();
    await store.admit(op);
    await store.save({ ...op, actions: [{ kind: "delegate", resource: "ENERGY", txID: "tx-a", signedTransaction: "deadbeef", status: "prepared" }] });
    store.noteDelegate(op.key, 4000);
    store.close();
    store = new SqliteSponsoringCoordinator(file, binding, limits);
    expect(store.instanceId).toBe(identity);
    expect((await store.get(op.key))?.plan.legs[0].stakeSun).toBe(6_000_000n);
    expect((await store.get(op.key))?.actions[0].signedTransaction).toBe("deadbeef");
    expect(store.deadlines(op.key)).toEqual({ businessDeadline: 481000, forceReclaimAt: 604000 });
    store.noteDelegate(op.key, 8000);
    expect(store.deadlines(op.key).forceReclaimAt).toBe(604000);
    store.close();
  });
  it("reserves capacity atomically and rejects reused approval contents", async () => {
    const store = new SqliteSponsoringCoordinator(path(), binding, limits);
    const op = operation();
    expect((await store.admit(op)).kind).toBe("created");
    expect((await store.admit(op)).kind).toBe("existing");
    expect((await store.admit({ ...op, requestDigest: "different" })).kind).toBe("conflict");
    expect((await store.admit(operation("b", "payer-b"))).kind).toBe("denied");
    const saved = await store.save({ ...op, status: "reclaiming" });
    await expect(store.save(op)).rejects.toThrow(/revision/);
    await store.markRecovered(saved);
    expect((await store.admit(operation("b", "payer-b"))).kind).toBe("created");
    store.close();
  });
  it("rejects a second writer and a different owner binding", () => {
    const file = path();
    const store = new SqliteSponsoringCoordinator(file, binding, limits);
    expect(() => new SqliteSponsoringCoordinator(file, binding, limits)).toThrow();
    store.close();
    expect(() => new SqliteSponsoringCoordinator(file, { ...binding, owner: "owner-b" }, limits)).toThrow(/binding/);
  });
  it("does not enumerate or restore operations from another database", async () => {
    const a = new SqliteSponsoringCoordinator(path(), binding, limits);
    const b = new SqliteSponsoringCoordinator(path(), { ...binding, owner: "owner-b" }, limits);
    await a.admit(operation());
    expect(await b.listRecoverable(100)).toEqual([]);
    expect(await b.get("approval-a")).toBeUndefined();
    a.close(); b.close();
  });
  it("refuses to mutate already prepared bytes", async () => {
    const store = new SqliteSponsoringCoordinator(path(), binding, limits);
    const op = { ...operation(), actions: [{ kind: "approval" as const, txID: "a", signedTransaction: "aa", status: "prepared" as const }] };
    await store.admit(op);
    await expect(store.save({ ...op, actions: [{ ...op.actions[0], signedTransaction: "bb" }] })).rejects.toThrow(/immutable/);
    store.close();
  });
  it("releases the OS writer lock after SIGKILL without resetting durable deadlines", async () => {
    const file = path();
    const store = new SqliteSponsoringCoordinator(file, binding, limits);
    await store.admit(operation());
    store.noteDelegate("approval-a", 5000);
    store.close();
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { SqliteSponsoringCoordinator } from './src/sponsoring/store.ts';
      const store = new SqliteSponsoringCoordinator(process.argv[1], ${JSON.stringify(binding)},
        {energy:10000000n,bandwidth:10000000n,budget:10000000n,management:10000n});
      process.send('ready');
      setInterval(() => {}, 1000);
    `, file], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"] });
    try {
      await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("child exited before opening database"); })]);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      const reopened = new SqliteSponsoringCoordinator(file, binding, limits);
      expect(reopened.deadlines("approval-a").forceReclaimAt).toBe(605000);
      expect((await reopened.get("approval-a"))?.status).toBe("admitted");
      reopened.close();
    } finally { child.kill("SIGKILL"); }
  }, 10000);
});
