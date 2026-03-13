#!/usr/bin/env bash
set -euo pipefail

docker run -d \
  --name x402-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=facilitator \
  -p 5432:5432 \
  postgres:16