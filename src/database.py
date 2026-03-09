"""
Database module for payment record persistence
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import String, DateTime, BigInteger, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def _ssl_for_asyncpg(ssl_mode: str):
    """Return ssl argument for asyncpg: False when disable, True otherwise."""
    return ssl_mode.strip().lower() != "disable"


class Base(DeclarativeBase):
    """SQLAlchemy declarative base"""
    pass


class PaymentRecord(Base):
    """Payment record model"""
    
    __tablename__ = "payment_records"
    
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    seller_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    network: Mapped[str | None] = mapped_column(String(32), nullable=True)
    payment_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    tx_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

class APIKey(Base):
    """API Key Model"""
    
    __tablename__ = "api_keys"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    seller_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class Seller(Base):
    """Seller Model"""
    
    __tablename__ = "sellers"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    seller_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

# Global engine and session maker
_engine = None
_async_session_maker = None


async def init_database(
    database_url: str,
    *,
    pool_size: int,
    max_overflow: int,
    pool_recycle: int,
    pool_pre_ping: bool = True,
    ssl_mode: str,
) -> None:
    """
    Initialize the database connection and create tables.
    """
    global _engine, _async_session_maker

    engine_kw = dict(
        echo=False,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_recycle=pool_recycle,
        pool_pre_ping=pool_pre_ping,
    )
    if _ssl_for_asyncpg(ssl_mode) is False:
        engine_kw["connect_args"] = {"ssl": False}

    _engine = create_async_engine(database_url, **engine_kw)

    _async_session_maker = async_sessionmaker(_engine, expire_on_commit=False)
    
    # Create tables
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def dispose_engine() -> None:
    """Dispose the database engine and release all connections."""
    global _engine
    if _engine:
        await _engine.dispose()
        _engine = None


def get_session() -> AsyncSession:
    """
    Get a new database session.
    
    Returns:
        AsyncSession instance
        
    Raises:
        RuntimeError: If database is not initialized
    """
    if _async_session_maker is None:
        raise RuntimeError("Database not initialized. Call init_database first.")
    return _async_session_maker()


async def get_all_api_keys() -> list[str]:
    """
    Get all active API keys from database.
    
    Returns:
        List of API key strings
    """
    async with get_session() as session:
        result = await session.execute(select(APIKey.key))
        return [row[0] for row in result.all()]



async def save_payment_record(
    payment_id: str | None,
    seller_id: str | None,
    network: str | None,
    tx_hash: str,
    status: str,
) -> PaymentRecord:
    """
    Save a payment record to the database.
    
    Args:
        payment_id: Unique payment identifier
        seller_id: Seller identifier
        network: Network identifier
        tx_hash: Transaction hash
        status: Payment status (success/failed)
        
    Returns:
        The created PaymentRecord
    """
    async with get_session() as session:
        record = PaymentRecord(
            payment_id=payment_id,
            seller_id=seller_id,
            network=network,
            tx_hash=tx_hash,
            status=status,
        )
        session.add(record)
        await session.commit()
        await session.refresh(record)
        return record


async def get_payment_by_id(payment_id: str, seller_id: str | None = None) -> list[PaymentRecord]:
    """
    Get payment records by payment_id (payment_id is not unique).
    If seller_id is provided, results are additionally filtered by seller_id.
    Results are ordered by id descending (latest first).
    """
    async with get_session() as session:
        stmt = select(PaymentRecord).where(PaymentRecord.payment_id == payment_id)
        if seller_id is not None:
            stmt = stmt.where(PaymentRecord.seller_id == seller_id)
        stmt = stmt.order_by(PaymentRecord.id.desc())
        result = await session.execute(stmt)
        return list(result.scalars().all())


async def get_payment_by_tx_hash(tx_hash: str, seller_id: str | None = None) -> list[PaymentRecord]:
    """
    Get payment records by tx_hash (one tx_hash may have multiple records).
    If seller_id is provided, results are additionally filtered by seller_id.
    Results are ordered by id descending (latest first).
    """
    async with get_session() as session:
        stmt = select(PaymentRecord).where(PaymentRecord.tx_hash == tx_hash)
        if seller_id is not None:
            stmt = stmt.where(PaymentRecord.seller_id == seller_id)
        stmt = stmt.order_by(PaymentRecord.id.desc())
        result = await session.execute(stmt)
        return list(result.scalars().all())

async def get_api_key_by_key(api_key: str) -> APIKey | None:
    """Get APIKey row by plaintext key.
    Hashes the key with SHA-256 before querying, since only hashes are stored.
    Returns the APIKey instance, or None if not found.
    """
    import hashlib
    hashed = hashlib.sha256(api_key.encode()).hexdigest()
    async with get_session() as session:
        result = await session.execute(
            select(APIKey)
            .where(APIKey.key == hashed)
        )
        return result.scalar_one_or_none()