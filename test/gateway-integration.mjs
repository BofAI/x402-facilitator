// Run explicitly with npm run test:gateway. Chain I/O is isolated; HTTP, signatures, and database operations are real.
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { serve } from "@hono/node-server";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { encodePaymentSignatureHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { ExactTronScheme } from "@bankofai/x402-tron/exact/client";
import { ExactTronScheme as ExactFacilitator } from "@bankofai/x402-tron/exact/facilitator";
import {
  createTrc20ApprovalResourceSponsoringRuntime,
  createTrc20ApprovalResourceSponsoringExtension,
  createTrc20ApprovalResourceSponsoringClientExtension,
} from "@bankofai/x402-tron-extensions";
import { createApp } from "../dist/server.js";
import { initDatabase, disposeDatabase, getDatabasePool } from "../dist/db/index.js";
import { refreshApiKeysCache } from "../dist/auth.js";
import { registerPermit2ReplayGuard, permit2Identity } from "../dist/permit2-replay.js";
import { SqliteSponsoringCoordinator } from "../dist/sponsoring/store.js";
import { guardSponsoringChain } from "../dist/sponsoring/chain.js";

function requiredEnv(key) {
  assert.ok(process.env[key], `${key} is required for local Gateway integration`);
  return process.env[key];
}
const gatewayRoot = path.resolve(requiredEnv("GATEWAY_COMPAT_ROOT"));
const databaseUrl = new URL(requiredEnv("SPONSORING_TEST_DATABASE_URL"));
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "test DB must be loopback");
assert.equal(databaseUrl.pathname, "/sponsoring_test", "use a disposable sponsoring_test database");
const moduleAt = (root, file) => import(pathToFileURL(path.join(root, file)).href);
const { loadProvider } = await moduleAt(gatewayRoot, "dist/config.js");
const { createGatewayServer } = await moduleAt(gatewayRoot, "dist/server.js");
const { clientSigner, facilitatorSigner, testRecipient, signedApproval } =
  await moduleAt(gatewayRoot, "tests/helpers/offline-tron.mjs");
const network = "tron:3448148188";
const temporary = mkdtempSync(path.join(tmpdir(), "x402-peripheral-"));
const schema = `compat_${randomBytes(8).toString("hex")}`;
const admin = new Pool({ connectionString: databaseUrl.href, max: 1 });
const scopedUrl = new URL(databaseUrl);
scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
const servers = new Set();
const stores = new Set();

async function start(server) {
  if (!server.listening) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  return `http://127.0.0.1:${server.address().port}`;
}
function close(server) {
  server.closeIdleConnections?.();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function jsonAt(url, init) {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const post = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); // schema is generated hexadecimal, never caller input.
  await initDatabase({ url: scopedUrl.href, poolSize: 1, maxOverflow: 0, maxLifeTime: 60, sslMode: "disable" });
  await getDatabasePool().query("INSERT INTO api_keys_plus(seller_id,wallet_address,key) VALUES ($1,$2,$3)",
    ["compat-seller", testRecipient, "public-test-seller"]);
  await getDatabasePool().query("INSERT INTO api_keys_plus(seller_id,wallet_address,key) VALUES ($1,$2,$3)",
    ["other-seller", testRecipient, "public-test-other"]);
  await refreshApiKeysCache();

});

afterEach(async () => {
  await Promise.all([...servers].filter(server => server.listening).map(close));
  servers.clear();
  for (const store of stores) store.close();
  stores.clear();
});
after(async () => {
  await disposeDatabase();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
  rmSync(temporary, { recursive: true, force: true });
});

async function fixture({ sponsored = false, recovering = false } = {}) {
  const directory = mkdtempSync(path.join(temporary, "fixture-"));
  let allowance = sponsored ? 0n : 1_000_000n;
  let capacityRecovered = !recovering;
  let visible = false;
  let settlements = 0;
  let deliveries = 0;
  const bitmap = new Map();
  const events = [];
  const transaction = randomBytes(32).toString("hex");
  const binding = { network, owner: testRecipient, permissionId: 2 };
  const limits = { energy: 1_000_000_000n, bandwidth: 1_000_000_000n, budget: 100_000_000n, management: 100_000n };
  const storeFile = path.join(directory, "sponsoring.sqlite");
  let store = new SqliteSponsoringCoordinator(storeFile, binding, limits);
  stores.add(store);
  const chain = {
    preflight: async () => ({ accountActivated: true, accountIsContract: false, allowance, tokenBalance: 1_000_000n,
      estimatedEnergy: 100n, estimatedBandwidth: 100n, managementBandwidthAvailable: 100_000n, replacementCost: 1n,
      resources: { energyAvailable: visible ? 1000n : 0n, stakedBandwidthAvailable: visible ? 1000n : 0n,
        freeBandwidthAvailable: 0n, totalEnergyLimit: 1000n, totalEnergyWeight: 100n,
        totalBandwidthLimit: 1000n, totalBandwidthWeight: 100n } }),
    prepareDelegate: async (_request, leg) => ({ txID: `delegate-${leg.resource}`, signedTransaction: `delegate-${leg.resource}` }),
    prepareUndelegate: async (_request, leg) => ({ txID: `reclaim-${leg.resource}`, signedTransaction: `reclaim-${leg.resource}` }),
    broadcast: async action => {
      const saved = await store.findAction(action.txID);
      assert.ok(saved.actions.some(item => item.txID === action.txID && item.signedTransaction === action.signedTransaction));
      events.push(action.txID);
      return action.txID;
    },
    broadcastApproval: async bytes => {
      const saved = await store.findApproval(bytes);
      assert.ok(saved.actions.some(item => item.kind === "approval" && item.signedTransaction === bytes));
      events.push("approval");
      allowance = 1_000_000n;
      return saved.approvalTxID;
    },
    confirm: async () => "confirmed",
    resourcesVisible: async () => { visible = true; return true; },
    allowanceSufficient: async request => allowance >= BigInt(request.requiredAllowance),
    capacityRecovered: async () => capacityRecovered,
  };
  const makeRuntime = (factory = createTrc20ApprovalResourceSponsoringRuntime) => factory({
    chain: guardSponsoringChain(chain, store), coordinator: store,
    policy: { preview: async () => ({ allowed: true, budgetUnits: 1n }) },
    approvalPolicy: { strategyFor: () => "zero-first" },
  });
  let runtime = makeRuntime();
  const signer = {
    ...facilitatorSigner(),
    readContract: async ({ functionName, args }) => {
      if (functionName === "nonceBitmap") return bitmap.get(String(args[1])) ?? 0n;
      if (functionName === "allowance") return allowance;
      assert.equal(functionName, "balanceOf");
      return 1_000_000n;
    },
    writeContract: async args => {
      assert.equal(args.functionName, "settle");
      assert.ok(allowance >= 1000n);
      settlements += 1;
      // Unordered nonce bit is burned at the simulated chain boundary.
      const nonce = BigInt(args.args[0][1]);
      const word = String(nonce >> 8n);
      bitmap.set(word, (bitmap.get(word) ?? 0n) | (1n << (nonce & 255n)));
      return transaction;
    },
    waitForTransactionReceipt: async ({ hash }) => { assert.equal(hash, transaction); return { status: "success" }; },
  };
  const core = new x402Facilitator().register(network, new ExactFacilitator(signer));
  registerPermit2ReplayGuard(core, network, signer);
  if (sponsored) core.registerExtension(createTrc20ApprovalResourceSponsoringExtension({
    verify: request => runtime.verify(request), sponsor: request => runtime.sponsor(request),
  }));
  const app = createApp(core, {
    sponsoring: sponsored ? [{ access: () => ({ network, ready: true, requireApiKey: false }),
      readiness: () => ({ network, ready: true, mode: "READY" }) }] : [],
    rateLimit: { authenticated: "10000/minute", anonymous: "10000/minute" },
    gasfreeSettings: () => null, metricsOnMainPort: true, metricsEndpoint: "/metrics", maxRequestBodyBytes: 1_048_576,
  });
  const facilitatorServer = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  servers.add(facilitatorServer);
  if (!facilitatorServer.listening) await once(facilitatorServer, "listening");
  const facilitatorUrl = `http://127.0.0.1:${facilitatorServer.address().port}`;
  const upstream = http.createServer((request, response) => {
    deliveries += 1;
    assert.equal(request.headers["payment-signature"], undefined);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ delivered: true }));
  });
  servers.add(upstream);
  const upstreamUrl = await start(upstream);
  const route = {provider:"compat",scheme:"exact",assetTransferMethod:"permit2"};
  const endpoint = {method:"GET",path:"/protocols"};
  const configFile = path.join(directory, "provider.yaml");
  writeFileSync(configFile, JSON.stringify({ name: route.provider, forward_url: upstreamUrl,
    operator: { network, recipient: testRecipient, currencies: { usd: ["USDT"] }, scheme: route.scheme,
      assetTransferMethod: route.assetTransferMethod, facilitator_url: facilitatorUrl,
      facilitator_api_key: "public-test-seller", valid_for_seconds: 300 },
    endpoints: [{ method: endpoint.method, path: endpoint.path,
      ...(sponsored ? { payment: { trc20_approval_resource_sponsoring: true } } : {}),
      metering: { dimensions: [{ tiers: [{ price_usd: 0.001 }] }] } }],
  }));
  const entry = loadProvider(configFile);
  const gatewayServer = createGatewayServer(new Map([[entry.config.name, entry]]));
  servers.add(gatewayServer);
  const gatewayUrl = await start(gatewayServer);
  const url = `${gatewayUrl}/providers/${entry.config.name}${endpoint.path}`;
  const required = await jsonAt(url);
  assert.equal(required.status, 402);
  assert.equal(required.body.accepts[0].network, network);
  const client = clientSigner({ readContract: async () => allowance, signPermit2Approval: signedApproval,
    ensureAllowance: async () => { assert.ok(!sponsored, "client must not self-fund Approval"); return true; } });
  const paymentClient = new x402Client().register(network, new ExactTronScheme(client));
  if (sponsored) paymentClient.registerExtension(createTrc20ApprovalResourceSponsoringClientExtension(client));
  const payment = await paymentClient.createPaymentPayload(required.body);
  const result = {
    servers: [gatewayServer, facilitatorServer, upstream], get store() { return store; },
    url, facilitatorUrl, payment, requirements: required.body.accepts[0], events,
    stats: () => ({ settlements, deliveries }),
    restart: async () => {
      store.close();
      stores.delete(store);
      store = new SqliteSponsoringCoordinator(storeFile, binding, limits);
      stores.add(store);
      runtime = makeRuntime();
      capacityRecovered = true;
      return runtime.reconcile();
    },
  };
  return result;
}
const pay = (f, payment = f.payment) => jsonAt(f.url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payment) } });

test("SDK 2.1 → Gateway → Facilitator HTTP → PostgreSQL → upstream; replay fails closed", async () => {
  const f = await fixture();
  const response = await pay(f);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { delivered: true });
  const settlement = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE"));
  assert.equal(settlement.success, true);
  const rows = await jsonAt(`${f.facilitatorUrl}/payments/tx/${settlement.transaction}`);
  assert.equal(rows.status, 200);
  assert.equal(rows.body[0].status, "success");
  assert.equal(rows.body[0].amount, "1000");
  const identity = permit2Identity(f.payment, f.requirements);
  const lookup = await jsonAt(`${f.facilitatorUrl}/payments?network=${network}&nonce=${f.payment.payload.permit2Authorization.nonce}`);
  assert.equal(lookup.status, 200);
  assert.equal(BigInt(lookup.body[0].nonce), identity.nonce);
  const other = await jsonAt(`${f.facilitatorUrl}/payments/tx/${settlement.transaction}`, { headers: { "X-API-KEY": "public-test-other" } });
  assert.equal(other.status, 404);
  const replay = await jsonAt(`${f.facilitatorUrl}/settle`, post({ paymentPayload: f.payment, paymentRequirements: f.requirements }));
  assert.equal(replay.body.success, false);
  assert.equal(replay.body.errorReason, "permit2_nonce_consumed");
  assert.deepEqual(f.stats(), { settlements: 1, deliveries: 1 });
  assert.equal((await getDatabasePool().query("SELECT count(*) FROM settlements WHERE tx_hash=$1 AND status='success'", [settlement.transaction])).rows[0].count, "1");
  assert.equal((await fetch(`${f.facilitatorUrl}/metrics`)).status, 200);
});

test("registry SDK2 signed payload reaches upgraded Facilitator over Gateway and Facilitator HTTP", async t => {
  const legacy = JSON.parse(readFileSync(path.join(gatewayRoot, "tests/fixtures/legacy-tron-v2.json")));
  t.mock.method(Date, "now", () => legacy.provenance.signedAtMs);
  const f = await fixture();
  const response = await pay(f, legacy.paymentPayload);
  assert.equal(response.status, 200);
  assert.deepEqual(f.stats(), { settlements: 1, deliveries: 1 });
});

test("resource debt survives SQLite restart after signed Approval and settlement", async () => {
  const f = await fixture({ sponsored: true, recovering: true });
  const response = await pay(f);
  assert.equal(response.status, 200);
  assert.deepEqual(f.stats(), { settlements: 1, deliveries: 1 });
  assert.deepEqual(f.events, ["delegate-energy", "delegate-bandwidth", "approval", "reclaim-energy", "reclaim-bandwidth"]);
  const bytes = f.payment.extensions.trc20ApprovalResourceSponsoring.info.signedTransaction;
  const before = await f.store.findApproval(bytes);
  assert.equal(before.status, "sponsored_recovering");
  assert.equal(before.actions.filter(item => item.kind === "approval").length, 1);
  const reconciled = await f.restart();
  assert.equal(reconciled.recovered, 1);
  assert.equal((await f.store.get(before.key)).status, "recovered");
  assert.equal((await f.store.listRecoverable(100)).length, 0);
  assert.equal(f.events.filter(item => item === "approval").length, 1);
});

test("invalid payment and malformed HTTP never broadcast or deliver", async () => {
  const f = await fixture({ sponsored: true });
  const invalid = structuredClone(f.payment);
  invalid.payload.signature = `0x${"0".repeat(130)}`;
  assert.notEqual((await pay(f, invalid)).status, 200);
  assert.deepEqual(f.stats(), { settlements: 0, deliveries: 0 });
  assert.equal(f.events.length, 0);
  const malformed = await jsonAt(`${f.facilitatorUrl}/verify`, post({ paymentPayload: f.payment, paymentRequirements: f.requirements, injected: true }));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.invalidReason, "missing_parameters");
});
