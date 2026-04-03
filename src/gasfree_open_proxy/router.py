"""FastAPI routes: transparent proxy to GasFree Open API."""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Request, Response

from gasfree_open_proxy.mapping import resolve_upstream
from gasfree_open_proxy.signing import build_auth_headers
from gasfree_open_proxy.state import GasFreeOpenProxySettings

logger = logging.getLogger(__name__)

_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")

_HOP_BY_HOP: frozenset[bytes] = frozenset(
    {
        b"host",
        b"connection",
        b"keep-alive",
        b"proxy-authenticate",
        b"proxy-authorization",
        b"te",
        b"trailers",
        b"transfer-encoding",
        b"upgrade",
    }
)

# Default-deny: only forward headers safe to send to a third-party Open API.
# content-type: only collected when request has a body (see _collect_allowed_request_headers).
_ALLOWED_REQUEST_HEADER_NAMES: frozenset[bytes] = frozenset(
    {
        b"accept",
        b"accept-encoding",
        b"accept-language",
        b"content-type",
        b"x-request-id",
        b"traceparent",
        b"tracestate",
    }
)

_METHODS_TYPICALLY_WITH_BODY: frozenset[str] = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Strip hop-by-hop / entity framing from upstream response; drop content-length (recomputed).
# content-encoding: httpx decodes gzip/br into .content; forwarding the header would lie about the body.
_RESPONSE_STRIP_NAMES: frozenset[str] = frozenset(
    {"transfer-encoding", "connection", "content-length", "content-encoding"}
)

router = APIRouter(tags=["gasfree-open-proxy"])


def _decode_header_pair(k: bytes, v: bytes) -> tuple[str, str]:
    try:
        return k.decode("latin-1"), v.decode("latin-1")
    except UnicodeDecodeError:
        return k.decode("latin-1"), v.decode("latin-1", errors="replace")


def _collect_allowed_request_headers(request: Request, body: bytes) -> list[tuple[str, str]]:
    """Headers the client may send upstream (whitelist)."""
    pairs: list[tuple[str, str]] = []
    forward_content_type = (
        len(body) > 0
        and request.method.upper() in _METHODS_TYPICALLY_WITH_BODY
    )
    for k, v in request.headers.raw:
        lk = k.lower()
        if lk in _HOP_BY_HOP or lk in (b"host", b"content-length"):
            continue
        if lk not in _ALLOWED_REQUEST_HEADER_NAMES:
            continue
        if lk == b"content-type" and not forward_content_type:
            continue
        pairs.append(_decode_header_pair(k, v))
    return pairs


def _ensure_json_content_type_for_gasfree(pairs: list[tuple[str, str]], body: bytes) -> None:
    """Non-empty body: require application/json for GasFree; preserve client charset if already JSON."""
    if not body:
        return
    without_ct = [(k, v) for k, v in pairs if k.lower() != "content-type"]
    ct_client = next((v for k, v in pairs if k.lower() == "content-type"), None)
    pairs.clear()
    pairs.extend(without_ct)
    if ct_client is not None:
        media = ct_client.split(";")[0].strip().lower()
        if media == "application/json":
            pairs.append(("Content-Type", ct_client))
            return
    pairs.append(("Content-Type", "application/json"))


def _merge_request_headers(
    allowed_pairs: list[tuple[str, str]],
    auth_headers: dict[str, str],
) -> list[tuple[str, str]]:
    """Auth headers override same-named client headers (case-insensitive)."""
    auth_keys_lower = {k.lower() for k in auth_headers}
    out = [(k, v) for k, v in allowed_pairs if k.lower() not in auth_keys_lower]
    out.extend(auth_headers.items())
    return out


def _build_upstream_response_raw_headers(upstream: httpx.Response, body: bytes) -> list[tuple[bytes, bytes]]:
    """Preserve duplicate header names (e.g. multiple Set-Cookie); recompute content-length."""
    raw: list[tuple[bytes, bytes]] = []
    for key, value in upstream.headers.multi_items():
        lk = key.lower()
        if lk in _RESPONSE_STRIP_NAMES:
            continue
        raw.append((key.lower().encode("latin-1"), value.encode("latin-1")))

    status = upstream.status_code
    if not (status < 200 or status in (204, 304)):
        raw.append((b"content-length", str(len(body)).encode("latin-1")))

    return raw


@router.api_route("/mainnet", methods=list(_METHODS))
@router.api_route("/mainnet/{full_path:path}", methods=list(_METHODS))
async def proxy_mainnet(request: Request, full_path: str = "") -> Response:  # noqa: ARG001
    return await _proxy_request(request)


@router.api_route("/nile", methods=list(_METHODS))
@router.api_route("/nile/{full_path:path}", methods=list(_METHODS))
async def proxy_nile(request: Request, full_path: str = "") -> Response:  # noqa: ARG001
    return await _proxy_request(request)


async def _proxy_request(request: Request) -> Response:
    settings: GasFreeOpenProxySettings | None = getattr(request.app.state, "gasfree_open_proxy", None)
    if settings is None:
        return Response(
            status_code=503,
            content=b'{"detail":"gasfree_open_proxy not initialized"}',
            media_type="application/json",
        )

    client_path = request.url.path
    resolved = resolve_upstream(
        client_path,
        settings.upstream_mainnet,
        settings.upstream_nile,
    )
    if resolved is None:
        return Response(
            status_code=404,
            content=(
                b'{"error":"unknown_prefix","message":'
                b'"Use /mainnet/... or /nile/... (maps to official /tron/... and /nile/...)"}'
            ),
            media_type="application/json",
        )

    upstream_base, upstream_path, profile = resolved
    creds = settings.mainnet_creds if profile == "mainnet" else settings.nile_creds
    if creds is None:
        return Response(
            status_code=503,
            content=(
                b'{"detail":"GasFree API credentials not configured for this environment '
                b'(tron:mainnet or tron:nile)"}'
            ),
            media_type="application/json",
        )

    api_key, api_secret = creds
    auth_headers = build_auth_headers(request.method, upstream_path, api_key, api_secret)

    query = request.url.query
    upstream_url = f"{upstream_base}{upstream_path}"
    if query:
        upstream_url = f"{upstream_url}?{query}"

    body = await request.body()

    header_pairs = _merge_request_headers(
        _collect_allowed_request_headers(request, body),
        auth_headers,
    )
    _ensure_json_content_type_for_gasfree(header_pairs, body)

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            upstream_resp = await client.request(
                request.method,
                upstream_url,
                headers=header_pairs,
                content=body if body else None,
            )
    except httpx.RequestError as exc:
        logger.warning("GasFree open proxy upstream error: %s", exc)
        return Response(
            status_code=502,
            content=b'{"detail":"Bad gateway: upstream request failed"}',
            media_type="application/json",
        )

    resp_body = upstream_resp.content
    raw_headers = _build_upstream_response_raw_headers(upstream_resp, resp_body)

    out = Response(content=resp_body, status_code=upstream_resp.status_code)
    out.raw_headers = raw_headers
    return out
