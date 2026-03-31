"""GasFree Open API HMAC signing (aligned with gasfree-demo api-tests/common.mjs)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import time


def generate_api_signature(method: str, path: str, timestamp: int, api_secret: str) -> str:
    """HMAC-SHA256(method + path + timestamp), Base64 digest (no padding changes vs Node)."""
    message = f"{method.upper()}{path}{timestamp}"
    digest = hmac.new(api_secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).digest()
    return base64.b64encode(digest).decode("ascii")


def build_auth_headers(
    method: str,
    path: str,
    api_key: str,
    api_secret: str,
    timestamp: int | None = None,
) -> dict[str, str]:
    """Headers required by GasFree Open API for the outgoing request."""
    ts = int(time.time()) if timestamp is None else timestamp
    sig = generate_api_signature(method, path, ts, api_secret)
    return {
        "Content-Type": "application/json",
        "Timestamp": str(ts),
        "Authorization": f"ApiKey {api_key}:{sig}",
    }
