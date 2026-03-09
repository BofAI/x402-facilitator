#!/usr/bin/env python3
"""
Register a seller and add an API key.
Usage:
  python scripts/add_api_key.py <key>           # Register seller + specified key
  python scripts/add_api_key.py                 # Register seller + generated key
"""

import argparse
import asyncio
import hashlib
import secrets
import sys
from pathlib import Path
import uuid

# Add project root to path
project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root / "src"))

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from config import config
from database import APIKey, Seller, _ssl_for_asyncpg


async def register_seller(api_key: str) -> None:
    """Register a seller (UUID) and add an API key to the database."""
    config.load_from_yaml()
    database_url = await config.get_database_url()
    max_overflow = max(0, config.database_max_open_conns - config.database_max_idle_conns)

    engine_kw = dict(
        pool_size=config.database_max_idle_conns,
        max_overflow=max_overflow,
        pool_recycle=config.database_max_life_time,
        pool_pre_ping=True,
    )
    if not _ssl_for_asyncpg(config.database_ssl_mode):
        engine_kw["connect_args"] = {"ssl": False}
    engine = create_async_engine(database_url, **engine_kw)
    async_session = async_sessionmaker(engine, expire_on_commit=False)

    seller_id = str(uuid.uuid4())

    async with async_session() as session:
        seller = Seller(seller_id=seller_id)
        key_hash = hashlib.sha256(api_key.encode()).hexdigest()
        api_key_record = APIKey(seller_id=seller_id, key=key_hash)
        session.add(seller)
        session.add(api_key_record)
        try:
            await session.commit()
            print(f"Seller registered successfully: seller_id={seller_id}")
            print(f"API key added successfully: {api_key}")
        except Exception as e:
            await session.rollback()
            if "duplicate key" in str(e).lower() or "unique" in str(e).lower():
                print(f"Error: API key already exists: {api_key}")
            else:
                raise
        finally:
            await engine.dispose()


def main():
    parser = argparse.ArgumentParser(description="Register seller and API key for x402-tron-facilitator")
    parser.add_argument(
        "key",
        nargs="?",
        help="API key to add (default: generate a random 32-byte hex key)",
    )
    args = parser.parse_args()

    api_key = args.key
    if not api_key:
        api_key = secrets.token_hex(32)
        print(f"Generated new API key: {api_key}")

    asyncio.run(register_seller(api_key))


if __name__ == "__main__":
    main()
