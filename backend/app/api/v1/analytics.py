"""Operational analytics (KPIs, trends, team workload) and the org activity feed."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import RequestContext, get_db, require_perm
from app.schemas.cases import ActivityItem, AnalyticsOverviewOut, TeamMemberLoad
from app.services import analytics as analytics_svc

router = APIRouter(tags=["analytics"])

_RANGES = {"7d": 7, "30d": 30, "90d": 90, "180d": 180, "365d": 365}


@router.get("/analytics/overview", response_model=AnalyticsOverviewOut)
async def overview(
    range: str = Query("30d", pattern=r"^(7d|30d|90d|180d|365d)$"),
    ctx: RequestContext = Depends(require_perm("analytics:read")),
    db: AsyncSession = Depends(get_db),
):
    return await analytics_svc.overview(db, ctx.org_id, _RANGES[range])


@router.get("/analytics/team", response_model=list[TeamMemberLoad])
async def team(
    ctx: RequestContext = Depends(require_perm("analytics:read")), db: AsyncSession = Depends(get_db)
):
    return await analytics_svc.team(db, ctx.org_id)


@router.get("/activity", response_model=list[ActivityItem])
async def activity(
    limit: int = Query(40, ge=1, le=200),
    before: datetime | None = None,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
):
    return await analytics_svc.activity(db, ctx.org_id, limit=limit, before=before)
