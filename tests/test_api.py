
import pytest
import json
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

# Minimal valid settle request body (matches bankofai.x402 v2 PaymentPayload / PaymentRequirements shape)
_TEST_REQUIREMENTS = {
    "scheme": "exact",
    "network": "tron:mainnet",
    "amount": "0",
    "asset": "TXxx0000000000000000000000000000000",
    "payTo": "TXxx0000000000000000000000000000000",
    "maxTimeoutSeconds": 3600,
}

SETTLE_BODY = {
    "paymentPayload": {
        "x402Version": 2,
        "accepted": _TEST_REQUIREMENTS,
        "payload": {
            "signature": "0x",
            "authorization": {
                "from": "TXxx0000000000000000000000000000000",
                "to": "TXxx0000000000000000000000000000000",
                "value": "0",
                "validAfter": "0",
                "validBefore": "9999999999",
                "nonce": "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
        },
    },
    "paymentRequirements": _TEST_REQUIREMENTS,
}


@pytest.mark.asyncio
async def test_health(client):
    """Test /health endpoint (no rate limit)"""
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_health(client):
    """Test /health endpoint (no rate limit)"""
    response = await client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_get_supported(client, mocker):
    """Test /supported endpoint"""
    # Mock x402_facilitator.supported
    mock_supported = mocker.patch("main.x402_facilitator.get_supported", return_value={"pricing": "flat"})
    
    response = await client.get("/supported")
    assert response.status_code == 200
    assert response.json() == {"pricing": "flat"}

@pytest.mark.asyncio
async def test_get_payment_success(client, mock_db):
    """Test /payments/{payment_id} endpoint - Success state"""
    # Mock database record
    mock_record = MagicMock()
    mock_record.payment_id = "pay-123"
    mock_record.tx_hash = "0xhash"
    mock_record.status = "success"
    mock_record.created_at = datetime.now()
    
    mock_db["get"].return_value = [mock_record]
    
    response = await client.get("/payments/pay-123")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["paymentId"] == "pay-123"
    assert data[0]["txHash"] == "0xhash"

@pytest.mark.asyncio
async def test_get_payment_not_found(client, mock_db):
    """Test /payments/{payment_id} endpoint - Not found state"""
    mock_db["get"].return_value = []
    
    response = await client.get("/payments/non-existent")
    assert response.status_code == 404
    assert response.json()["detail"] == "Payment not found"

@pytest.mark.asyncio
async def test_rate_limiting_trigger(client, mocker):
    """Verify rate limiting on /settle (Anonymous user 1/min): first 200, second 429."""
    from bankofai.x402.schemas import SettleResponse

    mocker.patch("auth.get_remote_address", return_value="1.2.3.4")
    mocker.patch(
        "main.x402_facilitator.settle",
        new_callable=AsyncMock,
        return_value=SettleResponse(success=True, transaction="0xtx", network="tron:mainnet"),
    )
    mocker.patch("main.save_payment_record", new_callable=AsyncMock)

    resp1 = await client.post("/settle", json=SETTLE_BODY)
    assert resp1.status_code == 200

    resp2 = await client.post("/settle", json=SETTLE_BODY)
    assert resp2.status_code == 429
    assert "Rate limit exceeded" in resp2.json()["error"]


# --- Settle flow tests (settle first -> save_payment_record; no transaction, no 409) ---


@pytest.mark.asyncio
async def test_settle_success_with_payment_id(client, mocker):
    """Settle with payment_id: settle succeeds -> save_payment_record(payment_id, seller_id, network, tx_hash, 'success') -> 200."""
    mocker.patch("auth.get_remote_address", return_value="127.0.0.1")
    mocker.patch("main._get_payment_id_from_request", return_value="pay-123")

    from bankofai.x402.schemas import SettleResponse
    mocker.patch(
        "main.x402_facilitator.settle",
        new_callable=AsyncMock,
        return_value=SettleResponse(success=True, transaction="0xtxhash", network="tron:mainnet"),
    )
    save_payment_record_mock = mocker.patch(
        "main.save_payment_record",
        new_callable=AsyncMock,
    )

    response = await client.post("/settle", json=SETTLE_BODY)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    assert data["transaction"] == "0xtxhash"
    # No API key in this test, so seller_id is None; network comes from request body (v2 CAIP-2 format)
    save_payment_record_mock.assert_awaited_once_with("pay-123", None, "tron:mainnet", "0xtxhash", "success")


@pytest.mark.asyncio
async def test_settle_no_payment_id_calls_settle_only(client, mocker):
    """Settle without payment_id: still records a row with nullable payment_id/seller_id -> 200."""
    from bankofai.x402.schemas import SettleResponse
    mocker.patch("auth.get_remote_address", return_value="127.0.0.2")
    mocker.patch("main._get_payment_id_from_request", return_value=None)
    mocker.patch(
        "main.x402_facilitator.settle",
        new_callable=AsyncMock,
        return_value=SettleResponse(success=True, transaction="0xtxhash", network="tron:mainnet"),
    )
    save_payment_record_mock = mocker.patch("main.save_payment_record")

    response = await client.post("/settle", json=SETTLE_BODY)
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    # _get_payment_id_from_request returns None, seller_id is None; network from body (v2 CAIP-2 format)
    save_payment_record_mock.assert_awaited_once_with(None, None, "tron:mainnet", "0xtxhash", "success")


@pytest.mark.asyncio
async def test_settle_failure_returns_500_no_record(client, mocker):
    """Settle raises -> 500; save_payment_record not called."""
    mocker.patch("auth.get_remote_address", return_value="127.0.0.5")
    mocker.patch("main._get_payment_id_from_request", return_value="pay-123")
    mocker.patch(
        "main.x402_facilitator.settle",
        new_callable=AsyncMock,
        side_effect=Exception("chain error"),
    )
    save_payment_record_mock = mocker.patch("main.save_payment_record")

    response = await client.post("/settle", json=SETTLE_BODY)
    assert response.status_code == 500
    save_payment_record_mock.assert_not_called()
