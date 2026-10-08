# x402 Facilitator

Multi-chain **HTTP 402 Payment Required** facilitator. It verifies payment payloads
off-chain and settles them on-chain, on the upstream **x402 TypeScript** ecosystem
(`@bankofai/x402-core` + `@bankofai/x402-tron` + `@bankofai/x402-evm`).

A TypeScript/Node service.

## Features

- `verify` / `settle` / `supported` endpoints backed by `@bankofai/x402-core`.
- TRON `exact` (EIP-3009 / Permit2) + `exact_gasfree`; EVM (BSC) `exact`.
- `upto` (Permit2 up-to-max settlement, TRON + EVM) and `batch-settlement` (channel deposit/voucher/claim/settle/refund, TRON + EVM).
- Wallet signing through `@bankofai/agent-wallet`: external providers keep keys
  outside this process; `raw_secret` loads keys locally.
- Settlement persistence keyed on the on-chain authorization identity, with
  seller-scoped query APIs.
- API-key auth, dynamic rate limiting, Prometheus metrics.
- 1Password-or-local secret configuration.
- GasFree Open API transparent proxy (HMAC) for TRON `exact_gasfree`.

## Quick start

### Prerequisites

- Node 22+
- PostgreSQL
- A configured agent-wallet v3 provider (`raw_secret`, `privy`, or `wallet_cli`)
- Optional: 1Password service-account token (`OP_SERVICE_ACCOUNT_TOKEN`)

### Install and run

```bash
npm ci
FACILITATOR_SERVICE_ENV=dev npm run dev
```

Default listen address: `http://0.0.0.0:8001`.

### Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run with `tsx watch` (reload on change) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server (`dist/index.js`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (vitest) |
| `npm run test:postgres` | Real PostgreSQL tests; requires a disposable local `SPONSORING_TEST_DATABASE_URL` |

## Development and releases

The repository uses `develop` for normal integration and `main` for stable,
deployable releases. Create ordinary work from `develop` and open
`feature/*` pull requests back to `develop`. Service versions and release
tags are prepared only on release or hotfix branches.

- [Contributing guide](./CONTRIBUTING.md)
- [Branching and Docker release workflow](./BRANCHING.md)
- [Changelog](./CHANGELOG.md)

## Configuration

Choose a YAML configuration source explicitly. Set `FACILITATOR_SERVICE_ENV=dev` or
`FACILITATOR_SERVICE_ENV=prod` to select the matching baked-in environment config, or
set `FACILITATOR_CONFIG_PATH` to an explicit YAML file; the explicit path takes
precedence. The process fails before startup when neither is set.

Required: `database.url`, `facilitator.networks` (≥1 network, listed = enabled).

Optional Nile/Shasta Approval resource sponsoring supports SQLite or shared PostgreSQL
storage. Both built-in configs enable Nile-only sponsorship and require
an operator-provisioned Owner and a restricted `resource-active` wallet before
startup. Other configured payment networks remain enabled.
SQLite still requires business PostgreSQL. Shared Owners must use the same PG
ledger and configuration; do not switch ledgers while recovery debt remains.

One process can sponsor both Nile and Shasta: set `resource_sponsoring` to a list
of complete per-network configurations. The existing single-object format remains
supported. Each entry has its own Owner, wallet, permission, assets, limits and
API-key policy; each network must also be enabled under `facilitator.networks`.
Duplicate networks (including decimal/hex aliases) are rejected. SQLite entries
must use distinct absolute file paths. PostgreSQL entries share the application
connection pool and are isolated by network and Owner.

For example, after provisioning the addresses, wallets, assets and stake:

```yaml
resource_sponsoring:
  - network: "tron:3448148188"
    storage: { type: postgres }
    owner: "REPLACE_WITH_NILE_OWNER"
    wallet_id: "nile-resource-active"
    permission_id: 3
    require_api_key: false
    assets: ["TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"]
    energy_stake_sun: "10000000000"
    bandwidth_stake_sun: "20000000000"
    budget_sun: "500000000"
    management_bandwidth: "5000"
  - network: "tron:2494104990"
    storage: { type: postgres }
    owner: "REPLACE_WITH_SHASTA_OWNER"
    wallet_id: "shasta-resource-active"
    permission_id: 3
    require_api_key: true
    assets: ["REPLACE_WITH_SHASTA_TOKEN"]
    energy_stake_sun: "10000000000"
    bandwidth_stake_sun: "20000000000"
    budget_sun: "500000000"
    management_bandwidth: "5000"
```

Each network runs its own recovery loop. A degraded network does not block
sponsorship on healthy networks. `GET /sponsoring/ready?network=tron:3448148188`
checks one network. Without the query, a single entry keeps the existing response;
multiple entries return `ready`, `mode` and a `networks` array, with HTTP 200 only
when all entries are ready. Use network-specific probes if traffic should continue
to healthy networks while another is recovering.

PostgreSQL sponsorship owns only `sponsoring_operations`, `sponsoring_actions`
and `sponsoring_expirations`. Their `pool` field is a deterministic SHA-256
identifier of the canonical network/Owner pair, not a foreign key to a pool table.
Permissions and limits come from YAML on each start. All replicas using the same
Owner must deploy identical settings; the database no longer checks configuration
equality. Lowering limits preserves existing obligations and can deny new work
until usage is below the new limit. Do not remove a network or change its Owner
while it still has recovery obligations.

**Upgrade from the five-table ledger:** stop all old instances, back up the
database, then start the new version. Startup transactionally remaps every stored
pool's records (including networks not currently enabled), preserves signed bytes
and recovery progress, and drops `sponsoring_pools` and `sponsoring_version`.
It refuses migration while an old Owner execution lock is held. Do not use a
mixed-version rolling upgrade: an idle old process could resume using old pool
IDs or recreate the retired tables. Rollback requires stopping the new instances
and a deliberate database restore/reconciliation, not just rolling back the image;
never restore an old snapshot blindly after new chain actions have occurred.

Permit2 settlement checks the on-chain nonce before broadcasting and uses a
PostgreSQL advisory lock for each network/owner/nonce, across tokens and schemes.
Concurrent requests for the same authorization receive HTTP 503 with
`Retry-After`; already consumed nonces return a failed settlement without a new
transaction. The lock uses a separate, lazily connected pool so it cannot starve
the sponsoring ledger's connections. `database.max_open_conns` bounds each pool:
allow up to twice that many PostgreSQL connections per instance. Nonce RPC or
lock acquisition failures stop settlement before execution. This is not an
exactly-once guarantee for transactions whose broadcast outcome is unknown or
for chain reorganizations; reconcile ambiguous transactions before retrying.

`resource_sponsoring.require_api_key` defaults to `true`. Set it to `false` only
for Nile to allow sponsorship without `X-API-KEY`; other networks reject this
setting at startup. Built-in dev opts out of API-key authentication; prod keeps it
enabled. Receiver address validity, asset restrictions, signed approval validation, resource budgets,
recovery and concurrency checks remain enforced. Anonymous requests retain the
anonymous rate limit (dev: `10/minute`, in-memory per instance); with Redis/Valkey, verify and settle share
the anonymous counter, so sequential calls may need to wait for `Retry-After`.
This opt-out exposes test resources to anonymous consumption. Restart the service
after changing the setting; it does not grant an authenticated identity or access
to merchant settlement feeds.

Resource sponsoring accepts any valid TRON payment recipient; there is no receiver
allowlist. The legacy `resource_sponsoring.pay_to` string-list field is accepted
but ignored for existing deployments and has been removed from both built-in configs.
This broadens who can benefit from resources, without bypassing payment signatures,
asset policy, API-key settings or resource limits.

Secrets resolve **env first, then 1Password**. Secret references keep the
`vault/item/field` format. `onepassword.mode` selects `connect` (built-in dev)
or `service_account` (built-in prod and the default when omitted); providers do
not fall back to one another. Connect uses `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN`;
Service Accounts use `OP_SERVICE_ACCOUNT_TOKEN` / `onepassword.token`.
Connect supports vault/item names or IDs and field IDs or unique labels. Duplicate
names/labels are rejected; use IDs to disambiguate. Requests have a 10-second
resolution timeout and do not follow redirects. Use HTTPS, or HTTP only over a
trusted private connection to Connect. Inject tokens at runtime, never in Git.
Required PG credential resolution failures prevent startup; optional RPC/GasFree
credentials retain their existing fallback/disabled behavior. Relevant env vars:

| Var | Purpose |
|---|---|
| `FACILITATOR_SERVICE_ENV` | `dev` or `prod`; selects the matching baked-in config file |
| `FACILITATOR_CONFIG_PATH` | Explicit config path; overrides `FACILITATOR_SERVICE_ENV` |
| `AGENT_WALLET_PASSWORD` | Legacy compatibility hook; v3 removed `local_secure`; not a wallet-cli keystore password |
| `TRON_GRID_API_KEY` | TronGrid rate limits (shared across TRON networks) |
| `GASFREE_API_KEY[_NILE\|_MAINNET]` / `GASFREE_API_SECRET[...]` | GasFree relayer creds (gate `exact_gasfree`) |
| `UPSTREAM_NILE_BASE` / `UPSTREAM_MAINNET_BASE` | Override GasFree upstream bases |
| `OP_SERVICE_ACCOUNT_TOKEN` | 1Password service-account token |
| `OP_CONNECT_HOST` | Connect base URL accessible from the Facilitator container (connect mode only) |
| `OP_CONNECT_TOKEN` | Connect access token with read access to the referenced vaults (not a Service Account token) |
| `RATE_LIMIT_STORE` | `memory` (default) or `redis` for shared counters across replicas |
| `RATE_LIMIT_REDIS_URL` / `REDIS_URL` | Redis/Valkey connection URL; use `rediss://host:6379` for TLS (required when `RATE_LIMIT_STORE=redis`; needs the optional `ioredis` dep) |
| `RATE_LIMIT_REDIS_PASSWORD` | Optional raw Redis/Valkey password; overrides 1Password and the URL password, without URL encoding |
| `TRUST_PROXY_FOR_RATELIMIT` | `true` to key anonymous limits on `X-Forwarded-For` (set **only** when the direct peer is a trusted proxy; the rightmost XFF entry is used, so append-style proxies like nginx `$proxy_add_x_forwarded_for` are safe. Default off keys on the socket peer) |

For shared Valkey rate limits, set `RATE_LIMIT_STORE=redis` and
`RATE_LIMIT_REDIS_URL=rediss://your-valkey-host:6379`. To read the password from
1Password, configure `onepassword.redis_password` with a vault/item/field reference
(for example `x402-facilitator_dev/valkey/password`). This uses the same
`onepassword.mode` and Connect or Service Account credentials as the other secrets.
Password precedence is `RATE_LIMIT_REDIS_PASSWORD` → `onepassword.redis_password`
→ credentials embedded in the URL. Explicitly empty passwords or failed configured
secret lookups abort startup; memory storage does not read this secret.
An ACL username can be supplied in the URL (`rediss://limiter@your-valkey-host:6379`).
TLS certificate verification remains enabled. For a private CA, mount its PEM file
and set `NODE_EXTRA_CA_CERTS` to its container path before starting Node.js.
Alternatively, set `rate_limit.store` and `rate_limit.redis_url` in YAML;
the store environment variable and either URL environment variable override YAML.
The dev config enables TLS Valkey and references
`x402-facilitator-nile_dev/redis/VALKEY_PASSWORD` through Connect.
`VALKEY_EXPIRE` is not used: counter expiration follows each configured rate-limit window.

BSC transaction creation and broadcast use the primary RPC. Receipt confirmation waits up
to 15 seconds on the primary, then up to 45 seconds on the independent fallback for the
same transaction hash; it never rebroadcasts the transaction.

> Fees were removed from the TRON facilitator schemes in SDK `1.0.1` — the `exact`/`upto` proxies transfer exactly `amount` and the GasFree relayer handles its own fee terms. There is no `base_fee` config and no `/fee/quote` endpoint.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Liveness (no auth / rate-limit) |
| `GET` | `/supported` | Supported scheme/network kinds |
| `POST` | `/verify` | Verify a payment payload |
| `POST` | `/settle` | Settle on-chain; rate-limited; persists a settlement |
| `GET` | `/payments/tx/{hash}` | Lookup by settlement tx hash |
| `GET` | `/payments?network=&nonce=[&asset=&payer=]` | Lookup by authorization identity |
| `GET` | `/payments` | Authenticated seller's settlement feed (`?limit=&offset=`) |
| `GET` | `/metrics` | Prometheus (main port, or a separate `monitoring.port`) |
| `ALL` | `/mainnet/*`, `/nile/*` | GasFree transparent proxy (HMAC) |

Lookups are seller-scoped when the request carries a valid `X-API-KEY`.

## Database

The `settlements` table (created on startup) is keyed on
`(network, scheme, asset, payer, nonce)` — the on-chain authorization identity — with
a partial-unique index enforcing one successful settlement per authorization. The
shared `sellers` / `api_keys_plus` tables are reused unchanged for auth and seller
scoping. The legacy `payment_records` table is not used.

## SDK consumption

The `@bankofai/x402-*` packages (`x402-core`, `x402-evm`, `x402-tron`) are consumed from
npm, declared as `^1.0.1` in `package.json`.

## Docker

```bash
docker build -t x402-facilitator .

docker run -p 8001:8001 -p 9001:9001 \
  -e FACILITATOR_SERVICE_ENV=dev \
  -e OP_SERVICE_ACCOUNT_TOKEN \
  -v "$PWD/logs:/app/logs" \
  x402-facilitator
```

The container runs as non-root (uid/gid 1000); make sure the host `logs/`
directory is writable by that uid before bind-mounting it. Configure the selected
v3 wallet provider and mount its required configuration; `wallet_cli` needs its
optional peer dependency and its own keystore password. The retained 1Password /
`AGENT_WALLET_PASSWORD` hook does not unlock a v3 provider automatically.
Port `9001` is only
needed when `monitoring.port` differs from `server.port`.

Both `config/facilitator.config.dev.yaml` and
`config/facilitator.config.prod.yaml` are baked into the image. Select one at
runtime with `FACILITATOR_SERVICE_ENV=dev` or `FACILITATOR_SERVICE_ENV=prod`; no
config-directory mount is required. `FACILITATOR_CONFIG_PATH` remains available
for an explicit custom path.
`OP_SERVICE_ACCOUNT_TOKEN` must be injected only at container runtime (for
example by the deployment platform's secret environment-variable facility);
it is never stored in the image or either YAML file.

## Status

With the currently pinned published npm SDK, Nile ordinary payments and
PostgreSQL-sponsored payments have passed live-chain validation, including
Approval, delegation and withdrawal. SQLite container startup and automated
tests passed, but fresh SQLite-sponsored live payment validation remains pending
available test resource capacity. Earlier SQLite live results used a different
dependency artifact and do not validate the current SDK. Transaction summaries
and remaining acceptance checks are recorded in the pull request.
PostgreSQL integration tests require a disposable test database and are not run
by the default CI job unless that connection is supplied. Shasta sponsorship,
production credentials/wallets, and full cross-network/GasFree acceptance are not
claimed as validated by these Nile results.
