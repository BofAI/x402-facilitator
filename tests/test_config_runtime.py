"""
Runtime config tests: load a real YAML file and assert every Config property/getter
matches the file. Ensures config structure (per-network, facilitator.trongrid_api_key, etc.)
is read correctly at runtime.
"""
import os
from pathlib import Path

import pytest

from config import Config

tests_dir = Path(__file__).resolve().parent


def _runtime_config_path() -> str:
    return str(tests_dir / "fixtures" / "facilitator.config.runtime_test.yaml")


@pytest.fixture
def runtime_config():
    """Load config from tests/fixtures YAML; fresh instance per test."""
    path = _runtime_config_path()
    assert os.path.isfile(path), f"Fixture missing: {path}"
    c = Config()
    c.load_from_yaml(path)
    return c


# ---- Database ----
def test_runtime_database_url(runtime_config):
    assert runtime_config.database_url == "postgresql+asyncpg://user:secret@localhost:5432/testdb"


def test_runtime_database_ssl_mode(runtime_config):
    assert runtime_config.database_ssl_mode == "require"


def test_runtime_database_pool(runtime_config):
    assert runtime_config.database_max_open_conns == 30
    assert runtime_config.database_max_idle_conns == 10
    assert runtime_config.database_max_life_time == 300


# ---- 1Password (YAML: vault/item/field per key; no token so no fetch) ----
def test_runtime_onepassword_metadata(runtime_config):
    assert runtime_config._get_op_ref("database_password") == "test-vault/db-pwd-item/password"
    assert runtime_config._get_op_ref("trongrid_api_key") == "test-vault/trongrid-item/api_key"
    assert runtime_config._parse_op_ref("V/I/f") == ("V", "I", "f")
    assert runtime_config._parse_op_ref("") is None
    assert runtime_config._parse_op_ref("a/b") is None


# ---- Server ----
def test_runtime_server(runtime_config):
    assert runtime_config.server_host == "127.0.0.1"
    assert runtime_config.server_port == 9000
    assert runtime_config.server_workers == 2


# ---- Logging ----
def test_runtime_logging_config(runtime_config):
    log = runtime_config.logging_config
    assert log.get("dir") == "test_logs"
    assert log.get("filename") == "runtime_test.log"
    assert log.get("level") == "DEBUG"


# ---- Rate limit ----
def test_runtime_rate_limit(runtime_config):
    assert runtime_config.api_key_refresh_interval == 120
    assert runtime_config.rate_limit_authenticated == "500/minute"
    assert runtime_config.rate_limit_anonymous == "5/minute"


# ---- Monitoring ----
def test_runtime_monitoring(runtime_config):
    assert runtime_config.monitoring_port == 9002
    assert runtime_config.monitoring_endpoint == "/prometheus"


# ---- Facilitator: shared ----
def test_runtime_facilitator_trongrid_shared(runtime_config):
    """trongrid_api_key is at facilitator level (shared across networks)."""
    # Read from YAML only (no env in test)
    assert runtime_config._config.get("facilitator", {}).get("trongrid_api_key") == "test-trongrid-key-from-yaml"


# ---- Facilitator: networks list ----
def test_runtime_networks_list(runtime_config):
    """config.networks returns all network ids (order may vary)."""
    nets = runtime_config.networks
    assert isinstance(nets, list)
    assert set(nets) == {"tron:nile", "tron:mainnet", "bsc:testnet", "bsc:mainnet"}
    assert len(nets) == 4


# ---- Per-network: base_fee ----
def test_runtime_per_network_base_fee(runtime_config):
    nile_fee = runtime_config.get_base_fee("tron:nile")
    assert nile_fee == {"USDT": 200, "USDD": 200000000000000}
    mainnet_fee = runtime_config.get_base_fee("tron:mainnet")
    assert mainnet_fee == {"USDT": 150}
    assert runtime_config.get_base_fee("bsc:testnet") == {"DHLU": 100}
    assert runtime_config.get_base_fee("bsc:mainnet") == {"EPS": 200}
    assert runtime_config.get_base_fee("unknown:net") == {}


# ---- get_trongrid_api_key from YAML ----
@pytest.mark.asyncio
async def test_runtime_trongrid_api_key_from_yaml(runtime_config):
    """trongrid_api_key at facilitator level is read without 1Password."""
    key = await runtime_config.get_trongrid_api_key()
    assert key == "test-trongrid-key-from-yaml"


# ---- get_database_url ----
@pytest.mark.asyncio
async def test_runtime_get_database_url(runtime_config):
    """Database URL from YAML is returned (no 1Password password injection in fixture)."""
    url = await runtime_config.get_database_url()
    assert "postgresql+asyncpg" in url
    assert "user" in url
    assert "secret" in url
    assert "testdb" in url


# ---- _network_config raw ----
def test_runtime_network_config_raw(runtime_config):
    """_network_config returns the raw dict for a network."""
    nc = runtime_config._network_config("tron:nile")
    assert nc.get("base_fee", {}).get("USDT") == 200
    bsc_nc = runtime_config._network_config("bsc:testnet")
    assert bsc_nc.get("base_fee", {}).get("DHLU") == 100
    assert runtime_config._network_config("nonexistent") == {}
