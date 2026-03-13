# X402 Facilitator

X402 Facilitator is a **general-purpose, multi-chain** service that implements the **X402 (HTTP 402 Payment Required)** protocol. It supports multiple chains and networks (currently TRON and BSC) and provides a standard interface for backend services to handle off-chain payment verification and on-chain settlement, enabling seamless "Pay-as-you-go" mechanisms for digital resources.

## 🚀 Key Features

- **Multi-Chain & Multi-Network**: Supports TRON and BSC; add networks via config—no code change required.
- **Payment Verification**: Robust verification of payment payloads off-chain.
- **On-Chain Settlement**: Settles payments on supported blockchains; per-network signer and fee config.
- **Dynamic Fee Quoting**: Provides real-time fee quotes based on payment 
requirements.
- **FastAPI Powered**: High-performance, production-ready REST API.
- **API Key Authentication**: X-API-KEY header support with tiered rate limiting
- **1Password Integration**: Store private key, database password, and other secrets in 1Password

## Prerequisites

- Python 3.10+
- PostgreSQL database
- Per-network wallet private key(s) for settlement signing (one per chain/network you enable)
- 1Password or local config (private key, database password, etc.)

## Configuration

Config file: `config/facilitator.config.yaml`. See `config/facilitator.config.example.yaml` for reference.

### Required

Add any networks you need under `facilitator.networks`; each has `fee_to_address`, `base_fee`, and `private_key` (or 1Password). Example:

```yaml
database:
  url: ""
  password: "your_password"   # Local dev: set directly; or use database_password_item for 1Password

facilitator:
  trongrid_api_key: ""        # For TRON networks only (optional; or 1Password)
  networks:                   # Per-network config; listed = enabled. TRON, BSC, etc.
    tron:nile:
      fee_to_address: "T..."
      base_fee: { USDT: 100 }
      private_key: "hex..."   # Or use onepassword.<network_id>.privatekey_item as fallback
    tron:mainnet:
      fee_to_address: "T..."
      base_fee: { USDT: 100 }
      private_key: ""
```

### Secrets: 1Password or Local

Each 1Password entry is a single string: **`vault/item/field`** (same as `op://` reference without the prefix).

- **Private Key**: `facilitator.networks.<network_id>.private_key` per network, or `onepassword.<network>_private_key` = `"vault/item/field"` (e.g. `onepassword.tron_nile_private_key`, `onepassword.bsc_testnet_private_key`; key = network id with `:` → `_` + `_private_key`).
- **Database Password**: `database.password` or `onepassword.database_password` = `"vault/item/field"`.
- **TronGrid API Key** (TRON only): `facilitator.trongrid_api_key` or `onepassword.trongrid_api_key` = `"vault/item/field"`.

Set `OP_SERVICE_ACCOUNT_TOKEN` when using 1Password.

### Database Connection Pool (Optional)

```yaml
database:
  ssl_mode: "disable"     # disable | require | verify-ca | verify-full
  max_open_conns: 25
  max_idle_conns: 15
  max_life_time: 600
```

## Installation & Running

```bash
# Install dependencies
pip install -r requirements.txt

# Copy and edit config
cp config/facilitator.config.example.yaml config/facilitator.config.yaml

# Start
python src/main.py
```

Listens on `http://0.0.0.0:8001` by default.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/supported` | Supported network/scheme and fee info |
| POST | `/fee/quote` | Get payment fee quote |
| POST | `/verify` | Off-chain verification of payment signature |
| POST | `/settle` | On-chain settlement |
| GET | `/payments/{payment_id}` | Query settlement records by payment ID (returns list, optionally filtered by API key's seller) |
| GET | `/payments/tx/{tx_hash}` | Query settlement records by transaction hash (returns list, optionally filtered by API key's seller) |
| GET | `/health` | Health check |

Both payment query endpoints return a JSON array of `PaymentRecordResponse` objects, ordered from latest to oldest.  
Each record includes:

- `paymentId`: Payment identifier (may be `null` if unavailable)
- `txHash`: Transaction hash
- `status`: `"success"` or `"failed"`
- `createdAt`: Record creation timestamp (ISO 8601)
- `sellerId`: Seller identifier associated with the API key (may be `null`)
- `network`: Network identifier (e.g. `mainnet`, `nile`, `shasta`, `bsc:testnet`; may be `null`)

## API Key Authentication

Callers must include `X-API-KEY` in request headers, matching a key in the `api_keys_plus` table. Authenticated requests use `rate_limit_authenticated`; anonymous requests use `rate_limit_anonymous`.

### Adding an API Key

The `sellers` and `api_keys_plus` tables are created automatically on first startup.

To onboard a new client:

1. Insert a row into `sellers` with a unique `seller_id`.
2. Insert one or more rows into `api_keys_plus` with the same `seller_id` and distinct `key` values.

Payment query endpoints will automatically scope results to the `seller_id` associated with the provided `X-API-KEY`.

## Docker

```bash
# Build
docker build -t x402-facilitator .

# Run (mount config)
docker run -p 8001:8001 \
  -e OP_SERVICE_ACCOUNT_TOKEN="" \
  -v $(pwd)/config/facilitator.config.yaml:/app/config/facilitator.config.yaml:ro \
  -v $(pwd)/logs:/app/logs \
  x402-facilitator
```

Images are published to [Docker Hub](https://hub.docker.com/u/bankofai) as `bankofai/x402-tron-facilitator` (general-purpose multi-chain X402 Facilitator). CI builds on push to main/master or `v*` tags.

## Logging

Logs are written to `logs/x402-facilitator.{date}_{time}.log`, with a new file per startup. 

## Caller Configuration

Servers that call the facilitator (e.g. resource servers using X402) must configure:

- `FACILITATOR_URL`: Facilitator URL, **use https** 
- `FACILITATOR_API_KEY`: Key that exists in the facilitator's `api_keys_plus` table

## Project Structure

```
x402-facilitator/
├── config/           # Config examples
├── scripts/          # register_seller and other scripts
├── src/              # Source code
│   ├── main.py       # Entry point
│   ├── config.py     # Config loading
│   ├── database.py   # Database
│   ├── auth.py       # API Key & rate limiting
│   └── ...
├── Dockerfile
└── requirements.txt
```
