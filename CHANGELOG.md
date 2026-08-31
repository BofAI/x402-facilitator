# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
