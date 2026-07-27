# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Multi-chain **HTTP 402 Payment Required** facilitator: it verifies payment payloads off-chain and settles them on-chain. This is **v2**, a full TypeScript rewrite of the Python/FastAPI v1 that still lives under [`legacy/`](legacy/). v2 changed runtime (Python → Node 22 / TS), SDK (→ `@bankofai/x402-*`), and the payment scheme wire format (hard cutover, not back-compatible).

`legacy/` is kept only as a behavioral reference — many v2 modules are deliberate ports of a `legacy/src/*.py` file and say so in their header comment. When comparing v2 against legacy, judge correctness on the merits: legacy may have its own bugs and is not ground truth.

## Commands

```bash
npm run dev          # tsx watch (reload on change)
npm run build        # tsc -> dist/
npm start            # run compiled dist/index.js
npm run typecheck    # tsc --noEmit — the primary static check (see lint note below)
npm test             # vitest run (37 tests, no DB required)
npm test -- test/settlement.test.ts          # single file
npm test -- -t "applies the authenticated tier"   # single test by name
```

Before running, copy the config template: `cp config/facilitator.config.example.yaml config/facilitator.config.yaml`.

**Lint:** `npm run lint` references eslint, but eslint is **not installed and not configured** — the script does not work. Use `npm run typecheck` as the static check. CI (`.github/workflows/ci.yml`, `lint-and-test` job) runs `npm ci` → `typecheck` → `test`.

## Architecture

Startup is orchestrated in `src/index.ts` and mirrors v1's lifespan:
**load config → resolve secrets → init DB → start API-key refresher → inject TronGrid key → build & register facilitator → wire GasFree proxy → serve HTTP**.

Key seams:

- **`src/facilitator.ts`** is the heart. It builds the SDK's `x402Facilitator` via `createFacilitator()` and registers scheme handlers per enabled network. Each network's `schemes` list (default: all schemes) selects what to register: `exact` (TRON eip3009/permit2, +`exact_gasfree` when creds resolve; EVM eip3009/permit2), `upto` (Permit2 up-to-max), `batch-settlement` (channel deposit/voucher/claim). TRON and EVM have symmetric `register*Network` handlers; TRON `exact` has a GasFree variant, EVM `exact` does not.

- **Non-custodial signing (`src/signer.ts`)** — this process **never holds settlement private keys**. Wallets resolve through `@bankofai/agent-wallet` (unlocked out-of-band via `AGENT_WALLET_PASSWORD`); the SDK builds the tx, hands it to the wallet to sign, then broadcasts — the raw key never enters the SDK. For `batch-settlement`, the same agent-wallet doubles as the `receiverAuthorizer` (signs TIP-712/EIP-712 digests).

- **GasFree proxy** — the SDK's GasFree client does no HMAC auth of its own. It is pointed at this service's **co-located** proxy (`/nile`, `/mainnet` in `src/gasfree-proxy.ts`), which adds HMAC and forwards to the official relayer. `src/index.ts` wires the client's base URL back to `http://127.0.0.1:<port>/<network>`, and only enables it per-network when credentials are present.

- **HTTP surface (`src/server.ts`)** — Hono app. Middleware order: Prometheus metrics (outermost) → CORS → API-key auth; `/settle` additionally gets the dynamic rate limiter. `/settle` settles first, then persists one settlement row; **save failure never affects the response** (intentional v1 ordering).

- **Auth (`src/auth.ts`)** is **advisory, not a hard gate** — anonymous requests are allowed at the anonymous rate. A valid `X-API-KEY` selects the authenticated rate tier and scopes payment lookups to that seller. Keys are held in an in-memory cache refreshed periodically from the DB, checked in constant time.

- **Config & secrets (`src/config.ts`)** — `FACILITATOR_SERVICE_ENV=dev|prod` selects the matching baked-in YAML; `FACILITATOR_CONFIG_PATH` is an explicit override. Secrets resolve **env first, then 1Password**: any `onepassword.*` value is a `vault/item/field` ref resolved when `OP_SERVICE_ACCOUNT_TOKEN` / `onepassword.token` is set. A network listed under `facilitator.networks` is enabled.

- **Database (`src/db/`, drizzle + `pg`)** — v2 owns a new `settlements` table (created on startup), keyed on the on-chain **authorization identity** `(network, scheme, asset, payer, nonce)`, with a partial-unique index enforcing one successful settlement per authorization. The shared `sellers` / `api_keys_plus` tables are reused unchanged. v1's `payment_records` is unused.

## Conventions & gotchas

- Networks use supported canonical **CAIP-2** ids only (for example `tron:0xcd8690dc`, `tron:0x2b6653dc`, `eip155:97`, `eip155:84532`). Friendly aliases are rejected; `facilitator.ts` routes by the registered network family.
- The `@bankofai/x402-*` packages (`x402-core`, `x402-evm`, `x402-tron`, `x402-extensions`) come from the npm registry. Pin to the tested version deliberately — bumping is a separate, deliberate upgrade (API drift risk). When the SDK's interface is awkward, surface the gap rather than silently `any`-adapting around it.
- Fees were removed from the TRON schemes in SDK `1.0.1`; there is no `base_fee` config and no `/fee/quote` endpoint.
- Stale Python artifacts (`src/**/__pycache__`, `tests/__pycache__`) are leftovers from v1 — ignore them; the live tests are TS files under `test/`.
- Status: feature-complete and unit-tested, but **not yet validated against live chains** and no integration tests yet.
