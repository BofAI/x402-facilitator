# X402 Facilitator

X402 Facilitator is a production-ready, multi-chain service for handling **HTTP 402 Payment Required** workflows. It verifies payment payloads off-chain and settles payments on-chain for enabled networks.

## What It Provides

- Multi-chain support through configuration (TRON, BSC, and other supported networks)
- Payment verification and settlement endpoints for X402 flows
- API key aware access control and rate limiting
- Payment record persistence and query APIs
- 1Password-based or local secret configuration
- Docker-friendly deployment

## Quick Start

### Prerequisites

- Python 3.10+
- PostgreSQL
- An active external wallet provider resolvable by `x402` / `agent-wallet`
- Optional: 1Password service account token (`OP_SERVICE_ACCOUNT_TOKEN`)

### Install and Run

```bash
pip install -r requirements.txt
cp config/facilitator.config.example.yaml config/facilitator.config.yaml
python src/main.py
```

Default listen address: `http://0.0.0.0:8001`

## Configuration

Main config file:

- `config/facilitator.config.yaml`
- Reference template: `config/facilitator.config.example.yaml`

### Required Configuration

1. `database.url`
2. `facilitator.networks` (must include at least one network)

### Optional Configuration

- `database.ssl_mode`
- `database.max_open_conns`
- `database.max_idle_conns`
- `database.max_life_time`
- `server.host`
- `server.port`
- `server.workers`
- `logging.*`
- `rate_limit.*`
- `monitoring.*`
- `facilitator.trongrid_api_key` (TRON use cases)
- TRON **GasFree** (`exact_gasfree`): credentials are read at startup from `GASFREE_API_KEY` / `GASFREE_API_SECRET` (or per-network `GASFREE_API_KEY_NILE`, `GASFREE_API_KEY_MAINNET`, etc.) and/or 1Password refs `gasfree_api_key_nile`, `gasfree_api_secret_nile`, `gasfree_api_key_mainnet`, `gasfree_api_secret_mainnet` (with global `gasfree_api_key` / `gasfree_api_secret` as fallback), then passed explicitly to `GasFreeAPIClient` (process environment is not modified for GasFree).

### GasFree Open API transparent proxy

A separate module **`src/gasfree_open_proxy/`** exposes HTTP pass-through routes on the **same** server (isolated from X402 `verify` / `settle` code):

| Client path | Upstream |
|-------------|----------|
| `/mainnet/...` | `https://open.gasfree.io/tron/...` |
| `/nile/...` | `https://open-test.gasfree.io/nile/...` |

- Uses the **same** GasFree credentials as above: Nile requests need `tron:nile` key/secret; mainnet paths need `tron:mainnet` key/secret. If credentials for that environment are missing, the proxy returns **503** for that prefix.
- Optional environment overrides: `UPSTREAM_MAINNET_BASE` (default `https://open.gasfree.io`), `UPSTREAM_NILE_BASE` (default `https://open-test.gasfree.io`).
- Clients **do not** send GasFree `Authorization`; the service signs requests with HMAC (aligned with GasFree Open API). Client `Authorization` is **not** forwarded.
- **Request headers (whitelist)**: `Accept`, `Accept-Encoding`, `Accept-Language`, `X-Request-Id`, `Traceparent`, `Tracestate`; `Content-Type` is only forwarded for `POST`/`PUT`/`PATCH`/`DELETE` when the request has a non-empty body. Others—including `X-API-KEY`, `Cookie`, `Authorization`—are stripped. For non-empty bodies, upstream `Content-Type` defaults to `application/json` unless the client already sends `application/json` (e.g. with `charset`), in which case that value is kept. GasFree auth headers (`Timestamp`, `Authorization`) do not include `Content-Type` (it is not part of the HMAC).
- **Response headers**: duplicate names (e.g. multiple `Set-Cookie`) are preserved when building the client response. `Content-Encoding` is not forwarded (httpx already decodes the body into `.content`, so the header would not match the bytes sent to the client).
- Tests: `tests/test_gasfree_open_proxy.py`.

### Example (Minimal Shape)

```yaml
database:
  url: "postgresql+asyncpg://user:password@host:5432/dbname"

facilitator:
  networks:
    tron:nile:
      base_fee:
        USDT: 100

rate_limit:
  api_key_refresh_interval: 60
  authenticated: "1000/minute"
  anonymous: "1/minute"
```

## Secrets Management

You can provide secrets in either of two ways:

1. Local values in `facilitator.config.yaml`
2. 1Password references in `onepassword` section using `vault/item/field`

When using 1Password, set:

- `OP_SERVICE_ACCOUNT_TOKEN`

Typical 1Password keys include:

- `database_password`
- `trongrid_api_key`
- `agent_wallet_password` (loaded on startup into `AGENT_WALLET_PASSWORD`)
- `gasfree_api_key_nile` / `gasfree_api_secret_nile`
- `gasfree_api_key_mainnet` / `gasfree_api_secret_mainnet`
- `gasfree_api_key` / `gasfree_api_secret` as a global fallback

## Wallet Provider Prerequisite

This service no longer manages settlement private keys directly.

Before startup, make sure an active wallet is available through the default `x402` wallet provider resolution flow. In practice that means configuring an `agent-wallet` compatible provider through environment variables or wallet config so that:

- TRON networks can resolve an active `tron` wallet
- BSC / EVM networks can resolve an active `eip155` wallet

If no active wallet is available, the service will fail during startup while initializing facilitator signers. The signer address is also used as the default `feeTo` address for permit-based fee quotes and settlement.

## API Key Authentication and Access Behavior

### How to Send API Key

Use header:

- `X-API-KEY: <your_key>`
- Apply for an API key at: [https://admin-facilitator.bankofai.io](https://admin-facilitator.bankofai.io)

### Key Behavior

- Active API keys are recognized for authenticated access.
- Disabled keys are treated as non-authenticated behavior.
- If no API key is provided, requests are treated as anonymous.

### Rate Limiting

Configured by:

- `rate_limit.authenticated`
- `rate_limit.anonymous`
- `rate_limit.api_key_refresh_interval`

### Caller Notes

If your upstream service calls this facilitator, configure:

- `FACILITATOR_URL`
- `FACILITATOR_API_KEY`

## API Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness check |
| GET | `/supported` | Supported payment capabilities |
| POST | `/fee/quote` | Quote fee for payment requirements |
| POST | `/verify` | Verify payment payload |
| POST | `/settle` | Settle payment on-chain |
| GET | `/payments/{payment_id}` | Query payment records by payment ID |
| GET | `/payments/tx/{tx_hash}` | Query payment records by transaction hash |

## Payment Record Queries

Both query endpoints return a JSON array ordered from latest to oldest.

Each record contains:

- `paymentId` (nullable)
- `txHash`
- `status`
- `createdAt`

If no records are found, the service returns `404`.

## API Key Data Model (Operational)

Facilitator uses seller and API key tables for client-level access behavior.

Key points:

- Seller identity is stored in `sellers`
- API keys are stored in `api_keys_plus`
- Only active API keys are used for authenticated behavior

For onboarding, create seller and API key records that match your client management process.

## Docker

```bash
docker build -t x402-facilitator .

docker run -p 8001:8001 \
  -e AGENT_WALLET_PRIVATE_KEY="" \
  -e OP_SERVICE_ACCOUNT_TOKEN="" \
  -v $(pwd)/config/facilitator.config.yaml:/app/config/facilitator.config.yaml:ro \
  -v $(pwd)/logs:/app/logs \
  x402-facilitator
```

## Logging

Log files are written under `logs/`.

## Project Layout

```text
x402-facilitator/
├── config/
├── scripts/
├── src/
├── tests/
├── Dockerfile
└── requirements.txt
```
