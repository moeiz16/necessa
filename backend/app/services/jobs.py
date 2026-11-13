"""Durable background jobs backed by the `jobs` table, executed by an in-process asyncio worker.

Why not Celery: the free-tier footprint budget forbids another always-on process/broker; the DB queue
gives durability (queued jobs survive restarts and resume on boot) with zero extra infrastructure.
Swap in a dedicated worker process in prod by running `JobRunner` on its own (same code).

Handlers (`async def handler(ctx: JobContext) -> dict`) are registered by:
* `app.ai.jobs_rag.JOB_HANDLERS`   (knowledge & RAG)
* `app.ai.jobs_cases.JOB_HANDLERS` (case intelligence)
* `@register("type")` anywhere (tests, platform jobs)
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import structlog
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.events import publish
from app.db.base import utcnow
from app.db.models.platform import Job
from app.db.session import get_sessionmaker

log = structlog.get_logger(__name__)

JobHandler = Callable[["JobContext"], Awaitable[dict]]
_local_registry: dict[str, JobHandler] = {}
_HANDLER_MODULES = ("app.ai.jobs_rag", "app.ai.jobs_cases")


def register(job_type: str) -> Callable[[JobHandler], JobHandler]:
    def deco(fn: JobHandler) -> JobHandler:
        _local_registry[job_type] = fn
        return fn

    return deco


def get_handlers() -> dict[str, JobHandler]:
    handlers: dict[str, JobHandler] = {}
    for mod_name in _HANDLER_MODULES:
        try:
            mod = importlib.import_module(mod_name)
        except ModuleNotFoundError as exc:
            if exc.name and mod_name.startswith(exc.name):
                continue
            log.exception("job_handlers_import_failed", module=mod_name)
            continue
        except Exception:
            log.exception("job_handlers_import_failed", module=mod_name)
            continue
        handlers.update(getattr(mod, "JOB_HANDLERS", {}) or {})
    handlers.update(_local_registry)
    return handlers


@dataclass
class JobContext:
    job_id: uuid.UUID
    type: str
    org_id: uuid.UUID | None
    params: dict
    created_by: uuid.UUID | None
    _last_write: float = field(default=0.0, repr=False)
    _last_pct: float = field(default=0.0, repr=False)

    @property
    def channel(self) -> str:
        return f"job:{self.job_id}"

    @contextlib.asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        async with get_sessionmaker()() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def publish(self, event: str, data: dict) -> None:
        await publish(self.channel, event, data)

    async def progress(self, pct: float, message: str = "") -> None:
        pct = max(0.0, min(1.0, float(pct)))
        await self.publish("progress", {"progress": pct, "message": message})
        now = time.monotonic()
        if now - self._last_write >= 0.5 or pct - self._last_pct >= 0.05 or pct >= 1.0:
            self._last_write, self._last_pct = now, pct
            async with self.session() as s:
                await s.execute(
                    update(Job).where(Job.id == self.job_id).values(progress=pct, message=message[:500])
                )

    async def log(self, message: str, level: str = "info") -> None:
        await self.publish("log", {"level": level, "message": message})


async def enqueue(
    db: AsyncSession,
    type: str,
    params: dict | None = None,
    *,
    org_id: uuid.UUID | None,
    created_by: uuid.UUID | None,
) -> Job:
    job = Job(type=type, params=params or {}, org_id=org_id, created_by=created_by, status="queued")
    db.add(job)
    await db.flush()
    runner.wake()
    return job


def job_to_dict(job: Job) -> dict[str, Any]:
    return {
        "id": str(job.id),
        "type": job.type,
        "status": job.status,
        "progress": job.progress,
        "message": job.message,
        "params": job.params,
        "result": job.result,
        "error": job.error,
        "createdAt": job.created_at,
        "startedAt": job.started_at,
        "finishedAt": job.finished_at,
        "orgId": str(job.org_id) if job.org_id else None,
    }


class JobRunner:
    def __init__(self, concurrency: int = 2, poll_interval: float = 1.0) -> None:
        self.concurrency = concurrency
        self.poll_interval = poll_interval
        self._wake = asyncio.Event()
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._running: dict[uuid.UUID, asyncio.Task] = {}
        self._sem: asyncio.Semaphore | None = None

    def wake(self) -> None:
        with contextlib.suppress(RuntimeError):
            self._wake.set()

    async def start(self) -> None:
        if self._task:
            return
        self._wake = asyncio.Event()
        self._stop = asyncio.Event()
        self._sem = asyncio.Semaphore(self.concurrency)
        await self._recover()
        self._task = asyncio.create_task(self._loop(), name="necessa-job-runner")
        log.info("job_runner_started", concurrency=self.concurrency)

    async def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None
        for t in list(self._running.values()):
            t.cancel()
        self._running.clear()

    async def _recover(self) -> None:
        """Jobs left `running` by a crashed process are re-queued (handlers must be idempotent)."""
        async with get_sessionmaker()() as s:
            res = await s.execute(
                update(Job)
                .where(Job.status == "running")
                .values(status="queued", message="Resumed after restart")
            )
            await s.commit()
            if res.rowcount:
                log.warning("jobs_requeued_after_restart", count=res.rowcount)

    async def _claim(self) -> Job | None:
        async with get_sessionmaker()() as s:
            job = (
                await s.execute(select(Job).where(Job.status == "queued").order_by(Job.created_at).limit(1))
            ).scalar_one_or_none()
            if not job:
                return None
            res = await s.execute(
                update(Job)
                .where(Job.id == job.id, Job.status == "queued")
                .values(status="running", started_at=utcnow(), attempts=Job.attempts + 1)
            )
            await s.commit()
            if res.rowcount != 1:
                return None  # claimed by another worker
            await s.refresh(job)
            return job

    async def _loop(self) -> None:
        assert self._sem is not None
        while not self._stop.is_set():
            try:
                while len(self._running) < self.concurrency:
                    job = await self._claim()
                    if not job:
                        break
                    task = asyncio.create_task(self.execute(job), name=f"job-{job.id}")
                    self._running[job.id] = task
                    task.add_done_callback(lambda _t, jid=job.id: self._running.pop(jid, None))
            except Exception:
                log.exception("job_runner_loop_error")
            self._wake.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=self.poll_interval)

    async def execute(self, job: Job) -> None:
        """Run one claimed job to completion (also used directly by tests and the CLI)."""
        ctx = JobContext(
            job_id=job.id,
            type=job.type,
            org_id=job.org_id,
            params=dict(job.params or {}),
            created_by=job.created_by,
        )
        handler = get_handlers().get(job.type)
        if handler is None:
            await self._finish(job.id, "failed", error=f"No handler registered for job type '{job.type}'.")
            await ctx.publish("failed", {"error": f"No handler for '{job.type}'"})
            return
        log.info("job_started", job_id=str(job.id), type=job.type)
        try:
            result = await handler(ctx) or {}
        except asyncio.CancelledError:
            await self._finish(job.id, "cancelled", error="Cancelled")
            await ctx.publish("failed", {"error": "cancelled"})
            raise
        except Exception as exc:
            log.exception("job_failed", job_id=str(job.id), type=job.type)
            msg = f"{type(exc).__name__}: {exc}"[:2000]
            await self._finish(job.id, "failed", error=msg)
            await ctx.publish("failed", {"error": msg})
            return
        await self._finish(job.id, "succeeded", result=result)
        await ctx.publish("completed", {"result": result})
        log.info("job_succeeded", job_id=str(job.id), type=job.type)

    async def _finish(
        self, job_id: uuid.UUID, status: str, *, result: dict | None = None, error: str | None = None
    ) -> None:
        values: dict[str, Any] = {"status": status, "finished_at": utcnow(), "error": error}
        if status == "succeeded":
            values.update(progress=1.0, result=result)
        async with get_sessionmaker()() as s:
            await s.execute(update(Job).where(Job.id == job_id).values(**values))
            await s.commit()

    def cancel(self, job_id: uuid.UUID) -> bool:
        task = self._running.get(job_id)
        if task:
            task.cancel()
            return True
        return False


runner = JobRunner()


async def run_job_now(job_id: uuid.UUID) -> Job:
    """Synchronously execute a queued job (tests/CLI). Returns the refreshed row."""
    async with get_sessionmaker()() as s:
        job = await s.get(Job, job_id)
        if job is None:
            raise LookupError(job_id)
        job.status, job.started_at, job.attempts = "running", utcnow(), (job.attempts or 0) + 1
        await s.commit()
        await s.refresh(job)
    await runner.execute(job)
    async with get_sessionmaker()() as s:
        refreshed = await s.get(Job, job_id)
        assert refreshed is not None
        return refreshed
