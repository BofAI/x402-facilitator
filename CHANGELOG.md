# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Pin Docker and CI to Node.js 22.23.4 for the October 2026 security fixes.
  Require patched Node.js release lines for source installations.

## [2.2.0] - 2026-10-13

### Fixed

- Preserve the production 5-second API Key refresh cadence and clarify image
  tag channels, environment-specific log mounts and 1Password runtime tokens.

- Require successful packed Approval confirmation before accepting observed
  allowance and continuing settlement, preventing payment from racing Approval.
  No solidification wait is added.

### Changed

- Remove the unused test image channel; retain dev candidate and versioned
  production image tags.

- Confirm TRON resource execution from successful packed FullNode receipts
  without waiting for solidity before Approval. Keep resource visibility checks,
  solidified inventory/expiry recovery and reclaim ordering protections.

## [2.1.13] - 2026-10-13

### Changed

- Resolve database URLs from `onepassword.database_url` through Connect or
  Service Accounts, retain legacy YAML URLs, and fail startup on secret errors.
  Dev and prod now require the respective 1Password `psql/url` field.

- Restore production PostgreSQL endpoint and 1Password credential references,
  configure the operator-provided Nile sponsoring Owner and permission, fill
  resource limits from dev, normalize TRON network IDs, and align production
  logging with the existing `/app/logs` Docker mount.

### Added

- Multi-network TRC-20 resource sponsoring in one process, with per-network
  configuration, request routing, readiness and recovery. Single-network YAML
  remains supported.
- Three-table PostgreSQL sponsoring ledger with YAML-owned permissions and
  limits, deterministic network/Owner namespaces, and transactional migration
  of the previous five-table ledger. Stop old instances before upgrading.
- Removed the obsolete Python implementation under `legacy/`.
- Accept SDK batch claim/settle/refund requests with a zero management timeout.
- Keep unbroadcast approvals in recovery while awaiting chain expiry, without
  reporting the expected wait as a recovery failure.
- Check consumed Permit2 nonces before settlement and coordinate concurrent
  authorization attempts through PostgreSQL advisory locks.

- Resource sponsoring accepts any valid TRON payment recipient. The legacy
  `resource_sponsoring.pay_to` field is accepted but no longer enforced.
- Optional anonymous Nile sponsorship via `resource_sponsoring.require_api_key: false`.
  Dev opts in; production and omitted settings still require API keys. Other networks cannot opt out.
- Independent Redis/Valkey rate-limit passwords via `RATE_LIMIT_REDIS_PASSWORD` or
  `onepassword.redis_password`, including TLS (`rediss://`) connections.
- 1Password Connect secret resolution for development deployments, selected
  explicitly with `onepassword.mode`, using `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN`.
  Production retains Service Account authentication.
- Optional Nile/Shasta TRC-20 Approval resource sponsoring with restricted Owner
  signing, authenticated admission, durable recovery, and resource accounting.
- SQLite single-instance and shared PostgreSQL sponsorship coordinators, with
  Owner-scoped locking and recovery isolation.

### Changed

- Use published stable SDK releases: x402-core 1.1.1, x402-tron 2.0.0 and
  x402-evm 1.1.1, retaining x402-extensions 1.2.0 and Agent Wallet 3.0.0.
- Upgraded Agent Wallet to 3.0.0.
- Prepared the development and production configs for Nile-only PostgreSQL sponsorship; operators must
  replace the Owner placeholder and provision the restricted signer before
  startup. Other configured payment networks and GasFree remain available.

- Adopted the `develop` integration branch and explicit feature, release, and
  hotfix pull request routes.
- Documented version preparation and test/final Docker image release flows.
- Extended CI governance to `develop` and `main`.
- Required release and test tags to match the service package version before
  publishing a container image.
- Kept automatic Audit disabled by default while preserving authorized manual
  `/audit-pr` requests.
- Limited Audit archives to tracked, non-symbolic-link files.
- Aligned service package metadata with the existing stable `v2.1.0` tag.

Historical changes before this workflow was adopted are recorded in Git tags
and GitHub releases.
