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
- Settlement private key per enabled network
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
3. For each enabled network:
- `fee_to_address`
- `private_key` or corresponding 1Password secret reference

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

### Example (Minimal Shape)

```yaml
database:
  url: "postgresql+asyncpg://user:password@host:5432/dbname"

facilitator:
  networks:
    tron:nile:
      fee_to_address: "T..."
      base_fee:
        USDT: 100
      private_key: "hex_private_key"

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

- Per-network private key: `<network_id_with_colon_replaced>_private_key`
- `database_password`
- `trongrid_api_key`

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
