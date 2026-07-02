"""Client path (/mainnet, /nile) to official upstream base + path (/tron, /nile)."""

from __future__ import annotations

from typing import Literal, Optional

Profile = Literal["mainnet", "nile"]


def _collapse_path(path: str) -> str:
    parts = [p for p in path.split("/") if p]
    out = "/" + "/".join(parts)
    if out == "/tron":
        return "/tron/"
    if out == "/nile":
        return "/nile/"
    return out


def resolve_upstream(
    client_path: str,
    upstream_mainnet: str,
    upstream_nile: str,
) -> Optional[tuple[str, str, Profile]]:
    """
    Returns (upstream_base, upstream_path, profile) or None if path is not under /mainnet or /nile.

    upstream_path is used for both the request URL path and HMAC signing (no query).
    """
    raw = client_path if client_path.startswith("/") else f"/{client_path}"
    path = raw.rstrip("/") if len(raw) > 1 else raw

    if path == "/mainnet" or path.startswith("/mainnet/"):
        rest = path[len("/mainnet") :]
        if not rest:
            upstream_path = "/tron/"
        else:
            suffix = rest if rest.startswith("/") else f"/{rest}"
            upstream_path = _collapse_path("/tron" + suffix)
        return upstream_mainnet.rstrip("/"), upstream_path, "mainnet"

    if path == "/nile" or path.startswith("/nile/"):
        rest = path[len("/nile") :]
        if not rest:
            upstream_path = "/nile/"
        else:
            suffix = rest if rest.startswith("/") else f"/{rest}"
            upstream_path = _collapse_path("/nile" + suffix)
        return upstream_nile.rstrip("/"), upstream_path, "nile"

    return None
