"""Per-case chart chunk indexing (scope `chart`, alias `chart_chunks`).

Charts are tenant-isolated: points carry `tenant=<org_id>` + `case_id`; the retriever injects both
filters server-side. Only DE-IDENTIFIED text is ever indexed (the caller passes `text_deid`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from uuid import UUID

import structlog
from qdrant_client import models

from app.ai import sparse
from app.ai.embeddings import embed_documents, embedding_dims, embeddings_available
from app.ai.vectorstore import date_to_int, get_vectorstore

log = structlog.get_logger(__name__)
ALIAS = "chart_chunks"
CHART_AVGDL = 120.0


@dataclass
class ChartChunkIn:
    chunk_id: str
    document_id: str
    text: str
    section: str | None = None
    note_date: date | None = None
    header: str | None = None
    doc_kind: str | None = None


async def chart_collection() -> str:
    store = await get_vectorstore()
    dims = embedding_dims() if embeddings_available() else None
    await store.ensure_singleton(ALIAS, dims)
    return store.alias_name(ALIAS)


async def index_chart_chunks(case_id: UUID, org_id: UUID, chunks: list[ChartChunkIn]) -> dict:
    """Replace the case's chart points with `chunks`. Returns {indexed, dense}."""
    store = await get_vectorstore()
    coll = await chart_collection()
    await store.delete_where(
        coll,
        models.Filter(
            must=[
                models.FieldCondition(key="case_id", match=models.MatchValue(value=str(case_id))),
                models.FieldCondition(key="tenant", match=models.MatchValue(value=str(org_id))),
            ]
        ),
    )
    if not chunks:
        return {"indexed": 0, "dense": False}
    texts = [f"{c.header or ''}\n{c.text}".strip() for c in chunks]
    vecs = await embed_documents(texts, purpose="index.chart") if await store.has_dense(coll) else None
    points = []
    for i, c in enumerate(chunks):
        vec: dict = {"bm25": sparse.encode_document(texts[i], CHART_AVGDL).to_qdrant()}
        if vecs:
            vec["dense"] = vecs[i]
        points.append(
            models.PointStruct(
                id=c.chunk_id,
                vector=vec,
                payload={
                    "tenant": str(org_id),
                    "kind": "chart",
                    "case_id": str(case_id),
                    "document_id": c.document_id,
                    "chunk_id": c.chunk_id,
                    "section": c.section,
                    "doc_kind": c.doc_kind,
                    "note_date": c.note_date.isoformat() if c.note_date else None,
                    "note_date_n": date_to_int(c.note_date) or 19000101,
                    "text": c.text,
                    "header": c.header or "",
                },
            )
        )
    n = await store.upsert(coll, points)
    return {"indexed": n, "dense": bool(vecs)}


async def delete_case_chunks(case_id: UUID, org_id: UUID) -> None:
    store = await get_vectorstore()
    coll = await chart_collection()
    await store.delete_where(
        coll,
        models.Filter(
            must=[
                models.FieldCondition(key="case_id", match=models.MatchValue(value=str(case_id))),
                models.FieldCondition(key="tenant", match=models.MatchValue(value=str(org_id))),
            ]
        ),
    )


async def index_criteria(policy_version_id: str, source_key: str, title: str, criteria: list[dict]) -> int:
    """Index compiled criteria (C's criteria_sets) for S10 denial→criterion mapping.
    criteria: [{criterion_id, text, quote}]"""
    store = await get_vectorstore()
    dims = embedding_dims() if embeddings_available() else None
    coll_phys = await store.ensure_singleton("criteria", dims)
    coll = store.alias_name("criteria")
    await store.delete_where(
        coll,
        models.Filter(
            must=[
                models.FieldCondition(
                    key="policy_version_id", match=models.MatchValue(value=policy_version_id)
                )
            ]
        ),
    )
    if not criteria:
        return 0
    texts = [f"[{source_key}] {c['text']}\n{c.get('quote', '')}" for c in criteria]
    vecs = (
        await embed_documents(texts, purpose="index.criteria") if await store.has_dense(coll_phys) else None
    )
    import uuid as _uuid

    points = []
    for i, c in enumerate(criteria):
        vec: dict = {"bm25": sparse.encode_document(texts[i]).to_qdrant()}
        if vecs:
            vec["dense"] = vecs[i]
        pid = str(_uuid.uuid5(_uuid.NAMESPACE_URL, f"{policy_version_id}:{c['criterion_id']}"))
        points.append(
            models.PointStruct(
                id=pid,
                vector=vec,
                payload={
                    "tenant": "public",
                    "kind": "criterion",
                    "criterion_id": c["criterion_id"],
                    "policy_version_id": policy_version_id,
                    "source_key": source_key,
                    "title": title,
                    "text": c["text"],
                    "quote": c.get("quote", ""),
                    "header": f"[Criterion {c['criterion_id']} · {source_key}]",
                    "is_current": True,
                    "states": [],
                    "national": True,
                },
            )
        )
    return await store.upsert(coll, points)
