import pytest
from typing import AsyncGenerator
from httpx import AsyncClient, ASGITransport
from unittest.mock import AsyncMock

import sys
from pathlib import Path

# Add src to sys.path
sys.path.append(str(Path(__file__).parent.parent / "src"))

import pytest_asyncio

@pytest_asyncio.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    """
    Fixture for FastAPI test client.
    We import app inside to avoid early initialization issues.
    """
    from main import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac

@pytest.fixture
def mock_config(mocker):
    """Fixture to mock the config object."""
    from config import config
    # We can mock specific properties or methods
    mocker.patch.object(config, "load_from_yaml", return_value=None)
    return config

@pytest.fixture
def mock_db(mocker):
    """Fixture to mock database operations."""
    mock_get = mocker.patch("main.get_payment_by_id", new_callable=AsyncMock)
    return {"get": mock_get}
