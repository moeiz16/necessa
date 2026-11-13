"""Knowledge ops: ingestion runs, index versions (blue/green activate / rollback)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.ingestion.indexer import activate_index, rollback_index
from app.ai.vectorstore import get_vectorstore
from app.core.deps import RequestContext, get_db, require_perm
from app.core.errors import bad_request, not_found
from app.db.models.knowledge import IndexVersion, IngestionRun
from app.schemas.knowledge import IndexVersionOut, IngestionRunIn, IngestionRunOut
from app.services.audit import audit
from app.services.jobs import enqueue, job_to_dict

router = APIRouter(prefix="/admin", tags=["admin"])


def _run_out(r: IngestionRun) -> IngestionRunOut:
    return IngestionRunOut(
        id=str(r.id),
        source=r.source,
        scope=r.scope or {},
        status=r.status,
        stats=r.stats or {},
        error=r.error,
        started_at=r.started_at,
        finished_at=r.finished_at,
        job_id=str(r.job_id) if r.job_id else None,
    )


def _iv_out(iv: IndexVersion) -> IndexVersionOut:
    return IndexVersionOut(
        id=str(iv.id),
        alias=iv.alias,
        physical_name=iv.physical_name,
        embed_model=iv.embed_model,
        dims=iv.dims,
        sparse_model=iv.sparse_model,
        status=iv.status,
        points=iv.points,
        stats=iv.stats or {},
        created_at=iv.created_at,
        activated_at=iv.activated_at,
    )


@router.post("/ingestion/runs", status_code=202)
async def start_ingestion(
    body: IngestionRunIn,
    ctx: RequestContext = Depends(require_perm("knowledge:admin")),
    db: AsyncSession = Depends(get_db),
):
    job = await enqueue(
        db,
        f"ingest.{body.source}",
        {"scope": body.scope, "policyKeys": body.policy_keys, "limit": body.limit},
        org_id=ctx.org_id,
        created_by=ctx.user.id,
    )
    await audit(
        db,
        ctx,
        action="knowledge.ingestion_started",
        resource_type="job",
        resource_id=job.id,
        metadata={"source": body.source, "scope": body.scope},
    )
    return {"job": job_to_dict(job)}


@router.post("/ingestion/download", status_code=202)
async def download_mcd(
    ctx: RequestContext = Depends(require_perm("knowledge:admin")), db: AsyncSession = Depends(get_db)
):
    job = await enqueue(db, "ingest.download", {}, org_id=ctx.org_id, created_by=ctx.user.id)
    await audit(db, ctx, action="knowledge.download_started", resource_type="job", resource_id=job.id)
    return {"job": job_to_dict(job)}


@router.get("/ingestion/runs", response_model=list[IngestionRunOut])
async def list_runs(
    ctx: RequestContext = Depends(require_perm("knowledge:admin")),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(30, ge=1, le=100),
):
    rows = (
        await db.execute(select(IngestionRun).order_by(IngestionRun.started_at.desc()).limit(limit))
    ).scalars()
    return [_run_out(r) for r in rows]


@router.get("/indexes", response_model=list[IndexVersionOut])
async def list_indexes(
    ctx: RequestContext = Depends(require_perm("knowledge:admin")),
    db: AsyncSession = Depends(get_db),
    alias: str | None = None,
):
    stmt = select(IndexVersion).order_by(IndexVersion.created_at.desc()).limit(50)
    if alias:
        stmt = stmt.where(IndexVersion.alias == alias)
    rows = list((await db.execute(stmt)).scalars())
    store = await get_vectorstore()
    active = await store.current_physical("policy_chunks")
    out = []
    for iv in rows:
        o = _iv_out(iv)
        if active and iv.physical_name == active:
            o.status = "active"
        out.append(o)
    return out


@router.post("/indexes/{index_id}/activate", response_model=IndexVersionOut)
async def activate(
    index_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("knowledge:admin")),
    db: AsyncSession = Depends(get_db),
):
    iv = await db.get(IndexVersion, index_id)
    if iv is None:
        raise not_found("Index version")
    if iv.status not in {"ready", "retired", "active", "failed"}:
        raise bad_request("index_not_ready", f"Index is {iv.status}.")
    store = await get_vectorstore()
    if not await store.collection_exists(iv.physical_name):
        raise bad_request("collection_missing", "The physical collection no longer exists.")
    iv = await activate_index(db, iv)
    await audit(
        db,
        ctx,
        action="knowledge.index_activated",
        resource_type="index_version",
        resource_id=iv.id,
        metadata={"physical": iv.physical_name},
    )
    return _iv_out(iv)


@router.post("/indexes/rollback", response_model=IndexVersionOut)
async def rollback(
    alias: str = Query("policy_chunks"),
    ctx: RequestContext = Depends(require_perm("knowledge:admin")),
    db: AsyncSession = Depends(get_db),
):
    iv = await rollback_index(db, alias)
    if iv is None:
        raise bad_request("nothing_to_rollback", "No previous index version is available.")
    await audit(
        db,
        ctx,
        action="knowledge.index_rollback",
        resource_type="index_version",
        resource_id=iv.id,
        metadata={"alias": alias, "physical": iv.physical_name},
    )
    return _iv_out(iv)
