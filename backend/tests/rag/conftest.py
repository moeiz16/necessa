"""Fixtures for knowledge / hybrid-RAG tests (workstream B).

Everything runs offline: FakeLLMRouter (ENVIRONMENT=test), in-memory Qdrant, SQLite.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio

RAW_DIR = Path(__file__).resolve().parents[3] / "data" / "raw"
HAS_MCD = (RAW_DIR / "current_lcd" / "csv" / "lcd.csv").exists()
requires_mcd = pytest.mark.skipif(not HAS_MCD, reason="CMS MCD CSV exports not present under data/raw")


@pytest.fixture(autouse=True)
def _offline_ai() -> None:
    from app.ai import cache
    from app.ai.llm import telemetry
    from app.ai.llm.fake import FakeLLMRouter
    from app.ai.llm.router import set_llm_router

    telemetry.disable_db_writes()  # engine is disposed per test; keep telemetry in-memory
    set_llm_router(FakeLLMRouter())
    cache._mem.clear()
    cache.embedding_cache.clear()


@pytest_asyncio.fixture
async def db() -> AsyncIterator:
    from app.db.session import session_scope

    async with session_scope() as s:
        yield s


@pytest_asyncio.fixture
async def fixtures_index() -> dict:
    """Synthetic payer policies ingested + indexed (idempotent across tests)."""
    from app.ai.ingestion.pipeline import run_ingestion
    from app.db.session import session_scope

    async with session_scope() as s:
        return await run_ingestion(s, source="fixtures")


_SLICE_KEYS = ["A52369", "L33396", "A57453", "L33718"]


@pytest_asyncio.fixture
async def mcd_slice_index() -> dict:
    """A small slice of the REAL CMS MCD exports (+ all NCDs) ingested + indexed."""
    from app.ai.ingestion.pipeline import run_ingestion
    from app.db.session import session_scope

    async with session_scope() as s:
        return await run_ingestion(s, source="mcd", policy_keys=_SLICE_KEYS, raw_dir=RAW_DIR)


@pytest.fixture
def org_id() -> uuid.UUID:
    return uuid.uuid4()
