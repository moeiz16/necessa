from __future__ import annotations

import asyncio
import uuid

from sqlalchemy import select, update

from app.db.models.platform import AuditLog, Job
from app.db.session import session_scope
from app.services import jobs as jobs_svc
from app.services.audit import audit, verify_chain
from tests.conftest import create_case, signup_with_org


async def test_audit_chain_verify_and_tamper_detection(client):
    owner = await signup_with_org(client)
    await create_case(owner)
    await owner.patch("/api/v1/users/me", json={"title": "Director"})
    r = (await owner.get("/api/v1/audit/verify")).json()
    assert r["valid"] is True and r["checked"] >= 2

    org_id = uuid.UUID(owner.org["id"])
    async with session_scope() as db:
        victim = (
            await db.execute(select(AuditLog).where(AuditLog.org_id == org_id).order_by(AuditLog.id).limit(1))
        ).scalar_one()
        await db.execute(update(AuditLog).where(AuditLog.id == victim.id).values(action="case.deleted"))
    r = (await owner.get("/api/v1/audit/verify")).json()
    assert r["valid"] is False and r["brokenAt"] == victim.id

    listing = (await owner.get("/api/v1/audit", params={"limit": 2})).json()
    assert len(listing["items"]) == 2 and listing["nextCursor"]
    nxt = (await owner.get("/api/v1/audit", params={"limit": 2, "cursor": listing["nextCursor"]})).json()
    assert {i["id"] for i in nxt["items"]}.isdisjoint({i["id"] for i in listing["items"]})


async def test_system_chain_is_independent():
    async with session_scope() as db:
        await audit(db, None, action="system.test", metadata={"k": 1})
    async with session_scope() as db:
        assert (await verify_chain(db, None))["valid"] is True


async def _make_job(type_: str, params: dict | None = None) -> uuid.UUID:
    async with session_scope() as db:
        job = await jobs_svc.enqueue(db, type_, params or {}, org_id=None, created_by=None)
        return job.id


async def test_job_success_failure_and_missing_handler():
    calls: list[dict] = []

    @jobs_svc.register("test.ok")
    async def ok(ctx: jobs_svc.JobContext) -> dict:
        await ctx.progress(0.5, "halfway")
        async with ctx.session() as db:
            assert await db.get(Job, ctx.job_id) is not None
        calls.append(ctx.params)
        return {"answer": 42}

    @jobs_svc.register("test.boom")
    async def boom(ctx: jobs_svc.JobContext) -> dict:
        raise RuntimeError("kaboom")

    done = await jobs_svc.run_job_now(await _make_job("test.ok", {"x": 1}))
    assert done.status == "succeeded" and done.result == {"answer": 42} and done.progress == 1.0
    assert calls == [{"x": 1}]
    failed = await jobs_svc.run_job_now(await _make_job("test.boom"))
    assert failed.status == "failed" and "kaboom" in failed.error
    missing = await jobs_svc.run_job_now(await _make_job("test.nobody"))
    assert missing.status == "failed" and "No handler" in missing.error


async def test_runner_loop_and_restart_recovery():
    seen: list[str] = []

    @jobs_svc.register("test.loop")
    async def handler(ctx: jobs_svc.JobContext) -> dict:
        seen.append(str(ctx.job_id))
        return {}

    # A job left 'running' by a crashed process is requeued on boot.
    job_id = await _make_job("test.loop")
    async with session_scope() as db:
        await db.execute(update(Job).where(Job.id == job_id).values(status="running"))
    runner = jobs_svc.JobRunner(concurrency=2, poll_interval=0.05)
    await runner.start()
    try:
        second = await _make_job("test.loop")
        for _ in range(100):
            async with session_scope() as db:
                statuses = (
                    (await db.execute(select(Job.status).where(Job.id.in_([job_id, second])))).scalars().all()
                )
            if statuses and all(s == "succeeded" for s in statuses):
                break
            await asyncio.sleep(0.05)
        assert sorted(seen) == sorted([str(job_id), str(second)])
    finally:
        await runner.stop()


async def test_job_api_visibility(client, make_client):
    owner = await signup_with_org(client)
    other = await signup_with_org(make_client(), "Other Org")

    @jobs_svc.register("test.api")
    async def handler(ctx: jobs_svc.JobContext) -> dict:
        return {"ok": True}

    async with session_scope() as db:
        job = await jobs_svc.enqueue(
            db, "test.api", {}, org_id=uuid.UUID(owner.org["id"]), created_by=uuid.UUID(owner.user["id"])
        )
        job_id = job.id
    await jobs_svc.run_job_now(job_id)
    r = (await owner.get(f"/api/v1/jobs/{job_id}")).json()
    assert r["status"] == "succeeded" and r["result"] == {"ok": True}
    assert (await other.get(f"/api/v1/jobs/{job_id}")).status_code == 404
    assert any(j["id"] == str(job_id) for j in (await owner.get("/api/v1/jobs")).json())
    r = await owner.post(f"/api/v1/jobs/{job_id}/cancel")
    assert r.status_code == 409
