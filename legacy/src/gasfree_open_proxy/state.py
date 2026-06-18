from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class GasFreeOpenProxySettings:
    """Runtime settings attached to FastAPI app.state after lifespan startup."""

    nile_creds: Optional[tuple[str, str]]
    mainnet_creds: Optional[tuple[str, str]]
    upstream_nile: str
    upstream_mainnet: str
