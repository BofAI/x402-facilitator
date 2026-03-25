"""
Detailed unit tests for config behavior around network metadata and validation.
"""
import pytest
from unittest.mock import AsyncMock

from config import Config


# ---- _network_config ----
def test_network_config_returns_empty_when_no_facilitator():
    config = Config()
    config._config = {}
    assert config._network_config("tron:nile") == {}


def test_network_config_returns_empty_when_no_networks_key():
    config = Config()
    config._config = {"facilitator": {}}
    assert config._network_config("tron:nile") == {}


def test_network_config_returns_empty_when_network_id_unknown():
    config = Config()
    config._config = {
        "facilitator": {
            "networks": {
                "tron:nile": {},
            }
        }
    }
    assert config._network_config("tron:mainnet") == {}
    assert config._network_config("unknown:net") == {}


def test_network_config_returns_empty_when_network_value_is_none():
    config = Config()
    config._config = {
        "facilitator": {
            "networks": {
                "tron:nile": None,
            }
        }
    }
    # .get(network_id) returns None, then "or {}" gives {}
    assert config._network_config("tron:nile") == {}


def test_network_config_returns_dict_when_present():
    config = Config()
    config._config = {
        "facilitator": {
            "networks": {
                "tron:nile": {"base_fee": {"USDT": 100}},
            }
        }
    }
    out = config._network_config("tron:nile")
    assert out == {"base_fee": {"USDT": 100}}


# ---- get_base_fee ----
def test_get_base_fee_returns_empty_dict_for_unknown_network():
    config = Config()
    config._config = {"facilitator": {"networks": {"tron:nile": {"base_fee": {"USDT": 100}}}}}
    assert config.get_base_fee("tron:mainnet") == {}


def test_get_base_fee_returns_empty_dict_when_base_fee_missing():
    config = Config()
    config._config = {"facilitator": {"networks": {"tron:nile": {}}}}
    assert config.get_base_fee("tron:nile") == {}


def test_get_base_fee_returns_dict_with_int_values():
    config = Config()
    config._config = {
        "facilitator": {
            "networks": {
                "tron:nile": {"base_fee": {"USDT": 100, "USDD": 200000000000000}},
            }
        }
    }
    assert config.get_base_fee("tron:nile") == {"USDT": 100, "USDD": 200000000000000}


def test_get_base_fee_legacy_single_int_treated_as_usdt():
    config = Config()
    config._config = {
        "facilitator": {"networks": {"tron:nile": {"base_fee": 150}}}
    }
    assert config.get_base_fee("tron:nile") == {"USDT": 150}


def test_get_base_fee_legacy_single_string_treated_as_usdt():
    config = Config()
    config._config = {
        "facilitator": {"networks": {"tron:nile": {"base_fee": "200"}}}
    }
    assert config.get_base_fee("tron:nile") == {"USDT": 200}


# ---- _validate_required ----
def test_validate_required_raises_when_database_url_missing():
    config = Config()
    config._config = {
        "database": {},
        "facilitator": {
            "networks": {
                "tron:nile": {"base_fee": {"USDT": 100}},
            }
        },
    }
    with pytest.raises(ValueError) as exc_info:
        config._validate_required()
    assert "database.url" in str(exc_info.value)


def test_validate_required_raises_when_networks_missing():
    config = Config()
    config._config = {
        "database": {"url": "postgresql://localhost/db"},
        "facilitator": {},
    }
    with pytest.raises(ValueError) as exc_info:
        config._validate_required()
    assert "facilitator.networks" in str(exc_info.value)


def test_validate_required_raises_when_networks_not_dict():
    config = Config()
    config._config = {
        "database": {"url": "postgresql://localhost/db"},
        "facilitator": {"networks": ["tron:nile"]},
    }
    with pytest.raises(ValueError) as exc_info:
        config._validate_required()
    assert "facilitator.networks" in str(exc_info.value)
    assert "dict" in str(exc_info.value).lower()


def test_validate_required_raises_when_networks_empty_dict():
    config = Config()
    config._config = {
        "database": {"url": "postgresql://localhost/db"},
        "facilitator": {"networks": {}},
    }
    with pytest.raises(ValueError) as exc_info:
        config._validate_required()
    assert "facilitator.networks" in str(exc_info.value)


def test_validate_required_passes_without_private_key():
    config = Config()
    config._config = {
        "database": {"url": "postgresql://localhost/db"},
        "facilitator": {
            "networks": {
                "tron:nile": {},
            }
        },
    }
    config._validate_required()


def test_validate_required_passes_when_all_required_present():
    config = Config()
    config._config = {
        "database": {"url": "postgresql://localhost/db"},
        "facilitator": {
            "networks": {
                "tron:nile": {},
            }
        },
    }
    config._validate_required()  # no raise


def test_validate_required_ignores_onepassword_private_key_metadata():
    config = Config()
    config._config = {
        "database": {"url": "postgresql://localhost/db"},
        "facilitator": {
            "networks": {
                "tron:nile": {},
            }
        },
        "onepassword": {
            "token": "real-op-token",
            "tron_nile_private_key": "V/Item/private_key",
        },
    }
    config._validate_required()  # no raise


def test_validate_required_allows_placeholder_op_token():
    config = Config()
    config._config = {
        "database": {"url": "postgresql://localhost/db"},
        "facilitator": {
            "networks": {
                "tron:nile": {},
            }
        },
        "onepassword": {
            "token": "your-op-token",
            "tron_nile_private_key": "V/Item/private_key",
        },
    }
    config._validate_required()


# ---- get_gasfree_api_credentials ----
@pytest.mark.asyncio
async def test_get_gasfree_api_credentials_uses_network_specific_onepassword_refs(mocker, monkeypatch):
    config = Config()
    config._config = {
        "onepassword": {
            "token": "real-op-token",
            "gasfree_api_key_nile": "nile-vault/gasfree-nile-item/api_key",
            "gasfree_api_secret_nile": "nile-vault/gasfree-nile-item/api_secret",
            "gasfree_api_key": "global-vault/gasfree-global-item/api_key",
            "gasfree_api_secret": "global-vault/gasfree-global-item/api_secret",
        }
    }
    monkeypatch.delenv("GASFREE_API_KEY_NILE", raising=False)
    monkeypatch.delenv("GASFREE_API_SECRET_NILE", raising=False)
    monkeypatch.delenv("GASFREE_API_KEY", raising=False)
    monkeypatch.delenv("GASFREE_API_SECRET", raising=False)
    mock_get_secret = mocker.patch(
        "onepassword_client.get_secret_from_1password",
        new_callable=AsyncMock,
        side_effect=["nile-key", "nile-secret"],
    )

    key, secret = await config.get_gasfree_api_credentials("tron:nile")

    assert (key, secret) == ("nile-key", "nile-secret")
    assert mock_get_secret.await_count == 2
    assert mock_get_secret.await_args_list[0].kwargs == {
        "vault": "nile-vault",
        "item": "gasfree-nile-item",
        "field": "api_key",
        "token": "real-op-token",
    }
    assert mock_get_secret.await_args_list[1].kwargs == {
        "vault": "nile-vault",
        "item": "gasfree-nile-item",
        "field": "api_secret",
        "token": "real-op-token",
    }

# ---- networks property (list of keys) ----
def test_networks_returns_list_of_keys():
    config = Config()
    config._config = {
        "facilitator": {
            "networks": {
                "tron:nile": {},
                "tron:mainnet": {},
            }
        }
    }
    nets = config.networks
    assert set(nets) == {"tron:nile", "tron:mainnet"}
    assert len(nets) == 2


def test_networks_returns_empty_when_not_dict():
    config = Config()
    config._config = {"facilitator": {"networks": ["tron:nile"]}}
    assert config.networks == []
