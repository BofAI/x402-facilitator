# Branching and Release Workflow

This repository uses `develop` for integration and `main` for stable,
deployable releases.

## Branch roles

| Branch | Purpose | Merge target |
| --- | --- | --- |
| `main` | Stable source corresponding to released container images | — |
| `develop` | Integration branch for the next release | `main` through a release branch |
| `feature/*` | Normal features, fixes, tests, and documentation | `develop` |
| `release_vX.Y.Z` | Release stabilization and version preparation | `main`, then back to `develop` |
| `hotfix/*` | Urgent fixes based on the current stable release | `main`, then back to `develop` |

Do not push directly to `main` or `develop`.

## Normal development

1. Synchronize the local `develop` branch.
2. Create `feature/<short-description>` from `develop`.
3. Implement and test the change.
4. Open a pull request from `feature/*` to `develop`.
5. Record operator- or user-visible changes under `Unreleased` in
   `CHANGELOG.md`.

Normal feature pull requests must not change the service version.

## Release

1. Create `release_vX.Y.Z` from `develop`.
2. On the release branch:
   - run `npm version X.Y.Z --no-git-tag-version` so `package.json` and
     `package-lock.json` stay synchronized;
   - move relevant `CHANGELOG.md` entries from `Unreleased` into a dated
     `X.Y.Z` section;
   - make only stabilization changes required for the release.
3. Run the release checks:

   ```bash
   npm ci
   npm audit --omit=dev --audit-level=high
   npm run lint
   npm run typecheck
   npm test
   npm run build
   docker build -t x402-facilitator:release-candidate .
   ```

4. If a deployed release candidate is needed, tag the release commit as
   `test-vX.Y.Z` and push the tag. CI publishes it as
   `bankofai/x402-tron-facilitator:test`. Treat this tag as mutable
   pre-release infrastructure, not a stable release.
5. Open a pull request from `release_vX.Y.Z` to `main`.
6. After merge, create and push the immutable `vX.Y.Z` tag. CI builds and
   publishes `bankofai/x402-tron-facilitator:vX.Y.Z`.
7. Create the GitHub release notes, then merge the same release branch back into
   `develop`. Keep the branch until that back-merge is complete.

Version changes happen in step 2, not in ordinary feature pull requests.

## Hotfix

1. Create `hotfix/<short-description>` from `main`.
2. Apply the smallest safe fix and prepare a patch version using the same
   version, changelog, validation, tag, and deployment steps as a normal
   release.
3. Open the hotfix pull request to `main`.
4. After merge and release, merge the hotfix branch back into `develop`.

## Repository settings

Configure GitHub after the branches and workflows are pushed:

- Set `develop` as the default branch.
- Protect both `develop` and `main`; require pull requests, one approval,
  and passing `Branch policy` and `lint-and-test` checks.
- Restrict branch deletion, direct updates, and force pushes.
- Keep automatic Audit disabled by leaving `AUDIT_AUTO_ENABLED` unset or set
  to a value other than `true`. Authorized users can still request an audit
  with `/audit-pr`.

