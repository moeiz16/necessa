"""Evaluation dashboard API: runs, per-item results, gates, trigger a suite."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.evaluation.gates import GATES
from app.core.deps import RequestContext, get_db, require_perm
from app.core.errors import not_found
from app.db.models.evals import EvalResult, EvalRun
from app.schemas.evals import EvalRunIn

router = APIRouter(prefix="/admin/evals", tags=["admin-evals"])


def run_api(r: EvalRun) -> dict:
    return {
        "id": str(r.id),
        "suite": r.suite,
        "status": r.status,
        "metrics": r.metrics or {},
        "gates": r.gates or {},
        "config": r.config or {},
        "gitSha": r.git_sha,
        "itemsTotal": r.items_total,
        "itemsPassed": r.items_passed,
        "startedAt": r.started_at.isoformat() if r.started_at else None,
        "finishedAt": r.finished_at.isoformat() if r.finished_at else None,
        "error": r.error,
    }


@router.get("/runs")
async def list_runs(
    suite: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    ctx: RequestContext = Depends(require_perm("evals:read")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    q = select(EvalRun)
    if suite:
        q = q.where(EvalRun.suite == suite)
    rows = (await db.execute(q.order_by(EvalRun.started_at.desc()).limit(limit))).scalars().all()
    return [run_api(r) for r in rows]


@router.get("/summary")
async def summary(
    ctx: RequestContext = Depends(require_perm("evals:read")), db: AsyncSession = Depends(get_db)
) -> dict:
    rows = (await db.execute(select(EvalRun).order_by(EvalRun.started_at.desc()).limit(300))).scalars().all()
    latest: dict[str, dict] = {}
    history: dict[str, list[dict]] = {}
    for r in rows:
        latest.setdefault(r.suite, run_api(r))
        history.setdefault(r.suite, [])
        if len(history[r.suite]) < 20:
            history[r.suite].append(
                {
                    "id": str(r.id),
                    "startedAt": r.started_at.isoformat() if r.started_at else None,
                    "status": r.status,
                    "metrics": r.metrics or {},
                }
            )
    return {
        "latest": latest,
        "history": history,
        "gates": {
            s: [{"metric": g.metric, "op": g.op, "threshold": g.threshold} for g in gs]
            for s, gs in GATES.items()
        },
    }


@router.get("/runs/{run_id}")
async def get_run(
    run_id: uuid.UUID,
    failed_only: bool = False,
    limit: int = Query(500, ge=1, le=2000),
    ctx: RequestContext = Depends(require_perm("evals:read")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    r = await db.get(EvalRun, run_id)
    if r is None:
        raise not_found("Eval run")
    q = select(EvalResult).where(EvalResult.run_id == r.id)
    if failed_only:
        q = q.where(EvalResult.passed.is_(False))
    items = (await db.execute(q.order_by(EvalResult.id).limit(limit))).scalars().all()
    return {
        **run_api(r),
        "results": [
            {"itemId": i.item_id, "passed": i.passed, "metrics": i.metrics, "details": i.details}
            for i in items
        ],
    }


@router.post("/runs", status_code=202)
async def trigger_run(
    body: EvalRunIn,
    ctx: RequestContext = Depends(require_perm("knowledge:admin")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.services.audit import audit
    from app.services.jobs import enqueue, job_to_dict

    job = await enqueue(
        db,
        "eval.run",
        {"suite": body.suite, "limit": body.limit, "live": body.live},
        org_id=ctx.org_id,
        created_by=ctx.user.id,
    )
    await audit(
        db,
        ctx,
        action="evals.run",
        resource_type="job",
        resource_id=job.id,
        metadata={"suite": body.suite, "live": body.live},
    )
    return job_to_dict(job)
