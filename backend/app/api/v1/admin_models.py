"""Models & providers console: routing table, health, quota, usage, cache, system info."""

from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import Integer, case, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import cache as cache_mod
from app.ai.llm.router import get_llm_router
from app.ai.llm.types import LLMError
from app.core.config import get_settings
from app.core.deps import RequestContext, get_db, require_perm
from app.db.models.knowledge import LLMCall
from app.schemas.base import APIModel
from app.services.audit import audit

router = APIRouter(prefix="/admin", tags=["admin"])


class ModelTestIn(APIModel):
    group: str = Field(min_length=2, max_length=48)


@router.get("/models")
async def models_status(ctx: RequestContext = Depends(require_perm("knowledge:admin"))):
    return await get_llm_router().status()


@router.get("/models/usage")
async def models_usage(
    range_: str = Query("7d", alias="range", pattern=r"^\d{1,3}[dh]$"),
    ctx: RequestContext = Depends(require_perm("knowledge:admin")),
    db: AsyncSession = Depends(get_db),
):
    n = int(range_[:-1])
    since = datetime.now(UTC) - (timedelta(days=n) if range_.endswith("d") else timedelta(hours=n))
    base = [LLMCall.created_at >= since]
    if not ctx.user.is_superuser:  # tenants see their own usage; platform totals are operator-only
        base.append(LLMCall.org_id == ctx.org_id)
    by = (
        await db.execute(
            select(
                LLMCall.provider,
                LLMCall.model,
                LLMCall.group,
                func.count(),
                func.sum(LLMCall.prompt_tokens),
                func.sum(LLMCall.completion_tokens),
                func.avg(LLMCall.latency_ms),
                func.sum(case((LLMCall.status != "ok", 1), else_=0)),
                func.sum(cast(LLMCall.cache_hit, Integer)),
                func.sum(cast(LLMCall.fallback_used, Integer)),
            )
            .where(*base)
            .group_by(LLMCall.provider, LLMCall.model, LLMCall.group)
        )
    ).all()
    day = func.date(LLMCall.created_at)
    daily = (
        await db.execute(
            select(
                day,
                LLMCall.provider,
                func.count(),
                func.sum(LLMCall.prompt_tokens + LLMCall.completion_tokens),
            )
            .where(*base)
            .group_by(day, LLMCall.provider)
            .order_by(day)
        )
    ).all()
    blocked = (await db.execute(select(func.count()).where(*base, LLMCall.status == "blocked"))).scalar_one()
    return {
        "range": range_,
        "byDeployment": [
            {
                "provider": p,
                "model": m,
                "group": g,
                "calls": c,
                "promptTokens": int(pt or 0),
                "completionTokens": int(ct or 0),
                "avgLatencyMs": round(float(lat or 0)),
                "errors": int(err or 0),
                "cacheHits": int(ch or 0),
                "fallbacks": int(fb or 0),
            }
            for p, m, g, c, pt, ct, lat, err, ch, fb in by
        ],
        "daily": [{"date": str(d), "provider": p, "calls": c, "tokens": int(t or 0)} for d, p, c, t in daily],
        "blockedByPolicy": blocked,
        "costUsd": 0.0,
    }


@router.post("/models/test")
async def models_test(
    body: ModelTestIn,
    ctx: RequestContext = Depends(require_perm("knowledge:admin")),
    db: AsyncSession = Depends(get_db),
):
    router_ = get_llm_router()
    try:
        res = await router_.complete(
            group=body.group,
            purpose="admin.model_test",
            cache=False,
            max_tokens=40,
            messages=[{"role": "user", "content": "Reply with the single word: ready"}],
        )
        out = {
            "ok": True,
            "provider": res.provider,
            "model": res.model,
            "latencyMs": res.latency_ms,
            "sample": res.text[:80],
            "fallbackUsed": res.fallback_used,
        }
    except LLMError as exc:
        out = {"ok": False, "error": str(exc)[:300]}
    await audit(
        db,
        ctx,
        action="admin.model_test",
        resource_type="model_group",
        resource_id=body.group,
        metadata={"ok": out["ok"]},
    )
    return out


@router.get("/cache/stats")
async def cache_stats(ctx: RequestContext = Depends(require_perm("knowledge:admin"))):
    return cache_mod.stats()


@router.post("/cache/flush")
async def cache_flush(
    ctx: RequestContext = Depends(require_perm("knowledge:admin")), db: AsyncSession = Depends(get_db)
):
    res = await cache_mod.flush_all()
    await audit(db, ctx, action="admin.cache_flushed", resource_type="cache", metadata=res)
    return res


def _git_sha() -> str | None:
    sha = os.environ.get("GIT_SHA")
    if sha:
        return sha
    try:
        return (
            subprocess.run(
                ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            ).stdout.strip()
            or None
        )
    except Exception:
        return None


@router.get("/system/ai")
async def ai_system_info(ctx: RequestContext = Depends(require_perm("knowledge:admin"))):
    s = get_settings()
    router_ = get_llm_router()
    status = await router_.status()
    return {
        "environment": s.environment,
        "version": "0.1.0",
        "gitSha": _git_sha(),
        "database": "sqlite" if s.is_sqlite else "postgresql",
        "vectorStore": "qdrant-cloud" if s.qdrant_url and s.qdrant_url != ":memory:" else "qdrant-embedded",
        "cache": cache_mod.stats()["backend"],
        "llmFake": bool(status.get("fake")),
        "configuredProviders": sorted(
            {d["provider"] for g in status["groups"] for d in g["deployments"] if d["configured"]}
        ),
        "embedding": status["embedding"],
        "featureFlags": {
            "semanticCache": s.enable_semantic_cache,
            "llmRerankFallback": s.enable_llm_rerank_fallback,
            "demoMode": s.demo_mode,
        },
        "budgets": {
            "dailyTokens": s.llm_daily_token_budget,
            "perCase": s.case_token_budget,
            "perQa": s.qa_token_budget,
        },
        "ingestScope": s.ingest_scope,
    }
