"""Background job handlers for knowledge & RAG (merged by app.services.jobs)."""

from __future__ import annotations

from typing import Any

import structlog

log = structlog.get_logger(__name__)


async def _ingest(ctx: Any, source: str) -> dict:
    from app.ai.ingestion.pipeline import run_ingestion

    params = ctx.params or {}
    async with ctx.session() as s:
        stats = await run_ingestion(
            s,
            source=source,
            scope=params.get("scope"),
            policy_keys=params.get("policyKeys"),
            limit=params.get("limit"),
            progress=ctx.progress,
            job_id=ctx.job_id,
            build_index=params.get("buildIndex", True),
            activate=params.get("activate", True),
        )
    await ctx.log(f"ingestion {source} finished: {stats.get('documents', 0)} documents")
    return stats


async def ingest_mcd(ctx: Any) -> dict:
    return await _ingest(ctx, "mcd")


async def ingest_fixtures(ctx: Any) -> dict:
    return await _ingest(ctx, "fixtures")


async def ingest_codesets(ctx: Any) -> dict:
    return await _ingest(ctx, "codesets")


async def ingest_download(ctx: Any) -> dict:
    from app.ai.ingestion.download import download_mcd

    await ctx.progress(0.05, "downloading CMS MCD exports (CSV only)")
    out = await download_mcd()
    await ctx.progress(1.0, "download complete")
    return out


async def index_activate(ctx: Any) -> dict:
    import uuid

    from app.ai.ingestion.indexer import activate_index, rollback_index
    from app.db.models.knowledge import IndexVersion

    params = ctx.params or {}
    async with ctx.session() as s:
        if params.get("rollback"):
            iv = await rollback_index(s, params.get("alias", "policy_chunks"))
        else:
            iv = await s.get(IndexVersion, uuid.UUID(params["indexVersionId"]))
            iv = await activate_index(s, iv) if iv else None
        return {"active": iv.physical_name if iv else None}


async def index_rebuild(ctx: Any) -> dict:
    from app.ai.ingestion.indexer import build_policy_index

    async with ctx.session() as s:
        iv = await build_policy_index(
            s, progress=ctx.progress, resume_physical=(ctx.params or {}).get("resume")
        )
        return {
            "indexVersionId": str(iv.id),
            "physical": iv.physical_name,
            "status": iv.status,
            **(iv.stats or {}),
        }


async def eval_retrieval(ctx: Any) -> dict:
    from app.ai.retrieval.smoke import run_smoke_eval
    from app.ai.vectorstore import get_vectorstore

    store = await get_vectorstore()
    physical = await store.current_physical("policy_chunks")
    if not physical:
        return {"passed": False, "reason": "no active index"}
    async with ctx.session() as s:
        return await run_smoke_eval(s, physical=physical, sample=int((ctx.params or {}).get("sample", 30)))


JOB_HANDLERS = {
    "ingest.mcd": ingest_mcd,
    "ingest.fixtures": ingest_fixtures,
    "ingest.codesets": ingest_codesets,
    "ingest.download": ingest_download,
    "index.activate": index_activate,
    "index.rebuild": index_rebuild,
    "eval.retrieval": eval_retrieval,
}
