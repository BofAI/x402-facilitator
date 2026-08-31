# Contributing

Thank you for contributing to the x402 Facilitator.

## Development workflow

1. Fork or clone the repository and add the upstream remote.
2. Synchronize `develop`.
3. Create `feature/<short-description>` from `develop`.
4. Make a focused change with tests and operational documentation.
5. Open a pull request to `develop`.

See [BRANCHING.md](./BRANCHING.md) for release and hotfix workflows.

## Checks

Run the same checks as CI:

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run lint
npm run typecheck
npm test
npm run build
```

Build the container when changing the Dockerfile, runtime configuration, or
startup behavior:

```bash
docker build -t x402-facilitator:local .
```

## Service changes

- Add tests for payment verification, settlement, authorization, rate limiting,
  persistence, and validation behavior whenever those paths change.
- Keep network identifiers canonical CAIP-2 values.
- Treat SDK dependency bumps as deliberate compatibility changes.
- Document database, configuration, secret, port, metric, and deployment
  changes in the pull request and README where applicable.
- Never commit wallet material, API keys, 1Password tokens, database
  credentials, or environment-specific `facilitator.config.yaml` files.
- Do not claim live-chain validation unless the exact network and transaction
  evidence are recorded.

## Versions and changelog

- Do not edit the service version in a normal feature pull request.
- Add operator- or user-visible changes to `CHANGELOG.md` under `Unreleased`.
- Maintainers update `package.json`, `package-lock.json`, and the dated
  changelog section together on a `release_vX.Y.Z` or `hotfix/*` branch.

