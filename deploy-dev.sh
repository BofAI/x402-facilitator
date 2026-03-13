#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REMOTE_HOST="${REMOTE_HOST:-ubuntu@54.234.160.122}"
REMOTE_KEY="${REMOTE_KEY:-$HOME/pem/prason.pem}"
REMOTE_BASE_DIR="${REMOTE_BASE_DIR:-/home/ubuntu/app/x402-facilitator}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-${REMOTE_BASE_DIR}/repo}"
REMOTE_CONTAINER_NAME="${REMOTE_CONTAINER_NAME:-x402-facilitator-dev}"
REMOTE_IMAGE_NAME="${REMOTE_IMAGE_NAME:-x402-facilitator:dev}"
REMOTE_CONFIG_PATH="${REMOTE_CONFIG_PATH:-${REMOTE_APP_DIR}/config/facilitator.config.yaml}"
CONTAINER_CONFIG_PATH="${CONTAINER_CONFIG_PATH:-/app/config/facilitator.config.yaml}"
REMOTE_DOCKER_BIN="${REMOTE_DOCKER_BIN:-docker}"
REMOTE_NETWORK_MODE="${REMOTE_NETWORK_MODE:-host}"
REMOTE_PG_CONTAINER_NAME="${REMOTE_PG_CONTAINER_NAME:-x402-postgres}"
START_REMOTE_POSTGRES="${START_REMOTE_POSTGRES:-1}"

echo "Syncing project to ${REMOTE_HOST}:${REMOTE_APP_DIR}"
rsync -avz --delete -e "ssh -i ${REMOTE_KEY}" \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='.git' \
  --exclude='*.log' \
  --exclude='.files' \
  --exclude='uv.lock' \
  --exclude='.venv' \
  --exclude='.idea' \
  --exclude='local_db' \
  --exclude='.pytest_cache' \
  --exclude='htmlcov' \
  --exclude='.coverage' \
  --exclude='.env' \
  --exclude='logs' \
  "${ROOT_DIR}/" "${REMOTE_HOST}:${REMOTE_APP_DIR}/"

echo "Building and restarting container on remote host"
ssh -i "${REMOTE_KEY}" "${REMOTE_HOST}" "bash -s" <<EOF
set -euo pipefail

mkdir -p "${REMOTE_BASE_DIR}"
mkdir -p "${REMOTE_APP_DIR}"

if [ ! -f "${REMOTE_CONFIG_PATH}" ]; then
  echo "Missing config file: ${REMOTE_CONFIG_PATH}" >&2
  exit 1
fi

cd "${REMOTE_APP_DIR}"

DOCKER_BIN="${REMOTE_DOCKER_BIN}"
if ! ${REMOTE_DOCKER_BIN} info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then
    DOCKER_BIN="sudo docker"
  else
    echo "Cannot access Docker on remote host. Set REMOTE_DOCKER_BIN or configure docker permissions." >&2
    exit 1
  fi
fi

if [ "${START_REMOTE_POSTGRES}" = "1" ] && ! ss -ltn | grep -q ':5432 '; then
  if \${DOCKER_BIN} ps -a --format '{{.Names}}' | grep -Fxq "${REMOTE_PG_CONTAINER_NAME}"; then
    \${DOCKER_BIN} start "${REMOTE_PG_CONTAINER_NAME}" >/dev/null
  else
    \${DOCKER_BIN} run -d \
      --name "${REMOTE_PG_CONTAINER_NAME}" \
      --restart unless-stopped \
      -e POSTGRES_USER=postgres \
      -e POSTGRES_PASSWORD=postgres \
      -e POSTGRES_DB=facilitator \
      -p 5432:5432 \
      postgres:16 >/dev/null
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ss -ltn | grep -q ':5432 '; then
      break
    fi
    sleep 2
  done
fi

\${DOCKER_BIN} build -t "${REMOTE_IMAGE_NAME}" .

if \${DOCKER_BIN} ps -a --format '{{.Names}}' | grep -Fxq "${REMOTE_CONTAINER_NAME}"; then
  \${DOCKER_BIN} rm -f "${REMOTE_CONTAINER_NAME}"
fi

if [ "${REMOTE_NETWORK_MODE}" = "host" ]; then
  \${DOCKER_BIN} run -d \
    --name "${REMOTE_CONTAINER_NAME}" \
    --restart unless-stopped \
    --network host \
    -e CONFIG_PATH="${CONTAINER_CONFIG_PATH}" \
    "${REMOTE_IMAGE_NAME}"
else
  \${DOCKER_BIN} run -d \
    --name "${REMOTE_CONTAINER_NAME}" \
    --restart unless-stopped \
    -p 8001:8001 \
    -p 9001:9001 \
    -e CONFIG_PATH="${CONTAINER_CONFIG_PATH}" \
    "${REMOTE_IMAGE_NAME}"
fi

\${DOCKER_BIN} ps --filter "name=${REMOTE_CONTAINER_NAME}"
EOF

echo "Deployment complete"
