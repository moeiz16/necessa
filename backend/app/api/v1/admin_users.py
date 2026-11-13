"""Platform administration: users/orgs (superuser) and system info (org admins)."""

from __future__ import annotations

import os
import platform
import subprocess
from functools import lru_cache

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import BACKEND_ROOT, get_settings
from app.core.deps import RequestContext, get_db, require_perm, require_superuser
from app.db.models.platform import DEFAULT_ORG_SETTINGS, Membership, Organization, User
from app.schemas.platform import OrgOut, UserOut

router = APIRouter(prefix="/admin", tags=["admin"])


@lru_cache
def _git_sha() -> str | None:
    if os.environ.get("GIT_SHA"):
        return os.environ["GIT_SHA"]
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607 - read-only, fixed argv
            cwd=BACKEND_ROOT,
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


@router.get("/users", response_model=list[UserOut])
async def list_users(
    _: RequestContext = Depends(require_superuser),
    db: AsyncSession = Depends(get_db),
    q: str | None = Query(None, max_length=120),
    limit: int = Query(100, ge=1, le=500),
):
    stmt = select(User)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(func.lower(User.email).like(like) | func.lower(User.full_name).like(like))
    rows = (await db.execute(stmt.order_by(User.created_at.desc()).limit(limit))).scalars().all()
    return [UserOut.model_validate(u) for u in rows]


@router.get("/orgs", response_model=list[OrgOut])
async def list_orgs(
    _: RequestContext = Depends(require_superuser),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(100, ge=1, le=500),
):
    counts = dict(
        (
            await db.execute(
                select(Membership.org_id, func.count())
                .where(Membership.status == "active")
                .group_by(Membership.org_id)
            )
        ).all()
    )
    rows = (
        (await db.execute(select(Organization).order_by(Organization.created_at.desc()).limit(limit)))
        .scalars()
        .all()
    )
    out = []
    for o in rows:
        item = OrgOut.model_validate(o)
        item.counts = {"members": counts.get(o.id, 0)}
        out.append(item)
    return out


@router.get("/system")
async def system_info(ctx: RequestContext = Depends(require_perm("org:admin"))) -> dict:
    s = get_settings()
    org_settings = {**DEFAULT_ORG_SETTINGS, **((ctx.org.settings if ctx.org else None) or {})}
    return {
        "app": s.app_name,
        "environment": s.environment,
        "gitSha": _git_sha(),
        "python": platform.python_version(),
        "database": "sqlite" if s.is_sqlite else "postgresql",
        "vectorStore": "qdrant-cloud" if s.qdrant_url else "qdrant-embedded",
        "cache": "redis" if s.redis_url else "in-process",
        "embedding": {"model": s.embedding_model, "dims": s.embedding_dims},
        "featureFlags": {
            "semanticCache": s.enable_semantic_cache,
            "llmRerankFallback": s.enable_llm_rerank_fallback,
            "demoMode": s.demo_mode,
        },
        "ingest": {"scope": s.ingest_scope, "cmsLicenseAccepted": s.accept_cms_license},
        "quotas": {
            "llmDailyTokenBudget": s.llm_daily_token_budget,
            "caseTokenBudget": s.case_token_budget,
            "qaTokenBudget": s.qa_token_budget,
            "rateLimitPerMinute": s.rate_limit_per_minute,
        },
        "dataRetentionDays": org_settings["dataRetentionDays"],
        "security": {
            "phiEncryptionKeyConfigured": bool(s.phi_encryption_key.get_secret_value()),
            "cookieSecure": s.cookie_secure,
            "accessTokenTtlMinutes": s.access_token_ttl_minutes,
            "requireMfa": org_settings["requireMfa"],
        },
    }
