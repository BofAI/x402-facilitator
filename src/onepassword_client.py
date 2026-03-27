"""
1Password client for secure secret retrieval
"""

from typing import Optional


async def get_secret_from_1password(
    vault: str,
    item: str,
    field: str,
    token: Optional[str] = None,
) -> str:
    """
    Retrieve a secret from 1Password using the SDK.
    
    Args:
        vault: 1Password vault name
        item: Item name in the vault
        field: Field name within the item
        token: 1Password service account token. Optional if set in environment.
        
    Returns:
        The secret value
        
    Raises:
        RuntimeError: If token is not provided or set in environment
        Exception: If secret retrieval fails
    """
    if not token or token == "your-op-token" or token == "your-service-account-token":
        raise RuntimeError(
            "Valid 1Password service account token is not provided. "
            "Please set the 'OP_SERVICE_ACCOUNT_TOKEN' environment variable "
            "or update 'onepassword.token' in facilitator.config.yaml."
        )
    
    try:
        from onepassword.client import Client
        
        client = await Client.authenticate(
            auth=token,
            integration_name="x402-facilitator",
            integration_version="1.0.0",
        )
        
        # Build the secret reference URI
        # Format: op://vault/item/field
        secret_reference = f"op://{vault}/{item}/{field}"
        secret = await client.secrets.resolve(secret_reference)
        
        return secret
        
    except ImportError:
        raise RuntimeError(
            "onepassword-sdk is not installed. "
            "Please install it with: pip install onepassword-sdk"
        )
    except Exception as e:
        raise RuntimeError(f"Failed to retrieve secret from 1Password: {e}")
