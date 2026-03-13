"""
Integration tests for /settle with real PostgreSQL.

Creates a dedicated test DB (facilitator_test_<ms>), runs tests, then drops the DB.
Requires: PostgreSQL at localhost:5432 (postgres user, postgres password).
Run: pytest tests/test_integration_settle.py -v
Skip if DB unreachable: pytest tests/test_integration_settle.py -v (skips on connection error)
"""

import asyncio
import copy
import os
import subprocess
import time
import pytest
from httpx import AsyncClient, ASGITransport
from unittest.mock import AsyncMock
from sqlalchemy import delete

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import pytest_asyncio

import database
from database import init_database


# Base URL without database name; test DB will be facilitator_test_<ms>
INTEGRATION_DB_BASE = "postgresql+asyncpg://postgres:postgres@localhost:5432"
INTEGRATION_DB_CONN = {
    "host": "localhost",
    "port": 5432,
    "user": "postgres",
    "password": "postgres",
}

# Per-test IP base so each test gets its own rate-limit bucket (1/min per IP)
_integration_test_ip_base = [0]

# Minimal valid settle request body; paymentId is overridden per test
SETTLE_BODY_TEMPLATE = {
    "paymentPayload": {
        "x402Version": 1,
        "accepted": {
            "scheme": "tron",
            "network": "mainnet",
            "amount": "0",
            "asset": "USDT",
            "payTo": "TXxx0000000000000000000000000000000",
        },
        "payload": {
            "signature": "0x",
            "paymentPermit": {
                "meta": {
                    "kind": "PAYMENT_ONLY",
                    "paymentId": "pay-integ",
                    "nonce": "0",
                    "validAfter": 0,
                    "validBefore": 9999999999,
                },
                "buyer": "TXxx0000000000000000000000000000000",
                "caller": "TXxx0000000000000000000000000000000",
                "payment": {"payToken": "USDT", "payAmount": "0", "payTo": "TXxx0000000000000000000000000000000"},
                "fee": {"feeTo": "TXxx0000000000000000000000000000000", "feeAmount": "0"},
                "delivery": {
                    "receiveToken": "USDT",
                    "miniReceiveAmount": "0",
                    "tokenId": "0",
                },
            },
        },
    },
    "paymentRequirements": {
        "scheme": "tron",
        "network": "mainnet",
        "amount": "0",
        "asset": "USDT",
        "payTo": "TXxx0000000000000000000000000000000",
    },
}


def settle_body(payment_id: str) -> dict:
    """Return a copy of SETTLE_BODY_TEMPLATE with paymentId set."""
    body = copy.deepcopy(SETTLE_BODY_TEMPLATE)
    body["paymentPayload"]["payload"]["paymentPermit"]["meta"]["paymentId"] = payment_id
    return body


async def clear_payment_records():
    """Delete all payment_records (for clean state). Uses real DB after app has inited it."""
    from database import get_session, PaymentRecord
    async with get_session() as session:
        await session.execute(delete(PaymentRecord))
        await session.commit()


def _create_test_database(db_name: str) -> None:
    """Create a PostgreSQL database (requires createdb in PATH)."""
    env = os.environ.copy()
    env["PGPASSWORD"] = INTEGRATION_DB_CONN["password"]
    subprocess.run(
        [
            "createdb",
            "-h", INTEGRATION_DB_CONN["host"],
            "-p", str(INTEGRATION_DB_CONN["port"]),
            "-U", INTEGRATION_DB_CONN["user"],
            db_name,
        ],
        check=True,
        env=env,
        capture_output=True,
    )


def _drop_test_database(db_name: str) -> None:
    """Drop a PostgreSQL database (requires dropdb in PATH)."""
    env = os.environ.copy()
    env["PGPASSWORD"] = INTEGRATION_DB_CONN["password"]
    subprocess.run(
        [
            "dropdb",
            "-h", INTEGRATION_DB_CONN["host"],
            "-p", str(INTEGRATION_DB_CONN["port"]),
            "-U", INTEGRATION_DB_CONN["user"],
            "--if-exists",
            db_name,
        ],
        check=True,
        env=env,
        capture_output=True,
    )


@pytest_asyncio.fixture(scope="module")
async def integration_db_url():
    """
    Create a dedicated test DB (facilitator_test_<ms>), yield its URL.
    After all integration tests, dispose connections and drop the DB.
    """
    db_name = f"facilitator_test_{int(time.time_ns() // 1000)}"
    try:
        _create_test_database(db_name)
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        pytest.skip(f"Cannot create test DB (need createdb/dropdb in PATH and PostgreSQL): {e}")
    test_url = f"{INTEGRATION_DB_BASE}/{db_name}"
    yield test_url
    # Teardown: close all connections to test DB, then drop it
    if getattr(database, "_engine", None) is not None:
        await database._engine.dispose()
        database._engine = None
    database._async_session_maker = None
    try:
        _drop_test_database(db_name)
    except subprocess.CalledProcessError:
        pass  # best-effort drop; may fail if connections still open


def _minimal_config(db_url: str) -> dict:
    """Minimal config so lifespan can run (database + facilitator for init)."""
    return {
        "database": {"url": db_url},
        "facilitator": {
            "trongrid_api_key": "",
            "networks": {
                "tron:mainnet": {
                    "fee_to_address": "TXxx0000000000000000000000000000000",
                    "base_fee": {"USDT": 0},
                    "private_key": "0" * 64,
                },
            },
        },
        "logging": {},
    }


@pytest_asyncio.fixture
async def integration_client(mocker, integration_db_url):
    """
    FastAPI client with real DB at integration_db_url (dedicated test DB); startup deps mocked.
    Inits DB before yielding so clear_payment_records() can run in tests.
    """
    from config import config as config_module

    mocker.patch.object(config_module, "_config", _minimal_config(integration_db_url))
    mocker.patch("main.config.load_from_yaml", return_value=None)
    mocker.patch("main.config.get_private_key", new_callable=AsyncMock, return_value="0" * 64)
    mocker.patch("main.config.get_trongrid_api_key", new_callable=AsyncMock, return_value=None)

    # Unique IP per request; base from 100 so integration tests don't share rate-limit with unit tests (127.0.0.1–5)
    _integration_test_ip_base[0] += 1
    base = 100 + ((_integration_test_ip_base[0] - 1) * 50) % 156
    _ip_counter = [0]
    def _next_ip(request=None):
        _ip_counter[0] += 1
        return f"127.0.0.{(base + _ip_counter[0]) % 256 or 1}"
    mocker.patch("auth.get_remote_address", side_effect=_next_ip)



    try:
        await init_database(
            integration_db_url,
            pool_size=5,
            max_overflow=0,
            pool_recycle=100,
            ssl_mode="disable",
        )
    except Exception as e:
        pytest.skip(f"Integration DB unreachable: {e}")

    from main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


@pytest.mark.integration
@pytest.mark.asyncio
async def test_settle_integration_first_request_success(integration_client, mocker):
    """With payment_id: settle first -> save_payment_record -> 200, record in DB with success."""
    from bankofai.x402.schemas import SettleResponse

    async def mock_settle_success(*args, **kwargs):
        await asyncio.sleep(1)
        return SettleResponse(success=True, transaction="0xintegration_success", network="tron:mainnet")

    mocker.patch("main.x402_facilitator.settle", new_callable=AsyncMock, side_effect=mock_settle_success)

    payment_id = "pay-integ-first"
    await clear_payment_records()

    response = await integration_client.post("/settle", json=settle_body(payment_id))
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["transaction"] == "0xintegration_success"

    get_resp = await integration_client.get(f"/payments/{payment_id}")
    assert get_resp.status_code == 200
    records = get_resp.json()
    assert isinstance(records, list)
    assert len(records) >= 1
    latest = records[0]
    assert latest["paymentId"] == payment_id
    assert latest["status"] == "success"
    assert latest["txHash"] == "0xintegration_success"


@pytest.mark.integration
@pytest.mark.asyncio
async def test_settle_integration_same_payment_id_twice(integration_client, mocker):
    """Same payment_id twice: both 200; two records in DB; GET returns latest."""
    from bankofai.x402.schemas import SettleResponse

    tx_hashes = ["0xintegration_dup_1", "0xintegration_dup_2"]
    call_idx = [0]

    async def mock_settle_success(*args, **kwargs):
        await asyncio.sleep(0.1)
        i = call_idx[0]
        call_idx[0] += 1
        return SettleResponse(success=True, transaction=tx_hashes[min(i, len(tx_hashes) - 1)], network="tron:mainnet")

    mocker.patch("main.x402_facilitator.settle", new_callable=AsyncMock, side_effect=mock_settle_success)

    payment_id = "pay-integ-dup"
    await clear_payment_records()

    first = await integration_client.post("/settle", json=settle_body(payment_id))
    assert first.status_code == 200
    assert first.json()["transaction"] == tx_hashes[0]

    second = await integration_client.post("/settle", json=settle_body(payment_id))
    assert second.status_code == 200
    assert second.json()["transaction"] == tx_hashes[1]

    get_resp = await integration_client.get(f"/payments/{payment_id}")
    assert get_resp.status_code == 200
    records = get_resp.json()
    assert isinstance(records, list)
    assert len(records) >= 2
    latest = records[0]
    assert latest["paymentId"] == payment_id
    assert latest["status"] == "success"
    assert latest["txHash"] == tx_hashes[1]


@pytest.mark.integration
@pytest.mark.asyncio
async def test_settle_integration_concurrent_same_payment_id(integration_client, mocker):
    """Concurrent requests with same payment_id: all 200, settle called n times, n records; GET returns latest."""
    from bankofai.x402.schemas import SettleResponse

    settle_call_count = 0

    async def mock_settle_count(*args, **kwargs):
        nonlocal settle_call_count
        settle_call_count += 1
        await asyncio.sleep(0.1)
        return SettleResponse(success=True, transaction=f"0xconcurrent_{settle_call_count}", network="tron:mainnet")

    mocker.patch("main.x402_facilitator.settle", new_callable=AsyncMock, side_effect=mock_settle_count)

    payment_id = "pay-integ-concurrent"
    await clear_payment_records()

    n = 5
    tasks = [
        integration_client.post("/settle", json=settle_body(payment_id))
        for _ in range(n)
    ]
    responses = await asyncio.gather(*tasks, return_exceptions=True)

    ok_count = sum(1 for r in responses if not isinstance(r, Exception) and r.status_code == 200)
    assert ok_count == n
    assert settle_call_count == n

    get_resp = await integration_client.get(f"/payments/{payment_id}")
    assert get_resp.status_code == 200
    records = get_resp.json()
    assert isinstance(records, list)
    assert len(records) >= 1
    latest = records[0]
    assert latest["paymentId"] == payment_id
    assert latest["status"] == "success"
