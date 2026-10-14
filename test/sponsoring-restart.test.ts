import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { approvalTxID, operationKey, restartHarness } from "./helpers/sponsoring-restart.js";

describe("real process interruption with published SDK and SQLite", () => {
  it.each(["delegate", "approval", "undelegate"])("recovers the original %s transaction after SIGKILL during its broadcast response", async phase => {
    const file = join(mkdtempSync(join(tmpdir(), "sponsor-crash-")), "local.sqlite");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { restartHarness } from './test/helpers/sponsoring-restart.ts';
      const harness = restartHarness(process.argv[1], {interrupt: process.argv[2]});
      await harness.runtime.sponsor(harness.request);
      process.exit(2);
    `, file, phase], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"] });
    try {
      const [checkpoint] = await Promise.race([once(child, "message"), once(child, "exit").then(() => {
        throw new Error("child exited before durable broadcast checkpoint");
      })]);
      expect(checkpoint.persisted).toBe(true);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      const resumed = restartHarness(file, { resumed: true, allowance: phase !== "delegate" });
      try {
        expect(resumed.store.instanceId).toBe(checkpoint.instanceId);
        expect(resumed.store.deadlines(operationKey)).toEqual(checkpoint.deadlines);
        const result = await resumed.runtime.reconcile();
        expect(result).toEqual({ examined: 1, recovered: 1 });
        expect(resumed.events).not.toContain("sign:delegate");
        expect(resumed.events).not.toContain(`broadcast:${approvalTxID}`);
        if (phase === "undelegate") expect(resumed.events).not.toContain("sign:reclaim");
        expect(resumed.events).toContain("broadcast:reclaim");
        expect((await resumed.store.get(operationKey))?.actions.find(action => action.kind === "undelegate")?.status).toBe("confirmed");
        expect(await resumed.store.listRecoverable(100)).toEqual([]);
      } finally { resumed.store.close(); }
    } finally { child.kill("SIGKILL"); }
  }, 10000);
});
