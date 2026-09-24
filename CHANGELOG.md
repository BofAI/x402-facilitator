# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  replace Owner/recipient placeholders and provision the restricted signer before
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
