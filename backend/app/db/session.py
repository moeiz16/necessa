"""Async engine/session factory, plus per-request query accounting (surfaced in Server-Timing)."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
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


# Per-request DB accounting. The middleware installs a fresh dict per request; the dict object is
# shared by reference, so counts survive SQLAlchemy's greenlet/context hops.
query_stats: ContextVar[dict[str, float] | None] = ContextVar("query_stats", default=None)


def _install_query_accounting(engine: AsyncEngine) -> None:
    # The start time lives on the per-statement execution context (not a stack on the pooled
    # connection), so a statement that raises — and never reaches `after_cursor_execute` — leaves
    # nothing behind to leak or skew later timings.
    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def _before(conn, cursor, statement, parameters, context, executemany):  # type: ignore[no-untyped-def]
        if context is not None:
            context._necessa_t0 = time.perf_counter()

    @event.listens_for(engine.sync_engine, "after_cursor_execute")
    def _after(conn, cursor, statement, parameters, context, executemany):  # type: ignore[no-untyped-def]
        stats = query_stats.get()
        if stats is None:
            return
        started = getattr(context, "_necessa_t0", None)
        elapsed = time.perf_counter() - started if started is not None else 0.0
        stats["count"] = stats.get("count", 0) + 1
        stats["ms"] = stats.get("ms", 0.0) + elapsed * 1000


def _is_pgbouncer(url: str) -> bool:
    # Neon's pooled endpoints ("-pooler") run PgBouncer in transaction mode: no prepared-statement
    # cache and no startup server settings.
    return "-pooler" in url or "pgbouncer=true" in url


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
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 15}
    else:
        # Neon free tier scales to zero; keep the pool small, pre-ping stale connections and bound
        # every statement client-side so a slow query can't pin a worker.
        connect_args: dict[str, Any] = {"command_timeout": 30}
        if _is_pgbouncer(s.database_url):
            connect_args["statement_cache_size"] = 0
        else:
            connect_args["server_settings"] = {
                "application_name": "necessa-api",
                "statement_timeout": "20000",
                "idle_in_transaction_session_timeout": "30000",
            }
        kwargs.update(
            pool_size=5,
            max_overflow=10,
            pool_timeout=10,
            pool_pre_ping=True,
            pool_recycle=300,
            connect_args=connect_args,
        )
    engine = create_async_engine(s.database_url, **kwargs)
    if s.is_sqlite:

        @event.listens_for(engine.sync_engine, "connect")
        def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - trivial
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA journal_mode=WAL")
            # WAL makes NORMAL durable enough for dev; busy_timeout queues writers instead of
            # failing with "database is locked" under concurrent requests.
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA busy_timeout=10000")
            cur.execute("PRAGMA temp_store=MEMORY")
            cur.execute("PRAGMA cache_size=-32000")
            cur.close()

    _install_query_accounting(engine)
    return engine


@lru_cache
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    from app.core.cache import install_invalidation

    install_invalidation()  # committed org writes invalidate the short per-org response cache
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
