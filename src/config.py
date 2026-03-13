"""
Configuration module - loads settings from YAML file and 1Password
"""

import logging
import os
from pathlib import Path
from typing import Optional
from urllib.parse import quote, urlparse, urlunparse

import yaml

logger = logging.getLogger(__name__)

class Config:
    """Application configuration"""
    
    def __init__(self):
        self._config: dict = {}
        self._private_key_cache: dict[str, str] = {}  # network_id -> key (from 1Password or direct)
        self._trongrid_api_key: Optional[str] = None
        self._database_password: Optional[str] = None
        self._loaded: bool = False
        
    def load_from_yaml(self, config_path: Optional[str] = None) -> None:
        """
        Load configuration from YAML file.
        
        Args:
            config_path: Path to config file. If None:
              1) uses CONFIG_PATH env var if set
              2) else tries <project_root>/config/facilitator.config.yaml
              3) else falls back to <project_root>/facilitator.config.yaml
        
        Raises:
            FileNotFoundError: If configuration file is not found.
        """
        if self._loaded and config_path is None:
            return  # Prevents redundant loading if already loaded with default path
            
        if config_path is None:
            config_path = os.getenv("CONFIG_PATH")
        
        project_root = Path(__file__).parent.parent
        if config_path is None:
            # Prefer config/facilitator.config.yaml if present, else project root
            config_dir_candidate = project_root / "config" / "facilitator.config.yaml"
            if config_dir_candidate.exists():
                config_path = str(config_dir_candidate)
            else:
                config_path = str(project_root / "facilitator.config.yaml")
        
        if not os.path.exists(config_path):
             raise FileNotFoundError(
                 f"Configuration file not found at {config_path}. "
                 "Please ensure facilitator.config.yaml exists in the project root "
                 "or config/ directory, or set CONFIG_PATH environment variable."
             )
        logger.info(f"Configuration file found at {config_path}")
        
        with open(config_path, "r") as f:
            self._config = yaml.safe_load(f) or {}

        self._validate_required()
        self._loaded = True
    
    def _validate_required(self) -> None:
        """
        Validate that required configuration keys are present and non-empty.
        Raises ValueError to force service stop on missing critical config.
        """
        errors = []
        db = self._config.get("database", {})
        if not db.get("url"):
            errors.append("database.url is required and must be non-empty")
        fac = self._config.get("facilitator", {})
        networks_cfg = fac.get("networks")
        if not networks_cfg or not isinstance(networks_cfg, dict):
            errors.append("facilitator.networks is required and must be a non-empty dict (network_id -> config)")
        else:
            op_cfg = self._config.get("onepassword", {}) or {}
            token_ok = bool(
                self.onepassword_token
                and self.onepassword_token not in ("your-op-token", "your-service-account-token")
            )
            for nid, nc in networks_cfg.items():
                nc = nc or {}
                if not nc.get("fee_to_address"):
                    errors.append(f"facilitator.networks.{nid}.fee_to_address is required")
                op_key = self._op_private_key_key(nid)
                ref = op_cfg.get(op_key) if isinstance(op_cfg.get(op_key), str) else ""
                has_op = bool(token_ok and ref.strip() and self._parse_op_ref(ref.strip()))
                if not nc.get("private_key") and not has_op:
                    errors.append(
                        f"facilitator.networks.{nid}.private_key is required, "
                        f"or configure onepassword.{op_key} as 'vault/item/field'"
                    )
        if errors:
            raise ValueError(
                "Configuration validation failed. " + " ".join(errors)
            )
    
    @property
    def database_url(self) -> str:
        """Get database connection URL (may not contain password if using 1Password)"""
        return self._config.get("database", {}).get("url", "")

    @property
    def database_ssl_mode(self) -> str:
        """SSL mode for DB: disable | require | verify-ca | verify-full. Default disable (local)."""
        return self._config.get("database", {}).get("ssl_mode", "disable")

    @property
    def database_max_open_conns(self) -> int:
        """Max total connections in pool (pool_size + max_overflow). Default 25."""
        return int(self._config.get("database", {}).get("max_open_conns", 25))

    @property
    def database_max_idle_conns(self) -> int:
        """Connections to keep open when idle (pool_size). Default 15."""
        return int(self._config.get("database", {}).get("max_idle_conns", 15))

    @property
    def database_max_life_time(self) -> int:
        """Seconds before recycling a connection (pool_recycle). Default 600."""
        return int(self._config.get("database", {}).get("max_life_time", 600))

    @staticmethod
    def _parse_op_ref(ref: str) -> Optional[tuple[str, str, str]]:
        """Parse 'vault/item/field' into (vault, item, field). Returns None if invalid."""
        if not ref or not isinstance(ref, str):
            return None
        parts = ref.strip().split("/")
        if len(parts) != 3 or not all(p.strip() for p in parts):
            return None
        return (parts[0].strip(), parts[1].strip(), parts[2].strip())

    @staticmethod
    def _op_private_key_key(network_id: str) -> str:
        """Map network_id (e.g. tron:nile) to onepassword key (e.g. tron_nile_private_key)."""
        return network_id.replace(":", "_") + "_private_key"

    def _get_op_ref(self, key: str) -> str:
        """Get 1Password secret reference string for key (e.g. tron_nile_private_key, database_password, trongrid_api_key)."""
        val = self._config.get("onepassword", {}).get(key)
        return (val or "").strip() if isinstance(val, str) else ""
        
    @property
    def onepassword_token(self) -> Optional[str]:
        """
        Get 1Password service account token.
        Priority: 
        1. Environment variable OP_SERVICE_ACCOUNT_TOKEN
        2. Configuration file
        """
        env_token = os.getenv("OP_SERVICE_ACCOUNT_TOKEN")
        if env_token:
            return env_token
        return self._config.get("onepassword", {}).get("token")
    
    def _network_config(self, network_id: str) -> dict:
        """Get raw config dict for a network (facilitator.networks[network_id])."""
        return self._config.get("facilitator", {}).get("networks", {}).get(network_id) or {}

    def get_fee_to_address(self, network_id: str) -> str:
        """Get fee recipient address for a network."""
        return self._network_config(network_id).get("fee_to_address", "")

    def get_base_fee(self, network_id: str) -> dict[str, int]:
        """
        Get base fee per token for a network (symbol -> amount in smallest units).
        YAML: networks.<id>.base_fee: { USDT: 100, USDD: ... }
        """
        val = self._network_config(network_id).get("base_fee", {})
        if isinstance(val, dict):
            return {k: int(v) for k, v in val.items()}
        if isinstance(val, (str, int)):
            return {"USDT": int(val)}
        return {}

    def get_rpc_url(self, network_id: str) -> str:
        """
        Get RPC URL for a network.
        YAML: networks.<id>.rpc_url
        Falls back to DEFAULT_RPC_URLS from helper module if not set.
        """
        url = self._network_config(network_id).get("rpc_url", "")
        if url:
            return url
        from helper import DEFAULT_RPC_URLS
        default = DEFAULT_RPC_URLS.get(network_id, "")
        if not default:
            raise ValueError(
                f"rpc_url for {network_id} is not configured and has no default. "
                f"Please set facilitator.networks.{network_id}.rpc_url in config."
            )
        return default

    @property
    def networks(self) -> list[str]:
        """Get list of network ids (all keys in facilitator.networks; listed = enabled)."""
        nets = self._config.get("facilitator", {}).get("networks", {})
        if not isinstance(nets, dict):
            return []
        return list(nets.keys())
    
    @property
    def server_host(self) -> str:
        """Get server host"""
        return self._config.get("server", {}).get("host", "0.0.0.0")

    @property
    def server_port(self) -> int:
        """Get server port"""
        return self._config.get("server", {}).get("port", 8001)

    @property
    def server_workers(self) -> int:
        """Get uvicorn workers (default 1). Use 2+ for higher settle QPS headroom."""
        return int(self._config.get("server", {}).get("workers", 1))

    @property
    def logging_config(self) -> dict:
        """Get logging configuration"""
        return self._config.get("logging", {})

    @property
    def api_key_refresh_interval(self) -> int:
        """Get API key refresh interval in seconds"""
        return self._config.get("rate_limit", {}).get("api_key_refresh_interval", 60)

    @property
    def rate_limit_authenticated(self) -> str:
        """Get rate limit for authenticated users"""
        return self._config.get("rate_limit", {}).get("authenticated", "1000/minute")

    @property
    def rate_limit_anonymous(self) -> str:
        """Get rate limit for anonymous users"""
        return self._config.get("rate_limit", {}).get("anonymous", "1/minute")

    @property
    def monitoring_port(self) -> int:
        """Get monitoring port, defaults to server port if not specified"""
        return self._config.get("monitoring", {}).get("port", self.server_port)

    @property
    def monitoring_endpoint(self) -> str:
        """Get monitoring endpoint path"""
        return self._config.get("monitoring", {}).get("endpoint", "/metrics")

    async def get_private_key(self, network_id: str) -> str:
        """
        Get private key for a network.
        Priority:
        1. Cached value for this network (from 1Password)
        2. This network's private_key in YAML (facilitator.networks.<id>.private_key)
        3. 1Password retrieval (cached as fallback for all networks missing a key)

        Returns:
            Private key string
        """
        nc = self._network_config(network_id)
        direct_key = (nc.get("private_key") or "").strip()
        if direct_key:
            return direct_key

        # Fallback: per-network 1Password key (cached in _private_key_cache)
        if network_id in self._private_key_cache:
            return self._private_key_cache[network_id]

        token = self.onepassword_token
        op_key = self._op_private_key_key(network_id)
        ref = self._get_op_ref(op_key)
        parsed = self._parse_op_ref(ref) if ref else None
        if not token or token == "your-op-token" or token == "your-service-account-token" or not parsed:
            raise ValueError(
                f"Facilitator Private Key for {network_id} is not configured.\n\n"
                "Set facilitator.networks.<network_id>.private_key in config, "
                f"or configure onepassword.{op_key} as 'vault/item/field'."
            )
        from onepassword_client import get_secret_from_1password
        vault, item, field = parsed
        key = await get_secret_from_1password(vault=vault, item=item, field=field, token=token)
        self._private_key_cache[network_id] = key
        return key

    async def get_trongrid_api_key(self) -> Optional[str]:
        """
        Get TronGrid API Key.
        Priority:
        1. Cached value
        2. Environment variable TRON_GRID_API_KEY
        3. Direct 'trongrid_api_key' in YAML (local dev)
        4. 1Password retrieval
        
        Returns:
            API Key string or None if not configured
        """
        if self._trongrid_api_key is not None:
            return self._trongrid_api_key
            
        # 1. Try environment variable first
        env_key = os.getenv("TRON_GRID_API_KEY")
        if env_key:
            self._trongrid_api_key = env_key
            return self._trongrid_api_key
            
        # 2. Try direct key from YAML (fallback for local dev)
        direct_key = self._config.get("facilitator", {}).get("trongrid_api_key")
        if direct_key:
            self._trongrid_api_key = direct_key
            return self._trongrid_api_key

        # 3. Try 1Password if configured (onepassword.trongrid_api_key = "vault/item/field")
        ref = self._get_op_ref("trongrid_api_key")
        token = self.onepassword_token
        parsed = self._parse_op_ref(ref) if ref else None
        if parsed and token and token not in ("your-op-token", "your-service-account-token"):
            try:
                from onepassword_client import get_secret_from_1password
                vault, item, field = parsed
                self._trongrid_api_key = await get_secret_from_1password(
                    vault=vault, item=item, field=field, token=token,
                )
                return self._trongrid_api_key
            except Exception as e:
                logger.warning(f"Failed to load TronGrid API Key from 1Password: {e}")
        
        return None

    async def get_database_password(self) -> Optional[str]:
        """
        Get database password.
        Priority:
        1. Cached value
        2. Direct database.password in YAML (local dev)
        3. 1Password retrieval (when onepassword.database_password_item is set)

        Returns:
            Password string, or None if not configured (URL may contain password or no auth)
        """
        if self._database_password is not None:
            return self._database_password

        # 1. Direct password in config (local dev)
        direct = self._config.get("database", {}).get("password")
        if direct is not None and direct != "":
            self._database_password = str(direct)
            return self._database_password

        # 2. 1Password (onepassword.database_password = "vault/item/field")
        ref = self._get_op_ref("database_password")
        token = self.onepassword_token
        parsed = self._parse_op_ref(ref) if ref else None
        if not parsed or not token or token in ("your-op-token", "your-service-account-token"):
            return None

        from onepassword_client import get_secret_from_1password
        vault, item, field = parsed
        self._database_password = await get_secret_from_1password(
            vault=vault, item=item, field=field, token=token,
        )
        return self._database_password

    async def get_database_url(self) -> str:
        """
        Get database connection URL, with password injected when available.

        Password is fetched from database.password (config) or 1Password (when database_password_item is set),
        then injected into database.url (URL may be without password, e.g. postgresql+asyncpg://user@host:5432/db).
        """
        raw_url = self._config.get("database", {}).get("url", "")
        if not raw_url:
            raise ValueError("database.url is required")

        password = await self.get_database_password()
        if not password:
            return raw_url

        # Inject password into URL (password may contain special chars)
        parsed = urlparse(raw_url)
        username = parsed.username or ""
        port = f":{parsed.port}" if parsed.port else ""
        quoted = quote(password, safe="")
        netloc = f"{username}:{quoted}@{parsed.hostname or ''}{port}"
        return urlunparse(parsed._replace(netloc=netloc))


# Global config instance
config = Config()
