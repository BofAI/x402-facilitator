## Summary

<!-- What changed and why? -->

## Branch routing

- [ ] Normal work uses `feature/* -> develop`.
- [ ] Release work uses `release_vX.Y.Z -> main`.
- [ ] Hotfix work uses `hotfix/* -> main`.

## Validation

- [ ] Production dependency audit passes.
- [ ] Lint, typecheck, tests, and build pass.
- [ ] New or changed behavior has appropriate tests.
- [ ] Docker build passes, or container behavior is not affected.
- [ ] Configuration, database, metrics, and deployment effects are documented.
- [ ] User- or operator-visible changes are recorded under `Unreleased`.
- [ ] No wallet material, secrets, or production credentials are included.
- [ ] Live-chain validation is documented, or explicitly marked as not run.

## Release-only checks

<!-- Required only for release and hotfix pull requests. -->

- [ ] `package.json` and `package-lock.json` use the release version.
- [ ] `CHANGELOG.md` has a dated section for the release.
- [ ] The release candidate and final Docker tag plan is documented.

