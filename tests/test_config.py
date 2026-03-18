
import pytest
from config import Config

def test_config_default_values():
    """Verify default values of the config object"""
    config = Config()
    # Default values should match expectations
    assert config.server_host == "0.0.0.0"
    assert config.server_port == 8001
    assert config.server_workers == 1
    assert config.monitoring_endpoint == "/metrics"

def test_env_priority(monkeypatch):
    """Verify environment variable priority over YAML content"""
    config = Config()
    # Mock YAML config content
    config._config = {"onepassword": {"token": "yaml-token"}}
    
    # Set environment variable
    monkeypatch.setenv("OP_SERVICE_ACCOUNT_TOKEN", "env-token")
    
    assert config.onepassword_token == "env-token"

@pytest.mark.asyncio
async def test_private_key_fallback(monkeypatch):
    """Verify private key retrieval: per-network key in YAML over 1Password fallback"""
    config = Config()
    config._config = {
        "facilitator": {
            "networks": {
                "tron:nile": {"fee_to_address": "T...", "private_key": "direct-key"},
            }
        },
        "onepassword": {"token": "op-token", "vault": "V", "item": "I"},
    }
    key = await config.get_private_key("tron:nile")
    assert key == "direct-key"

@pytest.mark.asyncio
async def test_trongrid_api_key_env_priority(monkeypatch):
    """Verify TronGrid API Key environment variable priority"""
    config = Config()
    monkeypatch.setenv("TRON_GRID_API_KEY", "env-trongrid-key")
    
    key = await config.get_trongrid_api_key()
    assert key == "env-trongrid-key"
