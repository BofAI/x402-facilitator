from auth import _constant_time_key_check, get_dynamic_key_func, API_KEY_CACHE
from fastapi import Request
from unittest.mock import MagicMock

def test_constant_time_key_check():
    """Verify constant-time comparison for API Keys (cache stores plaintext)"""
    global API_KEY_CACHE
    API_KEY_CACHE.clear()
    API_KEY_CACHE.add("valid-key-123")

    assert _constant_time_key_check("valid-key-123") is True
    assert _constant_time_key_check("wrong-key") is False

def test_get_dynamic_key_func_auth():
    """Test dynamic key generation for authenticated users"""
    request = MagicMock(spec=Request)
    request.state.is_authenticated = True
    request.state.api_key = "test-key"
    
    key = get_dynamic_key_func(request)
    assert key == "auth:test-key"

def test_get_dynamic_key_func_anon(mocker):
    """Test dynamic key generation for anonymous users (with IP)"""
    request = MagicMock(spec=Request)
    request.state.is_authenticated = False
    
    # Mock get_remote_address
    mocker.patch("auth.get_remote_address", return_value="127.0.0.1")
    
    key = get_dynamic_key_func(request)
    assert key == "anon:127.0.0.1"

def test_get_dynamic_key_func_anon_no_ip(mocker):
    """Test fallback logic when IP cannot be retrieved"""
    request = MagicMock(spec=Request)
    request.state.is_authenticated = False
    
    mocker.patch("auth.get_remote_address", return_value=None)
    
    key = get_dynamic_key_func(request)
    assert key == "anon:unknown"
