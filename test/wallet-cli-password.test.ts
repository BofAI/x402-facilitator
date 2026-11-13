import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { resolveWallet, type Eip712Capable } from "@bankofai/agent-wallet";
import { afterEach, expect, it, vi } from "vitest";
import { getWalletCliPasswordSource } from "../src/config.js";
import { CachedWalletPassword, walletCliDependencies } from "../src/wallet-cli-password.js";

const network = "tron:3448148188";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("loads once on concurrent acquisition and issues independent, single-use leases", async () => {
  const load = vi.fn(async () => "fixture-password");
  const cache = new CachedWalletPassword(load, 300);
  const send = (chunks: Buffer[]) => new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  try {
    expect(load).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([cache.acquire(), cache.acquire()]);
    expect(load).toHaveBeenCalledTimes(1);
    const received: Buffer[] = [];
    await first.writeTo(send(received));
    await expect(first.writeTo(send(received))).rejects.toThrow(/once/);
    await first.dispose();
    await second.writeTo(send(received));
    await second.dispose();
    expect(received.map(value => value.toString())).toEqual(["fixture-password", "fixture-password"]);
  } finally {
    cache.close();
  }
});

it("wipes an expired cache and reloads the password after rotation", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("rotated");
  const cache = new CachedWalletPassword(load, 1);
  try {
    await (await cache.acquire()).dispose();
    await vi.advanceTimersByTimeAsync(999);
    await (await cache.acquire()).dispose();
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const lease = await cache.acquire();
    const output: Buffer[] = [];
    await lease.writeTo(new Writable({
      write(chunk: Buffer, _encoding, callback) { output.push(chunk); callback(); },
    }));
    expect(Buffer.concat(output).toString()).toBe("rotated");
    await lease.dispose();
    expect(output[0]).toEqual(Buffer.alloc(7));
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    cache.close();
  }
});

it("rejects an in-flight lookup and invalidates existing leases on close", async () => {
  vi.useFakeTimers();
  let complete!: (password: string) => void;
  const load = vi.fn().mockResolvedValueOnce("initial").mockImplementationOnce(
    () => new Promise<string>(resolve => { complete = resolve; }),
  );
  const cache = new CachedWalletPassword(load, 1);
  const lease = await cache.acquire();
  await vi.advanceTimersByTimeAsync(1000);
  const pending = cache.acquire();
  cache.close();
  complete("late");
  await expect(pending).rejects.toThrow(/closed/);
  await expect(cache.acquire()).rejects.toThrow(/closed/);
  await expect(lease.writeTo(new Writable())).rejects.toThrow(/disposed/);
});

it("retries a failed lookup without exposing the provider error", async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error("internal fixture")).mockResolvedValueOnce("recovered");
  const cache = new CachedWalletPassword(load, 300);
  try {
    await expect(cache.acquire()).rejects.toThrow(/^Unable to read wallet-cli password from 1Password$/);
    await (await cache.acquire()).dispose();
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    cache.close();
  }
});

it("uses real wallet-cli subprocess plumbing without forwarding 1Password tokens or putting the password in argv", async () => {
  const dir = mkdtempSync(join(tmpdir(), "facilitator-wallet-cli-"));
  const script = join(dir, "wallet-cli.cjs");
  writeFileSync(script, `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    const password = fs.readFileSync(0, "utf8");
    if (Object.keys(process.env).some(key => /^OP_/i.test(key) || key === "AGENT_WALLET_PASSWORD")) process.exit(10);
    if (!args.includes("json") || (password && args.includes(password))) process.exit(11);
    const version = "4.15.0";
    const chain = { family: "tron", network: "tron:3448148188", chainId: "3448148188" };
    const address = "TMSgJxtPw29AFEHMXsjGo4kWV7UwbCToHJ";
    const success = (command, data, target) => JSON.stringify({
      schema: "wallet-cli.result.v1", success: true, command, chain: target, data,
      meta: { durationMs: 1, warnings: [] },
    });
    if (args.includes("--version")) {
      process.stdout.write(version);
    } else if (args.includes("--json-schema")) {
      process.stdout.write(JSON.stringify({ tool: "wallet-cli", version, globalFlags: [], commands: [
        { id: "current", kind: "neutral", path: ["current"] },
        { id: "tx.sign", kind: "chain", families: ["tron"], path: ["tx", "sign"] },
        { id: "typed-data.sign", kind: "chain", families: ["tron"], path: ["typed-data", "sign"] },
      ] }));
    } else if (args.includes("networks")) {
      process.stdout.write(success("networks", [{ id: chain.network, ...chain }]));
    } else if (args.includes("current")) {
      process.stdout.write(success("current", {
        accountId: "wlt_fixture.0", type: "seed", index: 0, active: true, addresses: { tron: address },
      }, chain));
    } else if (args.includes("typed-data")) {
      if (!args.includes("--password-stdin") || password !== "fixture-password") process.exit(12);
      process.stdout.write(success("typed-data.sign", {
        address, primaryType: "Message", digest: "0x" + "22".repeat(32), signature: "0x" + "33".repeat(65),
      }, chain));
    } else process.exit(13);
  `);
  writeFileSync(join(dir, "wallets_config.json"), JSON.stringify({
    active_wallet: "fixture",
    wallets: { fixture: { type: "wallet_cli", params: {
      account: "wlt_fixture.0", password: "facilitator:1password",
    } } },
  }));
  vi.stubEnv("AGENT_WALLET_WALLET_CLI_PATH", script);
  vi.stubEnv("OP_CONNECT_TOKEN", "fixture-connect");
  vi.stubEnv("OP_CONNECT_HOST", "http://connect.example");
  vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "fixture-service-account");
  vi.stubEnv("OP_SESSION_fixture", "fixture-session");
  vi.stubEnv("AGENT_WALLET_PASSWORD", "fixture-legacy-env");
  const vault = "a".repeat(26);
  const item = "b".repeat(26);
  const fetchSecret = vi.fn(async () => Response.json({
    fields: [{ label: "password", value: "fixture-password" }],
  }));
  vi.stubGlobal("fetch", fetchSecret);
  const load = getWalletCliPasswordSource({
    database: {},
    facilitator: { networks: { [network]: {} } },
    onepassword: { mode: "connect", agent_wallet_password: `${vault}/${item}/password` },
  })!;
  const cache = new CachedWalletPassword(load, 300);
  try {
    const wallet = await resolveWallet({ network, dir, dependencies: walletCliDependencies(cache) });
    await expect(wallet.getAddress()).resolves.toBe("TMSgJxtPw29AFEHMXsjGo4kWV7UwbCToHJ");
    expect(fetchSecret).not.toHaveBeenCalled();
    const signer = wallet as typeof wallet & Eip712Capable;
    const typedData = {
      domain: { chainId: 3448148188 },
      types: { Message: [{ name: "value", type: "string" }] },
      primaryType: "Message",
      message: { value: "fixture" },
    };
    await expect(Promise.all([signer.signTypedData(typedData), signer.signTypedData(typedData)]))
      .resolves.toEqual(["33".repeat(65), "33".repeat(65)]);
    expect(fetchSecret).toHaveBeenCalledTimes(1);
    expect(fetchSecret).toHaveBeenCalledWith(
      new URL(`http://connect.example/v1/vaults/${vault}/items/${item}`),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer fixture-connect" }) }),
    );
  } finally {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
