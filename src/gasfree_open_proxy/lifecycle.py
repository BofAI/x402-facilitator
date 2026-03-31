"""Attach GasFree open-proxy settings during app lifespan (no YAML parsing here)."""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI

from gasfree_open_proxy.state import GasFreeOpenProxySettings


async def init_gasfree_open_proxy_state(app: FastAPI, config: Any) -> None:
    nile_key, nile_secret = await config.get_gasfree_api_credentials("tron:nile")
    main_key, main_secret = await config.get_gasfree_api_credentials("tron:mainnet")

    app.state.gasfree_open_proxy = GasFreeOpenProxySettings(
        nile_creds=(nile_key, nile_secret) if nile_key and nile_secret else None,
        mainnet_creds=(main_key, main_secret) if main_key and main_secret else None,
        upstream_nile=os.environ.get("UPSTREAM_NILE_BASE", "https://open-test.gasfree.io").rstrip("/"),
        upstream_mainnet=os.environ.get("UPSTREAM_MAINNET_BASE", "https://open.gasfree.io").rstrip("/"),
    )
