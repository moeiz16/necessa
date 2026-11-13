"""Builds Qdrant index versions from the Postgres source of truth.

Blue/green with vector reuse:
1. Create a new physical collection for alias `policy_chunks`.
2. For every child chunk of each policy's current (and immediately previous) version, reuse the
   dense vector from the previously active collection when the chunk ID (content-addressed) and the
   embedding model are unchanged; embed only new/changed chunks (free-tier quota friendly).
3. Upsert dense + BM25 sparse vectors with a rich filterable payload.
4. Rebuild the DB full-text channel, run a retrieval smoke eval, and only then swap the alias.
A partially built collection is resumable: points already present are not re-embedded.
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime

import structlog
from qdrant_client import models
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import sparse
from app.ai.embeddings import embed_documents, embedding_dims, embedding_model_id, embeddings_available
from app.ai.ingestion.chunker import NON_INDEXED_SECTIONS
from app.ai.retrieval.lexical import rebuild_fts
from app.ai.vectorstore import PUBLIC_TENANT, VectorStore, date_to_int, get_vectorstore
from app.db.models.knowledge import (
    IndexVersion,
    Policy,
    PolicyChunk,
    PolicyCode,
    PolicyContractor,
    PolicySection,
    PolicyState,
    PolicyVersion,
)

log = structlog.get_logger(__name__)
Progress = Callable[[float, str], Awaitable[None]] | None

ALIAS = "policy_chunks"
MAX_CODES_IN_PAYLOAD = 300


async def _noop(_p: float, _m: str) -> None:
    return None


async def _indexable_versions(
    session: AsyncSession,
) -> tuple[list[PolicyVersion], dict[uuid.UUID, Policy], set]:
    policies = {p.id: p for p in (await session.execute(select(Policy))).scalars()}
    versions = list((await session.execute(select(PolicyVersion))).scalars())
    by_policy: dict[uuid.UUID, list[PolicyVersion]] = defaultdict(list)
    for v in versions:
        by_policy[v.policy_id].append(v)
    keep: list[PolicyVersion] = []
    current_ids: set[uuid.UUID] = set()
    for pid, vs in by_policy.items():
        vs.sort(key=lambda v: v.version, reverse=True)
        pol = policies.get(pid)
        cur = next((v for v in vs if pol and v.id == pol.current_version_id), vs[0])
        current_ids.add(cur.id)
        keep.append(cur)
        prev = [v for v in vs if v.version < cur.version]
        if prev:
            keep.append(prev[0])
    return keep, policies, current_ids


async def build_policy_index(
    session: AsyncSession,
    *,
    progress: Progress = None,
    activate: bool = True,
    smoke_eval: bool = True,
    resume_physical: str | None = None,
) -> IndexVersion:
    progress = progress or _noop
    store = await get_vectorstore()
    model_id = embedding_model_id()
    dense_ok = embeddings_available()
    dims = embedding_dims() if dense_ok else 0

    versions, policies, current_ids = await _indexable_versions(session)
    vids = [v.id for v in versions]
    vmap = {v.id: v for v in versions}
    sections = (
        {
            s.id: s
            for s in (
                await session.execute(select(PolicySection).where(PolicySection.policy_version_id.in_(vids)))
            ).scalars()
        }
        if vids
        else {}
    )
    chunks = (
        list(
            (
                await session.execute(
                    select(PolicyChunk)
                    .where(PolicyChunk.policy_version_id.in_(vids), PolicyChunk.level == "child")
                    .order_by(PolicyChunk.policy_version_id, PolicyChunk.ordinal)
                )
            ).scalars()
        )
        if vids
        else []
    )
    chunks = [
        c
        for c in chunks
        if not (
            c.section_id
            and sections.get(c.section_id)
            and sections[c.section_id].section_key in NON_INDEXED_SECTIONS
        )
    ]
    states: dict[uuid.UUID, list[str]] = defaultdict(list)
    for st in (
        await session.execute(select(PolicyState).where(PolicyState.policy_version_id.in_(vids)))
    ).scalars():
        states[st.policy_version_id].append(st.state_abbrev)
    contractors: dict[uuid.UUID, list[int]] = defaultdict(list)
    for pc in (
        await session.execute(select(PolicyContractor).where(PolicyContractor.policy_version_id.in_(vids)))
    ).scalars():
        contractors[pc.policy_version_id].append(pc.contractor_id)
    codes: dict[uuid.UUID, list[str]] = defaultdict(list)
    for vid, code in (
        await session.execute(
            select(PolicyCode.policy_version_id, PolicyCode.code).where(
                PolicyCode.policy_version_id.in_(vids), PolicyCode.code_system == "HCPCS"
            )
        )
    ).all():
        if len(codes[vid]) < MAX_CODES_IN_PAYLOAD:
            codes[vid].append(code)

    # previous active index (for vector reuse)
    prev_active = (
        (
            await session.execute(
                select(IndexVersion)
                .where(IndexVersion.alias == ALIAS, IndexVersion.status == "active")
                .order_by(IndexVersion.activated_at.desc())
            )
        )
        .scalars()
        .first()
    )
    reuse_from = (
        prev_active.physical_name
        if (prev_active and prev_active.embed_model == model_id and dense_ok)
        else None
    )

    physical = resume_physical or store.new_physical_name(ALIAS)
    if not await store.collection_exists(physical):
        await store.create_collection(physical, dense_dims=dims or None)
    iv = (
        (await session.execute(select(IndexVersion).where(IndexVersion.physical_name == physical)))
        .scalars()
        .first()
    )
    if iv is None:
        iv = IndexVersion(
            alias=ALIAS,
            physical_name=physical,
            embed_model=model_id if dense_ok else None,
            dims=dims,
            sparse_model=sparse.SPARSE_MODEL_ID,
            status="building",
            stats={},
        )
        session.add(iv)
        await session.flush()
    t0 = time.perf_counter()

    # corpus statistics for BM25 length normalization
    lengths = [sparse.doc_length(f"{c.header}\n{c.text}") for c in chunks]
    avgdl = (sum(lengths) / len(lengths)) if lengths else sparse.DEFAULT_AVGDL

    reused = embedded = 0
    degraded: list[str] = [] if dense_ok else ["dense"]
    batch_size = 64
    total = len(chunks)
    await progress(0.05, f"indexing {total} chunks into {physical}")
    for start in range(0, total, batch_size):
        batch = chunks[start : start + batch_size]
        ids = [str(c.id) for c in batch]
        vectors: dict[str, list[float]] = {}
        if dense_ok:
            existing = await store.retrieve(physical, ids, with_vectors=True)
            vectors.update({h.id: h.vector for h in existing if h.vector})
            if reuse_from:
                missing = [i for i in ids if i not in vectors]
                if missing:
                    old = await store.retrieve(reuse_from, missing, with_vectors=True)
                    got = {h.id: h.vector for h in old if h.vector}
                    reused += len(got)
                    vectors.update(got)
            need = [c for c in batch if str(c.id) not in vectors]
            if need:
                vecs = await embed_documents([f"{c.header}\n{c.text}" for c in need], purpose="index.policy")
                if vecs is None:
                    raise RuntimeError(
                        "embedding provider unavailable mid-build; partial collection kept for resume "
                        f"(resume_physical={physical})"
                    )
                for c, v in zip(need, vecs, strict=True):
                    vectors[str(c.id)] = v
                embedded += len(need)
        points = []
        for c in batch:
            v = vmap[c.policy_version_id]
            pol = policies[v.policy_id]
            sec = sections.get(c.section_id) if c.section_id else None
            vec: dict = {"bm25": sparse.encode_document(f"{c.header}\n{c.text}", avgdl).to_qdrant()}
            if str(c.id) in vectors:
                vec["dense"] = vectors[str(c.id)]
            st = states.get(v.id, [])
            points.append(
                models.PointStruct(
                    id=str(c.id),
                    vector=vec,
                    payload={
                        "tenant": str(pol.org_id) if pol.org_id else PUBLIC_TENANT,
                        "kind": "policy",
                        "chunk_id": str(c.id),
                        "policy_id": str(pol.id),
                        "policy_version_id": str(v.id),
                        "source_key": pol.source_key,
                        "source": pol.source,
                        "title": pol.title,
                        "doc_type": pol.doc_type,
                        "status": pol.status,
                        "url": pol.url,
                        "version": v.version,
                        "is_current": v.id in current_ids,
                        "section_key": sec.section_key if sec else "other",
                        "section_title": sec.title if sec else "",
                        "effective_from": v.effective_from.isoformat() if v.effective_from else None,
                        "effective_to": v.effective_to.isoformat() if v.effective_to else None,
                        "effective_from_n": date_to_int(v.effective_from) or 19000101,
                        "effective_to_n": date_to_int(v.effective_to) or 99991231,
                        "states": sorted(set(st)),
                        "national": "US" in st,
                        "contractor_ids": sorted(set(contractors.get(v.id, []))),
                        "codes": codes.get(v.id, []),
                        "parent_id": str(c.parent_id) if c.parent_id else None,
                        "ordinal": c.ordinal,
                        "char_start": c.char_start,
                        "char_end": c.char_end,
                        "header": c.header,
                        "text": c.text,
                    },
                )
            )
        await store.upsert(physical, points)
        await progress(
            0.05 + 0.75 * min(1.0, (start + len(batch)) / max(1, total)),
            f"indexed {start + len(batch)}/{total} (embedded {embedded}, reused {reused})",
        )

    # mark chunks as indexed
    if chunks and dense_ok:
        await session.execute(
            update(PolicyChunk)
            .where(PolicyChunk.id.in_([c.id for c in chunks]))
            .values(embed_model=model_id, indexed_at=datetime.now(UTC))
        )
    await rebuild_fts(session, [(str(c.id), f"{c.header}\n{c.text}") for c in chunks])
    await progress(0.85, "rebuilt full-text channel")

    points = await store.count(physical)
    iv.points = points
    iv.stats = {
        **(iv.stats or {}),
        "chunks": total,
        "embedded": embedded,
        "reused": reused,
        "avgdl": round(avgdl, 2),
        "degraded": degraded,
        "buildSeconds": round(time.perf_counter() - t0, 1),
        "versions": len(versions),
        "builtAt": date.today().isoformat(),
    }
    iv.status = "ready"
    await session.flush()

    if smoke_eval:
        # Commit so the smoke eval's own sessions (FTS + SQL-exact channels) see this run's rows.
        # Safe: the alias is not switched until the eval passes.
        await session.commit()
        await progress(0.9, "running retrieval smoke eval")
        from app.ai.retrieval.smoke import run_smoke_eval

        result = await run_smoke_eval(session, physical=physical)
        iv.stats = {**iv.stats, "smoke": result}
        if not result.get("passed", False):
            iv.status = "failed"
            await session.flush()
            log.warning("index.smoke_failed", physical=physical, result=result)
            return iv
    if activate:
        await activate_index(session, iv)
    await progress(1.0, f"index {physical} {iv.status}")
    return iv


async def activate_index(session: AsyncSession, iv: IndexVersion) -> IndexVersion:
    store = await get_vectorstore()
    previous = await store.activate(iv.alias, iv.physical_name)
    await session.execute(
        update(IndexVersion)
        .where(IndexVersion.alias == iv.alias, IndexVersion.status == "active", IndexVersion.id != iv.id)
        .values(status="retired")
    )
    iv.status = "active"
    iv.activated_at = datetime.now(UTC)
    iv.stats = {**(iv.stats or {}), "previous": previous}
    await session.flush()
    return iv


async def rollback_index(session: AsyncSession, alias: str = ALIAS) -> IndexVersion | None:
    store = await get_vectorstore()
    candidates = list(
        (
            await session.execute(
                select(IndexVersion)
                .where(IndexVersion.alias == alias, IndexVersion.status.in_(["retired", "ready"]))
                .order_by(IndexVersion.activated_at.desc().nullslast(), IndexVersion.created_at.desc())
            )
        ).scalars()
    )
    for iv in candidates:
        if await store.collection_exists(iv.physical_name):
            return await activate_index(session, iv)
    return None


async def prune_old_indexes(session: AsyncSession, keep: int = 2, alias: str = ALIAS) -> list[str]:
    """Free-tier storage hygiene: drop retired physical collections beyond the newest `keep`."""
    store: VectorStore = await get_vectorstore()
    rows = list(
        (
            await session.execute(
                select(IndexVersion)
                .where(IndexVersion.alias == alias, IndexVersion.status.in_(["retired", "failed"]))
                .order_by(IndexVersion.created_at.desc())
            )
        ).scalars()
    )
    dropped = []
    for iv in rows[keep:]:
        await store.drop_collection(iv.physical_name)
        iv.status = "deleted"
        dropped.append(iv.physical_name)
    await session.flush()
    return dropped
