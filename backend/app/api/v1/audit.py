"""Audit trail browsing + hash-chain verification."""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import RequestContext, get_db, require_perm
from app.core.errors import bad_request
from app.db.models.platform import AuditLog, User
from app.schemas.base import Page
from app.schemas.platform import AuditEntryOut, AuditVerifyOut
from app.services.audit import audit, verify_chain

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("", response_model=Page[AuditEntryOut])
async def list_audit(
    ctx: RequestContext = Depends(require_perm("audit:read")),
    db: AsyncSession = Depends(get_db),
    actor: str | None = None,
    action: str | None = Query(None, max_length=80, description="Exact action or prefix ending with '*'"),
    resource_type: str | None = Query(None, alias="resourceType"),
    resource_id: str | None = Query(None, alias="resourceId"),
    from_: datetime | None = Query(None, alias="from"),
    to: datetime | None = None,
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
):
    conds = [AuditLog.org_id == ctx.org_id]
    if actor:
        try:
            conds.append(AuditLog.actor_id == uuid.UUID(actor))
        except ValueError as exc:
            raise bad_request("invalid_actor", "actor must be a user id.") from exc
    if action:
        conds.append(
            AuditLog.action.like(action[:-1] + "%") if action.endswith("*") else AuditLog.action == action
        )
    if resource_type:
        conds.append(AuditLog.resource_type == resource_type)
    if resource_id:
        conds.append(AuditLog.resource_id == resource_id)
    if from_:
        conds.append(AuditLog.created_at >= from_)
    if to:
        conds.append(AuditLog.created_at <= to)
    total = (await db.execute(select(func.count()).select_from(AuditLog).where(*conds))).scalar_one()
    q = select(AuditLog).where(*conds)
    if cursor and cursor.isdigit():
        q = q.where(AuditLog.id < int(cursor))
    rows = (await db.execute(q.order_by(AuditLog.id.desc()).limit(limit + 1))).scalars().all()
    nxt = str(rows[limit - 1].id) if len(rows) > limit else None
    rows = rows[:limit]
    uids = {r.actor_id for r in rows if r.actor_id}
    names = (
        dict((await db.execute(select(User.id, User.full_name).where(User.id.in_(uids)))).all())
        if uids
        else {}
    )
    items = [
        AuditEntryOut(
            id=r.id,
            actor_id=r.actor_id,
            actor_name=names.get(r.actor_id),
            actor_type=r.actor_type,
            action=r.action,
            resource_type=r.resource_type,
            resource_id=r.resource_id,
            ip=r.ip,
            user_agent=r.user_agent,
            metadata=r.meta or {},
            hash=r.hash,
            prev_hash=r.prev_hash,
            created_at=r.created_at,
        )
        for r in rows
    ]
    return Page[AuditEntryOut](items=items, next_cursor=nxt, total=total)


@router.get("/verify", response_model=AuditVerifyOut)
async def verify(
    ctx: RequestContext = Depends(require_perm("audit:read")), db: AsyncSession = Depends(get_db)
):
    result = await verify_chain(db, ctx.org_id)
    await audit(
        db,
        ctx,
        action="audit.chain_verified",
        resource_type="organization",
        resource_id=ctx.org_id,
        metadata={"valid": result["valid"], "checked": result["checked"]},
    )
    return AuditVerifyOut(valid=result["valid"], checked=result["checked"], broken_at=result["brokenAt"])
