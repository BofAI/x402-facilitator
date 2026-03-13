#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIREMENTS_FILE="${ROOT_DIR}/requirements.txt"

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "Python is not installed or not in PATH." >&2
  exit 1
fi

if [[ -f "${REQUIREMENTS_FILE}" ]]; then
  exec "${PYTHON_BIN}" -m pip install -r "${REQUIREMENTS_FILE}"
fi
