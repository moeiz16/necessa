"""Qdrant access layer.

* Remote (Qdrant Cloud free tier) when QDRANT_URL is set; embedded local mode (`data/qdrant`) in
  dev; `:memory:` in tests. Embedded mode holds a file lock — run ingestion through the API job
  runner (or stop the API) when using the local store.
* Named vectors: `dense` (cosine, HNSW m=16/ef_construct=200, int8 scalar quantization + rescoring
  on remote) and sparse `bm25` (server-side IDF modifier).
* Blue/green: each index build writes a new physical collection; an alias points at the active one.
  Activation and rollback are atomic alias swaps.
* Tenancy: every query gets a server-side `tenant` filter injected here — never from clients.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

import structlog
from qdrant_client import AsyncQdrantClient, models

from app.core.config import get_settings

log = structlog.get_logger(__name__)

DENSE = "dense"
SPARSE = "bm25"
PUBLIC_TENANT = "public"

ALIASES = ("policy_chunks", "criteria", "chart_chunks", "semantic_cache")

_KEYWORD_INDEXES = (
    "source_key",
    "doc_type",
    "states",
    "codes",
    "section_key",
    "policy_version_id",
    "policy_id",
    "case_id",
    "document_id",
    "kind",
    "level",
    "criterion_id",
)
_INT_INDEXES = ("effective_from_n", "effective_to_n", "note_date_n", "version", "contractor_ids")


def date_to_int(d: Any) -> int | None:
    if d is None:
        return None
    if isinstance(d, str):
        d = d[:10].replace("-", "")
        return int(d) if d.isdigit() else None
    return d.year * 10000 + d.month * 100 + d.day


@dataclass
class Hit:
    id: str
    score: float
    payload: dict
    vector: list[float] | None = None


class VectorStore:
    def __init__(self, client: AsyncQdrantClient, prefix: str, remote: bool) -> None:
        self.client = client
        self.prefix = prefix
        self.remote = remote
        self._dense_cache: dict[str, bool] = {}

    # ── naming ──────────────────────────────────────────────────────────────
    def alias_name(self, alias: str) -> str:
        return f"{self.prefix}_{alias}"

    def new_physical_name(self, alias: str) -> str:
        return f"{self.prefix}_{alias}_{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:4]}"

    # ── collections ─────────────────────────────────────────────────────────
    async def collection_exists(self, name: str) -> bool:
        try:
            return await self.client.collection_exists(name)
        except Exception:
            return False

    async def create_collection(self, name: str, *, dense_dims: int | None) -> None:
        vectors: dict[str, models.VectorParams] = {}
        if dense_dims:
            vectors[DENSE] = models.VectorParams(
                size=dense_dims,
                distance=models.Distance.COSINE,
                hnsw_config=models.HnswConfigDiff(m=16, ef_construct=200),
                on_disk=self.remote,
            )
        quant = None
        if self.remote and dense_dims:
            quant = models.ScalarQuantization(
                scalar=models.ScalarQuantizationConfig(
                    type=models.ScalarType.INT8, quantile=0.99, always_ram=True
                )
            )
        await self.client.create_collection(
            collection_name=name,
            vectors_config=vectors,
            sparse_vectors_config={SPARSE: models.SparseVectorParams(modifier=models.Modifier.IDF)},
            quantization_config=quant,
            on_disk_payload=self.remote,
        )
        if self.remote:
            await self.client.create_payload_index(
                name,
                "tenant",
                models.KeywordIndexParams(type=models.KeywordIndexType.KEYWORD, is_tenant=True),
            )
            for field in _KEYWORD_INDEXES:
                await self.client.create_payload_index(name, field, models.PayloadSchemaType.KEYWORD)
            for field in _INT_INDEXES:
                await self.client.create_payload_index(name, field, models.PayloadSchemaType.INTEGER)
            await self.client.create_payload_index(name, "national", models.PayloadSchemaType.BOOL)
        self._dense_cache[name] = bool(dense_dims)
        log.info("qdrant.collection_created", name=name, dense_dims=dense_dims, remote=self.remote)

    async def drop_collection(self, name: str) -> None:
        if await self.collection_exists(name):
            await self.client.delete_collection(name)

    async def has_dense(self, name: str) -> bool:
        if name in self._dense_cache:
            return self._dense_cache[name]
        try:
            info = await self.client.get_collection(name)
            vecs = info.config.params.vectors
            ok = isinstance(vecs, dict) and DENSE in vecs
        except Exception:
            ok = False
        self._dense_cache[name] = ok
        return ok

    async def count(self, name: str) -> int:
        try:
            return int((await self.client.count(name, exact=True)).count)
        except Exception:
            return 0

    # ── aliases (blue/green) ───────────────────────────────────────────────
    async def current_physical(self, alias: str) -> str | None:
        target = self.alias_name(alias)
        try:
            res = await self.client.get_aliases()
        except Exception:
            return None
        for a in res.aliases:
            if a.alias_name == target:
                return a.collection_name
        return None

    async def activate(self, alias: str, physical: str) -> str | None:
        """Atomically point `alias` at `physical`. Returns the previously active collection."""
        target = self.alias_name(alias)
        previous = await self.current_physical(alias)
        ops: list[Any] = []
        if previous:
            ops.append(models.DeleteAliasOperation(delete_alias=models.DeleteAlias(alias_name=target)))
        ops.append(
            models.CreateAliasOperation(
                create_alias=models.CreateAlias(collection_name=physical, alias_name=target)
            )
        )
        await self.client.update_collection_aliases(change_aliases_operations=ops)
        log.info("qdrant.alias_switched", alias=target, to=physical, previous=previous)
        return previous

    async def ensure_singleton(self, alias: str, dense_dims: int | None) -> str:
        """For aliases with one long-lived collection (chart_chunks, criteria, semantic_cache)."""
        physical = await self.current_physical(alias)
        if physical and await self.collection_exists(physical):
            return physical
        physical = f"{self.prefix}_{alias}_v1" + ("" if dense_dims else "_sparse")
        if not await self.collection_exists(physical):
            await self.create_collection(physical, dense_dims=dense_dims)
        await self.activate(alias, physical)
        return physical

    # ── writes ──────────────────────────────────────────────────────────────
    async def upsert(self, collection: str, points: Iterable[models.PointStruct], batch: int = 128) -> int:
        buf: list[models.PointStruct] = []
        n = 0
        for p in points:
            buf.append(p)
            if len(buf) >= batch:
                await self.client.upsert(collection, points=buf, wait=True)
                n += len(buf)
                buf = []
        if buf:
            await self.client.upsert(collection, points=buf, wait=True)
            n += len(buf)
        return n

    async def delete_where(self, collection: str, flt: models.Filter) -> None:
        await self.client.delete(collection, points_selector=models.FilterSelector(filter=flt), wait=True)

    # ── reads ───────────────────────────────────────────────────────────────
    async def search_channels(
        self,
        collection: str,
        *,
        dense: list[float] | None,
        sparse: Any | None,
        flt: models.Filter | None,
        limit: int = 50,
        ef: int = 96,
    ) -> dict[str, list[Hit]]:
        """One round-trip (`query_batch_points`) returning per-channel ranked hits for app-side fusion."""
        reqs: list[models.QueryRequest] = []
        names: list[str] = []
        if dense is not None and await self.has_dense(collection):
            reqs.append(
                models.QueryRequest(
                    query=dense,
                    using=DENSE,
                    filter=flt,
                    limit=limit,
                    with_payload=True,
                    params=models.SearchParams(
                        hnsw_ef=ef,
                        quantization=models.QuantizationSearchParams(rescore=True, oversampling=2.0)
                        if self.remote
                        else None,
                    ),
                )
            )
            names.append("dense")
        if sparse is not None and len(sparse):
            reqs.append(
                models.QueryRequest(
                    query=sparse.to_qdrant(), using=SPARSE, filter=flt, limit=limit, with_payload=True
                )
            )
            names.append("sparse")
        if not reqs:
            return {}
        res = await self.client.query_batch_points(collection, requests=reqs)
        out: dict[str, list[Hit]] = {}
        for name, r in zip(names, res, strict=True):
            out[name] = [Hit(id=str(p.id), score=float(p.score), payload=p.payload or {}) for p in r.points]
        return out

    async def retrieve(self, collection: str, ids: list[str], *, with_vectors: bool = False) -> list[Hit]:
        if not ids:
            return []
        pts = await self.client.retrieve(
            collection, ids=ids, with_payload=True, with_vectors=[DENSE] if with_vectors else False
        )
        out = []
        for p in pts:
            vec = None
            if with_vectors and isinstance(p.vector, dict):
                vec = p.vector.get(DENSE)
            out.append(Hit(id=str(p.id), score=0.0, payload=p.payload or {}, vector=vec))
        return out

    async def scroll_filter(self, collection: str, flt: models.Filter, limit: int = 64) -> list[Hit]:
        pts, _ = await self.client.scroll(collection, scroll_filter=flt, limit=limit, with_payload=True)
        return [Hit(id=str(p.id), score=0.0, payload=p.payload or {}) for p in pts]


# ── filters ────────────────────────────────────────────────────────────────
def tenant_condition(org_id: Any | None, *, include_public: bool = True) -> models.Condition:
    vals = [PUBLIC_TENANT] if include_public else []
    if org_id:
        vals.append(str(org_id))
    if not vals:
        vals = ["__none__"]
    return models.FieldCondition(key="tenant", match=models.MatchAny(any=vals))


def build_filter(
    *,
    must: list[models.Condition] | None = None,
    should: list[models.Condition] | None = None,
    must_not: list[models.Condition] | None = None,
) -> models.Filter:
    return models.Filter(must=must or None, should=should or None, must_not=must_not or None)


# ── factory ────────────────────────────────────────────────────────────────
_store: VectorStore | None = None
_lock = asyncio.Lock()


def _make_client() -> tuple[AsyncQdrantClient, bool]:
    s = get_settings()
    if s.qdrant_url:
        if s.qdrant_url == ":memory:":
            return AsyncQdrantClient(location=":memory:"), False
        key = s.qdrant_api_key.get_secret_value() or None
        return AsyncQdrantClient(url=s.qdrant_url, api_key=key, timeout=30, prefer_grpc=False), True
    if s.environment == "test":
        return AsyncQdrantClient(location=":memory:"), False
    path = Path(s.data_dir) / "qdrant"
    path.mkdir(parents=True, exist_ok=True)
    return AsyncQdrantClient(path=str(path)), False


async def get_vectorstore() -> VectorStore:
    global _store
    if _store is None:
        async with _lock:
            if _store is None:
                client, remote = _make_client()
                _store = VectorStore(client, get_settings().qdrant_collection_prefix, remote)
    return _store


def set_vectorstore(store: VectorStore | None) -> None:
    global _store
    _store = store


@lru_cache
def memory_store() -> VectorStore:  # tests
    return VectorStore(AsyncQdrantClient(location=":memory:"), "test", remote=False)
