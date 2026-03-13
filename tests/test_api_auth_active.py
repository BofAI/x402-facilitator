
import pytest
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock
from database import APIKey

@pytest.mark.asyncio
async def test_get_payment_with_disabled_api_key(client, mocker):
    """
    Test that when an API Key exists but is disabled (is_active=False),
    the /payments/{payment_id} endpoint should not be able to associate it with a seller_id.
    Since get_api_key_by_key now filters by is_active, it should return None,
    leading the interface to fail to find records within the seller's scope (or handle it as anonymous).
    """
    # 1. Mock the scenario where the key exists in DB but is disabled
    # Note: the get_payment endpoint in main.py calls _get_seller_id_from_api_key,
    # which in turn calls get_api_key_by_key.
    
    mock_api_key = "disabled-key-123"
    
    # Mock get_api_key_by_key to return None (simulating the is_active=True filter in database.py)
    mocker.patch("main.get_api_key_by_key", new_callable=AsyncMock, return_value=None)
    
    # Mock get_payment_by_id (seller_id should be passed as None)
    mock_get_db = mocker.patch("main.get_payment_by_id", new_callable=AsyncMock, return_value=[])
    
    # Send request
    response = await client.get("/payments/pay-abc", headers={"X-API-KEY": mock_api_key})
    
    # Should return 404 (since it can't find the record for seller_id=None)
    assert response.status_code == 404
    
    # Verify that get_payment_by_id was called with seller_id as None
    # Because get_api_key_by_key returned None, _get_seller_id_from_api_key also returns None
    mock_get_db.assert_awaited_once_with("pay-abc", None)

@pytest.mark.asyncio
async def test_get_payment_with_active_api_key(client, mocker):
    """
    Test that when an API Key is active, it correctly retrieves the seller_id and performs the query.
    """
    mock_api_key = "active-key-123"
    
    # Mock database record
    mock_api_record = MagicMock()
    mock_api_record.seller_id = "seller-789"
    mock_api_record.key = mock_api_key
    mock_api_record.is_active = True
    
    # Mock the constant time check in middleware to succeed
    mocker.patch("auth._constant_time_key_check", return_value=True)
    # Mock the database call in the route handler
    mocker.patch("main.get_api_key_by_key", new_callable=AsyncMock, return_value=mock_api_record)
    
    # Mock query result
    mock_payment_record = MagicMock()
    mock_payment_record.payment_id = "pay-abc"
    mock_payment_record.tx_hash = "0x123"
    mock_payment_record.status = "success"
    mock_payment_record.created_at = datetime.now()
    
    mock_get_db = mocker.patch("main.get_payment_by_id", new_callable=AsyncMock, return_value=[mock_payment_record])
    
    # Send request with the key
    response = await client.get("/payments/pay-abc", headers={"X-API-KEY": mock_api_key})
    
    assert response.status_code == 200
    # Verify that the correct seller_id was used for the query
    mock_get_db.assert_awaited_once_with("pay-abc", "seller-789")
