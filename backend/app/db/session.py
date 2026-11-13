"""Async engine/session factory. SHARED FILE."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Any

import orjson
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings


def _json_dumps(value: Any) -> str:
    """JSON for JSON/JSONB columns: dates, datetimes, UUIDs, enums and dataclasses serialize natively,
    anything else (e.g. Decimal) falls back to str instead of failing the whole transaction."""
    return orjson.dumps(value, default=str, option=orjson.OPT_NON_STR_KEYS).decode()


@lru_cache
def get_engine() -> AsyncEngine:
    s = get_settings()
    kwargs: dict = {
        "echo": s.database_echo,
        "future": True,
        "json_serializer": _json_dumps,
        "json_deserializer": orjson.loads,
    }
    if s.is_sqlite:
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        # Neon free tier scales to zero; keep the pool small and pre-ping stale connections.
        kwargs.update(pool_size=5, max_overflow=5, pool_pre_ping=True, pool_recycle=300)
    engine = create_async_engine(s.database_url, **kwargs)
    if s.is_sqlite:

        @event.listens_for(engine.sync_engine, "connect")
        def _fk_on(dbapi_conn, _):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

    return engine


@lru_cache
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False, autoflush=False)


@asynccontextmanager
async def session_scope() -> AsyncIterator[AsyncSession]:
    """Unit-of-work for background jobs / CLI (commits on success, rolls back on error)."""
    async with get_sessionmaker()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency (request-scoped session)."""
    async with get_sessionmaker()() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
