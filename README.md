# x402 Facilitator

Multi-chain **HTTP 402 Payment Required** facilitator. It verifies payment payloads
off-chain and settles them on-chain, on the upstream **x402 TypeScript** ecosystem
(`@bankofai/x402-core` + `@bankofai/x402-tron` + `@bankofai/x402-evm`).

A TypeScript/Node service. The earlier Python/FastAPI implementation is kept under
[`legacy/`](legacy/) as a behavioral reference.

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
operator-provisioned Owner/recipient addresses and a restricted `resource-active`
wallet before startup. Other configured payment networks remain enabled.
SQLite still requires business PostgreSQL. Shared Owners must use the same PG
ledger and configuration; do not switch ledgers while recovery debt remains.

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
