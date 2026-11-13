"""Background job status + live progress stream."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.core.deps import RequestContext, get_ctx, get_db
from app.core.errors import AppError, not_found
from app.core.events import bus, sse_response
from app.db.models.platform import Job
from app.schemas.platform import JobOut
from app.services.audit import audit
from app.services.jobs import runner

router = APIRouter(prefix="/jobs", tags=["jobs"])
_TERMINAL = {"succeeded", "failed", "cancelled"}


async def _get_job(db: AsyncSession, ctx: RequestContext, job_id: uuid.UUID) -> Job:
    job = await db.get(Job, job_id)
    # Org jobs are visible to members; platform jobs (org_id NULL) only to superusers.
    if not job or (job.org_id != ctx.org_id and not (job.org_id is None and ctx.user.is_superuser)):
        raise not_found("Job")
    return job


@router.get("", response_model=list[JobOut])
async def list_jobs(
    ctx: RequestContext = Depends(get_ctx),
    db: AsyncSession = Depends(get_db),
    type: str | None = None,
    status: str | None = None,
    limit: int = Query(50, ge=1, le=200),
):
    q = select(Job).where(Job.org_id == ctx.org_id)
    if type:
        q = q.where(Job.type == type)
    if status:
        q = q.where(Job.status.in_(status.split(",")))
    rows = (await db.execute(q.order_by(Job.created_at.desc()).limit(limit))).scalars().all()
    return [JobOut.model_validate(j) for j in rows]


@router.get("/{job_id}", response_model=JobOut)
async def get_job(
    job_id: uuid.UUID, ctx: RequestContext = Depends(get_ctx), db: AsyncSession = Depends(get_db)
):
    return JobOut.model_validate(await _get_job(db, ctx, job_id))


@router.get("/{job_id}/events")
async def job_events(
    job_id: uuid.UUID, ctx: RequestContext = Depends(get_ctx), db: AsyncSession = Depends(get_db)
) -> EventSourceResponse:
    job = await _get_job(db, ctx, job_id)
    replay: list[tuple[str, dict]] = [("progress", {"progress": job.progress, "message": job.message or ""})]
    if job.status == "succeeded":
        replay.append(("completed", {"result": job.result or {}}))
    elif job.status in ("failed", "cancelled"):
        replay.append(("failed", {"error": job.error or job.status}))
    else:
        replay.extend(e for e in bus.recent(f"job:{job_id}") if e[0] == "log")
    return sse_response(f"job:{job_id}", replay=replay)


@router.post("/{job_id}/cancel", response_model=JobOut)
async def cancel_job(
    job_id: uuid.UUID, ctx: RequestContext = Depends(get_ctx), db: AsyncSession = Depends(get_db)
):
    job = await _get_job(db, ctx, job_id)
    if job.status in _TERMINAL:
        raise AppError(409, "job_finished", "Job already finished", f"Job is {job.status}.")
    if job.created_by != ctx.user.id and not ctx.has("org:admin"):
        raise AppError(403, "forbidden", "Forbidden", "Only the creator or an admin can cancel this job.")
    if job.status == "queued":
        job.status, job.error = "cancelled", "Cancelled before start"
    else:
        runner.cancel(job.id)
    await audit(
        db, ctx, action="job.cancelled", resource_type="job", resource_id=job.id, metadata={"type": job.type}
    )
    return JobOut.model_validate(job)
