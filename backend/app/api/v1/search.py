"""Retrieval inspector (`/search/retrieve`) and knowledge-base stats."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.retrieval.retriever import get_retriever
from app.ai.retrieval.types import PolicyFilters, RetrievalQuery
from app.core.deps import RequestContext, get_db, require_perm
from app.core.errors import bad_request
from app.db.models.knowledge import Code, IndexVersion, IngestionRun, Policy, PolicyChunk, PolicyVersion
from app.schemas.knowledge import KnowledgeStats, RetrieveRequest

router = APIRouter(tags=["knowledge"])

_FILTER_KEYS = {
    "asOf": "as_of",
    "states": "states",
    "payerType": "payer_type",
    "contractorIds": "contractor_ids",
    "docTypes": "doc_types",
    "codes": "codes",
    "policyVersionIds": "policy_version_ids",
    "sectionKeys": "section_keys",
    "sourceKeys": "source_keys",
    "includeHistory": "include_history",
}


@router.post("/search/retrieve")
async def retrieve(body: RetrieveRequest, ctx: RequestContext = Depends(require_perm("policies:read"))):
    kwargs = {}
    for k, v in (body.filters or {}).items():
        attr = _FILTER_KEYS.get(k, k)
        if attr not in PolicyFilters.__dataclass_fields__:
            raise bad_request("invalid_filter", f"Unknown filter '{k}'.")
        if attr == "as_of" and isinstance(v, str):
            v = date.fromisoformat(v)
        kwargs[attr] = v
    case_id = None
    if body.scope == "chart":
        if not body.case_id:
            raise bad_request("case_required", "scope=chart requires caseId.")
        case_id = uuid.UUID(body.case_id)
    res = await get_retriever().search(
        RetrievalQuery(
            text=body.query,
            org_id=ctx.org_id,
            scope=body.scope,
            filters=PolicyFilters(**kwargs),
            case_id=case_id,
            top_k=body.top_k,
            strategy=body.strategy,
        )
    )
    data = res.to_dict()
    return {
        "chunks": [
            {
                "chunkId": c["chunk_id"],
                "text": c["text"],
                "header": c["header"],
                "score": c["score"],
                "scores": c["scores"],
                "source": c["source"],
                "charStart": c["char_start"],
                "charEnd": c["char_end"],
            }
            for c in data["chunks"]
        ],
        "route": {_camel(k): v for k, v in data["route"].items()},
        "timings": data["timings"],
    }


def _camel(s: str) -> str:
    head, *rest = s.split("_")
    return head + "".join(p.title() for p in rest)


@router.get("/knowledge/stats", response_model=KnowledgeStats)
async def knowledge_stats(
    ctx: RequestContext = Depends(require_perm("policies:read")), db: AsyncSession = Depends(get_db)
):
    by_type = {
        t: n
        for t, n in (await db.execute(select(Policy.doc_type, func.count()).group_by(Policy.doc_type))).all()
    }
    versions = (await db.execute(select(func.count()).select_from(PolicyVersion))).scalar_one()
    chunks = (
        await db.execute(select(func.count()).select_from(PolicyChunk).where(PolicyChunk.level == "child"))
    ).scalar_one()
    codes = (await db.execute(select(func.count()).select_from(Code))).scalar_one()
    last = (
        (await db.execute(select(IngestionRun).order_by(IngestionRun.started_at.desc()).limit(1)))
        .scalars()
        .first()
    )
    active = (
        (
            await db.execute(
                select(IndexVersion)
                .where(IndexVersion.alias == "policy_chunks", IndexVersion.status == "active")
                .order_by(IndexVersion.activated_at.desc())
            )
        )
        .scalars()
        .first()
    )
    freshness = None
    if last and last.finished_at:
        freshness = round((datetime.now(UTC) - last.finished_at).total_seconds() / 86400, 2)
    return KnowledgeStats(
        policies=by_type,
        versions=versions,
        chunks=chunks,
        codes=codes,
        last_ingestion={
            "id": str(last.id),
            "source": last.source,
            "status": last.status,
            "stats": last.stats,
            "startedAt": last.started_at,
            "finishedAt": last.finished_at,
        }
        if last
        else None,
        active_index={
            "id": str(active.id),
            "physicalName": active.physical_name,
            "points": active.points,
            "embedModel": active.embed_model,
            "activatedAt": active.activated_at,
            "degraded": (active.stats or {}).get("degraded", []),
        }
        if active
        else None,
        freshness_days=freshness,
    )
