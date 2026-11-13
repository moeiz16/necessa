"""Database full-text channel — a third lexical signal next to Qdrant dense + BM25.

* PostgreSQL: `to_tsvector('english', header || ' ' || text)` with a GIN expression index,
  OR-query via `to_tsquery` (prefix matching for codes), ranked with `ts_rank_cd`.
* SQLite (dev/tests): FTS5 virtual table `policy_chunks_fts` (porter stemmer), ranked by bm25().
Phrase-exact matches ("6 weeks of conservative therapy") are where this channel earns its keep.
"""

from __future__ import annotations

import re

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = structlog.get_logger(__name__)

_TERM = re.compile(r"[a-z0-9]+(?:\.[a-z0-9]+)?")
_STOP = {
    "the",
    "a",
    "an",
    "of",
    "for",
    "and",
    "or",
    "to",
    "in",
    "on",
    "is",
    "are",
    "what",
    "which",
    "how",
    "does",
    "do",
    "with",
    "be",
    "by",
    "it",
    "as",
    "at",
    "that",
    "this",
    "i",
    "my",
    "me",
    "can",
    "when",
}


def _dialect(session: AsyncSession) -> str:
    return session.get_bind().dialect.name


async def ensure_fts(session: AsyncSession) -> None:
    d = _dialect(session)
    if d == "sqlite":
        await session.execute(
            text(
                "CREATE VIRTUAL TABLE IF NOT EXISTS policy_chunks_fts USING fts5("
                "chunk_id UNINDEXED, body, tokenize='porter unicode61')"
            )
        )
    elif d == "postgresql":
        await session.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_policy_chunks_fts ON policy_chunks USING GIN "
                "(to_tsvector('english', coalesce(header,'') || ' ' || coalesce(text,'')))"
            )
        )


async def rebuild_fts(session: AsyncSession, rows: list[tuple[str, str]]) -> None:
    """SQLite only: (chunk_id, body) rows replace the FTS table contents. Postgres indexes itself."""
    if _dialect(session) != "sqlite":
        return
    await ensure_fts(session)
    await session.execute(text("DELETE FROM policy_chunks_fts"))
    for i in range(0, len(rows), 500):
        await session.execute(
            text("INSERT INTO policy_chunks_fts(chunk_id, body) VALUES (:id, :body)"),
            [{"id": r[0], "body": r[1]} for r in rows[i : i + 500]],
        )


def _terms(query: str) -> list[str]:
    terms = [t for t in _TERM.findall(query.lower()) if t not in _STOP and len(t) > 1]
    out: list[str] = []
    for t in terms:
        if t not in out:
            out.append(t)
    return out[:16]


async def search_fts(session: AsyncSession, query: str, limit: int = 50) -> list[tuple[str, float]]:
    terms = _terms(query)
    if not terms:
        return []
    d = _dialect(session)
    try:
        if d == "sqlite":
            q = " OR ".join(f'"{t}"' for t in terms)
            res = await session.execute(
                text(
                    "SELECT chunk_id, bm25(policy_chunks_fts) AS s FROM policy_chunks_fts "
                    "WHERE policy_chunks_fts MATCH :q ORDER BY s LIMIT :n"
                ),
                {"q": q, "n": limit},
            )
            # SQLite bm25() is "lower is better" (negative); flip sign for a higher-is-better score
            return [(str(r[0]), float(-r[1])) for r in res.all()]
        if d == "postgresql":
            q = " | ".join(f"{t.replace('.', '')}:*" if any(c.isdigit() for c in t) else t for t in terms)
            res = await session.execute(
                text(
                    "SELECT id::text, ts_rank_cd("
                    "to_tsvector('english', coalesce(header,'') || ' ' || coalesce(text,'')),"
                    " to_tsquery('english', :q)) AS s FROM policy_chunks WHERE level = 'child' AND "
                    "to_tsvector('english', coalesce(header,'') || ' ' || coalesce(text,''))"
                    " @@ to_tsquery('english', :q)"
                    " ORDER BY s DESC LIMIT :n"
                ),
                {"q": q, "n": limit},
            )
            return [(str(r[0]), float(r[1])) for r in res.all()]
    except Exception as exc:  # FTS is an optional channel; never fail retrieval because of it
        log.debug("fts.search_failed", error=str(exc))
    return []
