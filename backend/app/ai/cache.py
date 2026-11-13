"""Caching layers (docs/PROBLEM_STATEMENT.md §16).

* `exact_get/exact_set`: Redis (Upstash) → `response_cache` table → in-process LRU.
* `embedding_cache`: in-process LRU keyed by (model, text-hash) — saves free-tier embed quota.
* `SemanticCache`: near-duplicate PUBLIC Q&A answers stored in Qdrant, guarded by an
  **entity-equality check** (codes, payer, state, as-of, and clinically meaningful qualifiers such
  as with/without contrast, bilateral/unilateral, initial/replacement) and scoped to the active
  index version so a reindex never serves stale answers.
"""

from __future__ import annotations

import collections
import json
import re
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog

from app.ai.infra import get_redis
from app.ai.textutil import sha256_hex

log = structlog.get_logger(__name__)


class _LRU:
    def __init__(self, maxsize: int) -> None:
        self.maxsize = maxsize
        self.data: collections.OrderedDict[str, tuple[float, Any]] = collections.OrderedDict()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> Any | None:
        item = self.data.get(key)
        if item is None:
            self.misses += 1
            return None
        exp, val = item
        if exp and exp < time.time():
            self.data.pop(key, None)
            self.misses += 1
            return None
        self.data.move_to_end(key)
        self.hits += 1
        return val

    def set(self, key: str, val: Any, ttl: int | None = None) -> None:
        self.data[key] = ((time.time() + ttl) if ttl else 0.0, val)
        self.data.move_to_end(key)
        while len(self.data) > self.maxsize:
            self.data.popitem(last=False)

    def clear(self) -> None:
        self.data.clear()


_mem = _LRU(5000)
_db_cache_enabled = True
STATS = collections.Counter()


def disable_db_cache() -> None:
    global _db_cache_enabled
    _db_cache_enabled = False


async def exact_get(key: str) -> dict | None:
    v = _mem.get(key)
    if v is not None:
        STATS["exact_hit_mem"] += 1
        return v
    r = get_redis()
    if r is not None:
        try:
            raw = await r.get(f"nc:{key}")
            if raw:
                val = json.loads(raw)
                _mem.set(key, val, ttl=600)
                STATS["exact_hit_redis"] += 1
                return val
        except Exception as exc:  # pragma: no cover
            log.debug("cache.redis_get_failed", error=str(exc))
    elif _db_cache_enabled:
        try:
            from app.db.models.knowledge import ResponseCache
            from app.db.session import session_scope

            async with session_scope() as s:
                row = await s.get(ResponseCache, key)
                if row and (row.expires_at is None or row.expires_at > datetime.now(UTC)):
                    row.hits += 1
                    _mem.set(key, row.value, ttl=600)
                    STATS["exact_hit_db"] += 1
                    return row.value
        except Exception as exc:
            log.debug("cache.db_get_failed", error=str(exc))
    STATS["exact_miss"] += 1
    return None


async def exact_set(key: str, value: dict, ttl: int = 86400) -> None:
    _mem.set(key, value, ttl=min(ttl, 3600))
    r = get_redis()
    if r is not None:
        try:
            await r.set(f"nc:{key}", json.dumps(value, default=str), ex=ttl)
            return
        except Exception as exc:  # pragma: no cover
            log.debug("cache.redis_set_failed", error=str(exc))
    if not _db_cache_enabled:
        return
    try:
        from app.db.models.knowledge import ResponseCache
        from app.db.session import session_scope

        async with session_scope() as s:
            row = await s.get(ResponseCache, key)
            exp = datetime.now(UTC) + timedelta(seconds=ttl)
            if row:
                row.value, row.expires_at = value, exp
            else:
                s.add(ResponseCache(key=key, value=value, expires_at=exp))
    except Exception as exc:
        log.debug("cache.db_set_failed", error=str(exc))


async def flush_all() -> dict:
    n_mem = len(_mem.data)
    _mem.clear()
    embedding_cache.clear()
    removed_db = 0
    r = get_redis()
    if r is not None:
        try:
            keys = [k async for k in r.scan_iter("nc:*")]
            if keys:
                await r.delete(*keys)
            removed_db = len(keys)
        except Exception:  # noqa: S110 - best-effort
            pass
    else:
        try:
            from sqlalchemy import delete

            from app.db.models.knowledge import ResponseCache
            from app.db.session import session_scope

            async with session_scope() as s:
                res = await s.execute(delete(ResponseCache))
                removed_db = res.rowcount or 0
        except Exception:  # noqa: S110 - best-effort
            pass
    STATS.clear()
    return {"memory": n_mem, "persistent": removed_db}


def stats() -> dict:
    return {
        "exact": {"memoryEntries": len(_mem.data), **{k: v for k, v in STATS.items()}},
        "embedding": {
            "entries": len(embedding_cache.lru.data),
            "hits": embedding_cache.lru.hits,
            "misses": embedding_cache.lru.misses,
        },
        "semantic": {
            "hits": STATS.get("semantic_hit", 0),
            "misses": STATS.get("semantic_miss", 0),
            "guardRejects": STATS.get("semantic_guard_reject", 0),
        },
        "backend": "redis" if get_redis() is not None else ("database" if _db_cache_enabled else "memory"),
    }


class _EmbeddingCache:
    def __init__(self) -> None:
        self.lru = _LRU(20000)

    def get(self, model: str, text: str) -> list[float] | None:
        return self.lru.get(sha256_hex(model, text))

    def put(self, model: str, text: str, vec: list[float]) -> None:
        self.lru.set(sha256_hex(model, text), vec)

    def clear(self) -> None:
        self.lru.clear()


embedding_cache = _EmbeddingCache()


# ── Semantic cache ─────────────────────────────────────────────────────────
_QUALIFIERS = [
    ("contrast", re.compile(r"\b(with(out)?|w/o|w/)\s+contrast\b", re.I)),
    ("laterality", re.compile(r"\b(bilateral|unilateral|left|right)\b", re.I)),
    ("episode", re.compile(r"\b(initial|replacement|repeat|subsequent|revision)\b", re.I)),
    ("negation", re.compile(r"\b(not|no|non-?covered|never|without)\b", re.I)),
    ("setting", re.compile(r"\b(inpatient|outpatient|asc|home|facility)\b", re.I)),
]


def entity_signature(
    question: str, *, codes: list[str], payer_type: str | None, states: list[str] | None, as_of: str | None
) -> dict:
    sig: dict[str, Any] = {
        "codes": sorted({c.upper() for c in codes}),
        "payer": payer_type or "",
        "states": sorted(states or []),
        "asOf": as_of or "",
    }
    for name, pat in _QUALIFIERS:
        sig[name] = sorted(
            {
                m.group(0).lower().replace("w/o", "without").replace("w/", "with")
                for m in pat.finditer(question)
            }
        )
    return sig


@dataclass
class SemanticHit:
    answer: dict
    similarity: float


class SemanticCache:
    """PUBLIC-only near-duplicate answer cache in Qdrant (alias `semantic_cache`)."""

    def __init__(self, threshold: float = 0.95, ttl_s: int = 7 * 86400) -> None:
        self.threshold = threshold
        self.ttl_s = ttl_s

    async def _collection(self) -> tuple[Any, str] | None:
        from app.ai.llm.config import get_catalog
        from app.ai.vectorstore import get_vectorstore

        store = await get_vectorstore()
        dims = get_catalog().embedding.dims
        from app.core.config import get_settings

        dims = get_settings().embedding_dims or dims
        name = await store.ensure_singleton("semantic_cache", dims)
        return store, name

    async def lookup(self, vector: list[float], signature: dict, index_version: str) -> SemanticHit | None:
        from qdrant_client import models

        try:
            coll = await self._collection()
            if coll is None:
                return None
            store, name = coll
            flt = models.Filter(
                must=[
                    models.FieldCondition(key="index_version", match=models.MatchValue(value=index_version)),
                    models.FieldCondition(key="expires_at", range=models.Range(gte=time.time())),
                ]
            )
            res = await store.client.query_points(
                name, query=vector, using="dense", query_filter=flt, limit=3, with_payload=True
            )
        except Exception as exc:
            log.debug("semantic_cache.lookup_failed", error=str(exc))
            return None
        for p in res.points:
            if p.score < self.threshold:
                break
            if (p.payload or {}).get("signature") != signature:
                STATS["semantic_guard_reject"] += 1
                continue
            STATS["semantic_hit"] += 1
            return SemanticHit(answer=(p.payload or {}).get("answer", {}), similarity=float(p.score))
        STATS["semantic_miss"] += 1
        return None

    async def store(
        self, vector: list[float], signature: dict, index_version: str, question: str, answer: dict
    ) -> None:
        from qdrant_client import models

        try:
            coll = await self._collection()
            if coll is None:
                return
            store, name = coll
            await store.client.upsert(
                name,
                points=[
                    models.PointStruct(
                        id=str(uuid.uuid4()),
                        vector={"dense": vector},
                        payload={
                            "tenant": "public",
                            "index_version": index_version,
                            "signature": signature,
                            "question": question[:500],
                            "answer": answer,
                            "expires_at": time.time() + self.ttl_s,
                        },
                    )
                ],
            )
        except Exception as exc:
            log.debug("semantic_cache.store_failed", error=str(exc))
