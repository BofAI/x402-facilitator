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
  -e OP_SERVICE_ACCOUNT_TOKEN="" \
  -e AGENT_WALLET_PASSWORD="" \
  -v "$PWD/config/facilitator.config.yaml:/app/config/facilitator.config.yaml:ro" \
  -v "$PWD/logs:/app/logs" \
  x402-facilitator
```

The container runs as non-root (uid/gid 1000); make sure the host `logs/`
directory is writable by that uid before bind-mounting it. The agent-wallet
password is resolved from `OP_SERVICE_ACCOUNT_TOKEN` (1Password) when set;
otherwise pass it directly via `AGENT_WALLET_PASSWORD`. Port `9001` is only
needed when `monitoring.port` differs from `server.port`.

## Status

Feature-complete and unit-tested; **not yet validated against live chains** (real
verify+settle on `tron:0xcd8690dc` / `eip155:97` and GasFree end-to-end are pending), and
without integration tests yet.
