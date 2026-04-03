"""Unit and lightweight integration tests for gasfree_open_proxy (isolated from facilitator flows)."""

from __future__ import annotations

import base64
import gzip
import hashlib
import hmac
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from fastapi import FastAPI

from gasfree_open_proxy.mapping import resolve_upstream
from gasfree_open_proxy.signing import generate_api_signature
from gasfree_open_proxy.state import GasFreeOpenProxySettings


def _node_style_signature(method: str, path: str, timestamp: int, secret: str) -> str:
    """Mirror Node crypto.createHmac('sha256', secret).update(message).digest('base64')."""
    msg = f"{method.upper()}{path}{timestamp}"
    digest = hmac.new(secret.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).digest()
    return base64.b64encode(digest).decode("ascii")


@pytest.mark.parametrize(
    "method,path,ts,secret",
    [
        ("GET", "/nile/api/v1/config/token/all", 1700000000, "test-secret"),
        ("POST", "/tron/api/v1/gasfree/submit", 1735689600, "rPX7NXuJQUhbnS_ApFoB79WnKWzzXTwHqbovgGdKwmg"),
    ],
)
def test_signature_matches_node_style_hmac(method: str, path: str, ts: int, secret: str) -> None:
    assert generate_api_signature(method, path, ts, secret) == _node_style_signature(method, path, ts, secret)


@pytest.mark.parametrize(
    "client_path,expected_upstream_path",
    [
        ("/mainnet", "/tron/"),
        ("/mainnet/", "/tron/"),
        ("/mainnet/api/v1/foo", "/tron/api/v1/foo"),
        ("/nile", "/nile/"),
        ("/nile/api/v1/config/token/all", "/nile/api/v1/config/token/all"),
    ],
)
def test_resolve_upstream_paths(client_path: str, expected_upstream_path: str) -> None:
    um = "https://open.gasfree.io"
    un = "https://open-test.gasfree.io"
    out = resolve_upstream(client_path, um, un)
    assert out is not None
    base, path, profile = out
    assert path == expected_upstream_path
    if profile == "mainnet":
        assert base == um
    else:
        assert base == un


def test_resolve_upstream_unknown() -> None:
    assert resolve_upstream("/verify", "https://a.io", "https://b.io") is None


def test_proxy_forwards_gasfree_auth_and_strips_client_authorization(mocker) -> None:
    from fastapi.testclient import TestClient
    from gasfree_open_proxy.router import router

    app = FastAPI()
    app.state.gasfree_open_proxy = GasFreeOpenProxySettings(
        nile_creds=("gf-key", "gf-secret"),
        mainnet_creds=None,
        upstream_nile="https://open-test.gasfree.io",
        upstream_mainnet="https://open.gasfree.io",
    )
    app.include_router(router)

    mock_resp = httpx.Response(200, content=b'{"ok":true}', headers={"content-type": "application/json"})
    request_mock = AsyncMock(return_value=mock_resp)
    inner_client = MagicMock()
    inner_client.request = request_mock
    client_cm = MagicMock()
    client_cm.__aenter__ = AsyncMock(return_value=inner_client)
    client_cm.__aexit__ = AsyncMock(return_value=None)
    mocker.patch("gasfree_open_proxy.router.httpx.AsyncClient", return_value=client_cm)

    with TestClient(app) as tc:
        tc.get(
            "/nile/api/v1/config/token/all",
            headers={
                "Authorization": "Bearer user-token",
                "Accept": "application/json",
                "X-API-KEY": "facilitator-secret-must-not-leak",
                "Cookie": "session=evil",
                "X-Custom": "1",
            },
        )

    request_mock.assert_awaited_once()
    call_kw = request_mock.await_args
    assert call_kw.args[0] == "GET"
    assert call_kw.args[1] == "https://open-test.gasfree.io/nile/api/v1/config/token/all"
    sent = call_kw.kwargs["headers"]
    # httpx accepts list[tuple[str,str]] — normalize to dict for single-value assertions
    sent_dict = dict(sent) if isinstance(sent, list) else sent
    assert sent_dict["Authorization"].startswith("ApiKey gf-key:")
    assert "Timestamp" in sent_dict
    assert sent_dict.get("accept") == "application/json"
    assert "Bearer" not in sent_dict["Authorization"]
    assert "x-api-key" not in {k.lower() for k in sent_dict}
    assert "cookie" not in {k.lower() for k in sent_dict}
    assert "x-custom" not in {k.lower() for k in sent_dict}
    assert "content-type" not in {k.lower() for k in sent_dict}


def test_proxy_sets_json_content_type_when_post_has_body(mocker) -> None:
    from fastapi.testclient import TestClient
    from gasfree_open_proxy.router import router

    app = FastAPI()
    app.state.gasfree_open_proxy = GasFreeOpenProxySettings(
        nile_creds=("gf-key", "gf-secret"),
        mainnet_creds=None,
        upstream_nile="https://open-test.gasfree.io",
        upstream_mainnet="https://open.gasfree.io",
    )
    app.include_router(router)

    mock_resp = httpx.Response(200, content=b"{}", headers={"content-type": "application/json"})
    request_mock = AsyncMock(return_value=mock_resp)
    inner_client = MagicMock()
    inner_client.request = request_mock
    client_cm = MagicMock()
    client_cm.__aenter__ = AsyncMock(return_value=inner_client)
    client_cm.__aexit__ = AsyncMock(return_value=None)
    mocker.patch("gasfree_open_proxy.router.httpx.AsyncClient", return_value=client_cm)

    with TestClient(app) as tc:
        tc.post(
            "/nile/api/v1/gasfree/submit",
            content=b"{}",
        )

    sent = request_mock.await_args.kwargs["headers"]
    sent_l = {k.lower(): v for k, v in (sent if isinstance(sent, list) else list(sent.items()))}
    assert sent_l.get("content-type") == "application/json"


def test_proxy_preserves_client_json_charset_on_post(mocker) -> None:
    from fastapi.testclient import TestClient
    from gasfree_open_proxy.router import router

    app = FastAPI()
    app.state.gasfree_open_proxy = GasFreeOpenProxySettings(
        nile_creds=("gf-key", "gf-secret"),
        mainnet_creds=None,
        upstream_nile="https://open-test.gasfree.io",
        upstream_mainnet="https://open.gasfree.io",
    )
    app.include_router(router)

    mock_resp = httpx.Response(200, content=b"{}", headers={"content-type": "application/json"})
    request_mock = AsyncMock(return_value=mock_resp)
    inner_client = MagicMock()
    inner_client.request = request_mock
    client_cm = MagicMock()
    client_cm.__aenter__ = AsyncMock(return_value=inner_client)
    client_cm.__aexit__ = AsyncMock(return_value=None)
    mocker.patch("gasfree_open_proxy.router.httpx.AsyncClient", return_value=client_cm)

    ct = "application/json; charset=utf-8"
    with TestClient(app) as tc:
        tc.post("/nile/api/v1/gasfree/submit", content=b"{}", headers={"Content-Type": ct})

    sent = request_mock.await_args.kwargs["headers"]
    sent_l = {k.lower(): v for k, v in (sent if isinstance(sent, list) else list(sent.items()))}
    assert sent_l.get("content-type") == ct


def test_proxy_overrides_non_json_content_type_when_post_has_body(mocker) -> None:
    from fastapi.testclient import TestClient
    from gasfree_open_proxy.router import router

    app = FastAPI()
    app.state.gasfree_open_proxy = GasFreeOpenProxySettings(
        nile_creds=("gf-key", "gf-secret"),
        mainnet_creds=None,
        upstream_nile="https://open-test.gasfree.io",
        upstream_mainnet="https://open.gasfree.io",
    )
    app.include_router(router)

    mock_resp = httpx.Response(200, content=b"{}", headers={"content-type": "application/json"})
    request_mock = AsyncMock(return_value=mock_resp)
    inner_client = MagicMock()
    inner_client.request = request_mock
    client_cm = MagicMock()
    client_cm.__aenter__ = AsyncMock(return_value=inner_client)
    client_cm.__aexit__ = AsyncMock(return_value=None)
    mocker.patch("gasfree_open_proxy.router.httpx.AsyncClient", return_value=client_cm)

    with TestClient(app) as tc:
        tc.post(
            "/nile/api/v1/gasfree/submit",
            content=b"{}",
            headers={"Content-Type": "text/plain"},
        )

    sent = request_mock.await_args.kwargs["headers"]
    sent_l = {k.lower(): v for k, v in (sent if isinstance(sent, list) else list(sent.items()))}
    assert sent_l.get("content-type") == "application/json"


def test_proxy_preserves_duplicate_response_set_cookie_headers(mocker) -> None:
    from fastapi.testclient import TestClient
    from gasfree_open_proxy.router import router

    app = FastAPI()
    app.state.gasfree_open_proxy = GasFreeOpenProxySettings(
        nile_creds=("gf-key", "gf-secret"),
        mainnet_creds=None,
        upstream_nile="https://open-test.gasfree.io",
        upstream_mainnet="https://open.gasfree.io",
    )
    app.include_router(router)

    mock_resp = httpx.Response(
        200,
        content=b"{}",
        headers=httpx.Headers(
            [
                ("Content-Type", "application/json"),
                ("Set-Cookie", "a=1; Path=/"),
                ("Set-Cookie", "b=2; Path=/"),
            ]
        ),
    )
    request_mock = AsyncMock(return_value=mock_resp)
    inner_client = MagicMock()
    inner_client.request = request_mock
    client_cm = MagicMock()
    client_cm.__aenter__ = AsyncMock(return_value=inner_client)
    client_cm.__aexit__ = AsyncMock(return_value=None)
    mocker.patch("gasfree_open_proxy.router.httpx.AsyncClient", return_value=client_cm)

    with TestClient(app) as tc:
        r = tc.get("/nile/api/v1/config/token/all")

    assert r.status_code == 200
    raw = r.headers.raw
    set_cookie_lines = [v.decode("latin-1") for k, v in raw if k == b"set-cookie"]
    assert len(set_cookie_lines) == 2
    assert "a=1" in set_cookie_lines[0]
    assert "b=2" in set_cookie_lines[1]


def test_proxy_strips_content_encoding_matches_decoded_body(mocker) -> None:
    """httpx gives decoded .content; do not forward upstream Content-Encoding (gzip/br)."""
    from fastapi.testclient import TestClient
    from gasfree_open_proxy.router import router

    app = FastAPI()
    app.state.gasfree_open_proxy = GasFreeOpenProxySettings(
        nile_creds=("gf-key", "gf-secret"),
        mainnet_creds=None,
        upstream_nile="https://open-test.gasfree.io",
        upstream_mainnet="https://open.gasfree.io",
    )
    app.include_router(router)

    plain = b'{"ok":true}'
    mock_resp = httpx.Response(
        200,
        content=gzip.compress(plain),
        headers=httpx.Headers(
            [
                ("Content-Type", "application/json"),
                ("Content-Encoding", "gzip"),
            ]
        ),
    )
    assert mock_resp.content == plain
    request_mock = AsyncMock(return_value=mock_resp)
    inner_client = MagicMock()
    inner_client.request = request_mock
    client_cm = MagicMock()
    client_cm.__aenter__ = AsyncMock(return_value=inner_client)
    client_cm.__aexit__ = AsyncMock(return_value=None)
    mocker.patch("gasfree_open_proxy.router.httpx.AsyncClient", return_value=client_cm)

    with TestClient(app) as tc:
        r = tc.get("/nile/api/v1/config/token/all")

    assert r.status_code == 200
    assert r.content == b'{"ok":true}'
    assert "content-encoding" not in {k.decode("latin-1").lower() for k, _ in r.headers.raw}


def test_proxy_503_when_credentials_missing_for_network() -> None:
    from fastapi.testclient import TestClient
    from gasfree_open_proxy.router import router

    app = FastAPI()
    app.state.gasfree_open_proxy = GasFreeOpenProxySettings(
        nile_creds=("k", "s"),
        mainnet_creds=None,
        upstream_nile="https://open-test.gasfree.io",
        upstream_mainnet="https://open.gasfree.io",
    )
    app.include_router(router)

    with TestClient(app) as tc:
        r = tc.get("/mainnet/api/v1/config/token/all")
    assert r.status_code == 503
