
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

def test_validate_required_allows_networks_without_private_key():
    """Wallets are now provided externally, so private_key is no longer required."""
    config = Config()
    config._config = {
        "database": {"url": "postgresql+asyncpg://user@localhost/db"},
        "facilitator": {
            "networks": {
                "tron:nile": {},
            }
        },
    }
    config._validate_required()

def test_validate_required_allows_networks_without_fee_to_address():
    """fee_to_address is no longer required and defaults to the signer address."""
    config = Config()
    config._config = {
        "database": {"url": "postgresql+asyncpg://user@localhost/db"},
        "facilitator": {
            "networks": {
                "tron:nile": {},
            }
        },
    }
    config._validate_required()

@pytest.mark.asyncio
async def test_trongrid_api_key_env_priority(monkeypatch):
    """Verify TronGrid API Key environment variable priority"""
    config = Config()
    monkeypatch.setenv("TRON_GRID_API_KEY", "env-trongrid-key")
    
    key = await config.get_trongrid_api_key()
    assert key == "env-trongrid-key"
