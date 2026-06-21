# x402 Facilitator (v2)

Multi-chain **HTTP 402 Payment Required** facilitator. It verifies payment payloads
off-chain and settles them on-chain, on the upstream **x402 TypeScript** ecosystem
(`@bankofai/x402-core` + `@bankofai/x402-tron` + `@bankofai/x402-evm`).

v2 is a full rewrite of the Python/FastAPI v1 (now under [`legacy/`](legacy/)):
Python → Node/TS, bankofai SDK → `@bankofai/x402-*`, and a hard cutover of the
payment scheme wire format.

## Features

- `verify` / `settle` / `supported` endpoints backed by `@bankofai/x402-core`.
- TRON `exact` (EIP-3009 / Permit2) + `exact_gasfree`; EVM (BSC) `exact`.
- **Non-custodial signing** — settlement keys never enter this process; wallets are
  resolved through `@bankofai/agent-wallet` and only signing crosses the boundary.
- Settlement persistence keyed on the on-chain authorization identity, with
  seller-scoped query APIs.
- API-key auth, dynamic rate limiting, Prometheus metrics.
- 1Password-or-local secret configuration.
- GasFree Open API transparent proxy (HMAC) for TRON `exact_gasfree`.

## Quick start

### Prerequisites

- Node 22+
- PostgreSQL
- A wallet provider resolvable by `@bankofai/agent-wallet` (unlocked via `AGENT_WALLET_PASSWORD`)
- Optional: 1Password service-account token (`OP_SERVICE_ACCOUNT_TOKEN`)

### Install and run

```bash
npm install
cp config/facilitator.config.example.yaml config/facilitator.config.yaml
npm run dev          # tsx watch; or: npm run build && npm start
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

## Configuration

YAML config (`config/facilitator.config.yaml`; template:
[`config/facilitator.config.example.yaml`](config/facilitator.config.example.yaml)).
Path override: `FACILITATOR_CONFIG_PATH`.

Required: `database.url`, `facilitator.networks` (≥1 network, listed = enabled).

Secrets resolve **env first, then 1Password** (each `onepassword.*` value is a
`vault/item/field` ref, used when `OP_SERVICE_ACCOUNT_TOKEN` / `onepassword.token`
is set). Relevant env vars:

| Var | Purpose |
|---|---|
| `AGENT_WALLET_PASSWORD` | Unlock the agent-wallet provider |
| `TRON_GRID_API_KEY` | TronGrid rate limits (shared across TRON networks) |
| `GASFREE_API_KEY[_NILE\|_MAINNET]` / `GASFREE_API_SECRET[...]` | GasFree relayer creds (gate `exact_gasfree`) |
| `UPSTREAM_NILE_BASE` / `UPSTREAM_MAINNET_BASE` | Override GasFree upstream bases |
| `OP_SERVICE_ACCOUNT_TOKEN` | 1Password service-account token |
| `RATE_LIMIT_STORE` | `memory` (default) or `redis` for shared counters across replicas |
| `RATE_LIMIT_REDIS_URL` / `REDIS_URL` | Redis connection URL (required when `RATE_LIMIT_STORE=redis`; needs the optional `ioredis` dep) |
| `TRUST_PROXY_FOR_RATELIMIT` | `true` to key anonymous limits on `X-Forwarded-For` (set **only** when the direct peer is a trusted proxy; the rightmost XFF entry is used, so append-style proxies like nginx `$proxy_add_x_forwarded_for` are safe. Default off keys on the socket peer) |

> Fees are TRON-only (`base_fee` per network, advertised via `requirements.extra.fee`).
> The EVM `exact` scheme settles the exact amount and takes no facilitator fee.
> There is **no** `/fee/quote` endpoint in v2.

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

v2 owns a new `settlements` table (created on startup), keyed on
`(network, scheme, asset, payer, nonce)` — the on-chain authorization identity — with
a partial-unique index enforcing one successful settlement per authorization. The
shared `sellers` / `api_keys_plus` tables are reused unchanged for auth and seller
scoping. v1's `payment_records` is not used by v2.

## SDK consumption (dev)

The `@bankofai/x402-*` packages are **vendored tarballs** in [`vendor/`](vendor/) during
development (referenced via `file:` in `package.json`). When they are published to npm,
replace the `file:` specs with version ranges and remove `vendor/` + the `overrides`
entry in `package.json`.

## Docker

```bash
docker build -t x402-facilitator:2.0.0 .
docker run -p 8001:8001 \
  -e AGENT_WALLET_PASSWORD=... \
  -v "$PWD/config/facilitator.config.yaml:/app/config/facilitator.config.yaml" \
  x402-facilitator:2.0.0
```

## Status

Feature-complete and unit-tested; **not yet validated against live chains** (real
verify+settle on tron:nile / bsc:testnet and GasFree end-to-end are pending), and
without integration tests yet.
