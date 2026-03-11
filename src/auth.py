import logging
import asyncio
import secrets
from typing import Optional, Set
from fastapi import Request
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from config import config
from database import get_all_api_keys

logger = logging.getLogger(__name__)

from contextvars import ContextVar

# Context variable to store the current request for the rate limit provider
_current_request: ContextVar[Optional[Request]] = ContextVar("current_request", default=None)

# Global API Key Cache
API_KEY_CACHE: Set[str] = set()


def _constant_time_key_check(api_key: str) -> bool:
    """Check API key against cache using constant-time comparison to mitigate timing attacks."""
    for cached in API_KEY_CACHE:
        if secrets.compare_digest(api_key, cached):
            return True
    return False


# Initialize Limiter
limiter = Limiter(key_func=get_remote_address)

async def refresh_api_keys_cache():
    """Refresh API keys cache from database"""
    global API_KEY_CACHE
    try:
        keys = await get_all_api_keys()
        API_KEY_CACHE = set(keys)
        logger.info(f"API key cache refreshed: {len(API_KEY_CACHE)} keys loaded")
    except Exception as e:
        logger.error(f"Failed to refresh API key cache: {e}")

async def api_key_refresher():
    """Background task to refresh API keys cache periodically"""
    while True:
        await refresh_api_keys_cache()
        await asyncio.sleep(config.api_key_refresh_interval)

def get_dynamic_rate_limit() -> str:
    """
    Returns the appropriate limit string based on authentication status.
    Uses ContextVar to access the current request state.
    """
    request = _current_request.get()
    if request and getattr(request.state, "is_authenticated", False):
        return config.rate_limit_authenticated
    return config.rate_limit_anonymous

def get_dynamic_key_func(request: Request) -> str:
    """
    Returns a unique key for the current request context.
    - Auth: "auth:<api_key>"
    - Anon: "anon:<ip>"
    """
    if getattr(request.state, "is_authenticated", False):
        return f"auth:{getattr(request.state, 'api_key', 'unknown')}"
    
    client_ip = get_remote_address(request)
    return f"anon:{client_ip if client_ip else 'unknown'}"

async def rate_limit_middleware(request: Request, call_next):
    """
    Middleware to check API Key against memory cache and set state for rate limiter.
    Also sets the current request in ContextVar for the dynamic limit provider.
    """
    request.state.is_authenticated = False
    request.state.api_key = None
    
    api_key = request.headers.get("X-API-KEY")
    if api_key and _constant_time_key_check(api_key):
        request.state.is_authenticated = True
        request.state.api_key = api_key
            
    # Set context variable for the duration of this request
    token = _current_request.set(request)
    try:
        response = await call_next(request)
        return response
    finally:
        _current_request.reset(token)

def setup_auth(app):
    """Configure authentication and rate limiting for the app"""
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.middleware("http")(rate_limit_middleware)
