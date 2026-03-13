#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "Python is not installed or not in PATH." >&2
  exit 1
fi

if [[ -n "${PYTHONPATH:-}" ]]; then
  export PYTHONPATH="${ROOT_DIR}:${PYTHONPATH}"
else
  export PYTHONPATH="${ROOT_DIR}"
fi

if [[ -z "${CONFIG_PATH:-}" ]]; then
  if [[ -f "${ROOT_DIR}/config/facilitator.config.yaml" ]]; then
    export CONFIG_PATH="${ROOT_DIR}/config/facilitator.config.yaml"
  elif [[ -f "${ROOT_DIR}/facilitator.config.yaml" ]]; then
    export CONFIG_PATH="${ROOT_DIR}/facilitator.config.yaml"
  fi
fi

exec "${PYTHON_BIN}" "${ROOT_DIR}/src/main.py"
