"""Liveness, readiness and Prometheus metrics."""

from __future__ import annotations

import asyncio
import time

import httpx
from fastapi import APIRouter, Depends, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import get_db

router = APIRouter(tags=["health"])
_STARTED = time.time()
_PROVIDER_KEYS = ("groq", "gemini", "openrouter", "cohere", "jina", "mistral", "cerebras")


@router.get("/health")
async def liveness() -> dict:
    return {"status": "ok", "uptimeS": round(time.time() - _STARTED, 1)}


async def _check_db(db: AsyncSession) -> dict:
    t = time.perf_counter()
    try:
        await db.execute(text("SELECT 1"))
        return {
            "status": "ok",
            "latencyMs": round((time.perf_counter() - t) * 1000, 1),
            "dialect": db.bind.dialect.name if db.bind else None,
        }
    except Exception as exc:
        return {"status": "down", "error": type(exc).__name__}


async def _check_qdrant() -> dict:
    s = get_settings()
    if not s.qdrant_url:
        return {"status": "embedded", "detail": "QDRANT_URL not set; using local embedded mode"}
    headers = {"api-key": s.qdrant_api_key.get_secret_value()} if s.qdrant_api_key.get_secret_value() else {}
    t = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(s.qdrant_url.rstrip("/") + "/healthz", headers=headers)
        ok = r.status_code == 200
        return {"status": "ok" if ok else "down", "latencyMs": round((time.perf_counter() - t) * 1000, 1)}
    except httpx.HTTPError as exc:
        return {"status": "down", "error": type(exc).__name__}


async def _check_redis() -> dict:
    s = get_settings()
    if not s.redis_url:
        return {"status": "not_configured", "detail": "in-process fallbacks active"}
    try:
        import redis.asyncio as aioredis

        client = aioredis.from_url(s.redis_url, socket_timeout=3)
        await asyncio.wait_for(client.ping(), timeout=3)
        await client.aclose()
        return {"status": "ok"}
    except Exception as exc:
        return {"status": "down", "error": type(exc).__name__}


def _providers() -> dict:
    s = get_settings()
    configured = [p for p in _PROVIDER_KEYS if getattr(s, f"{p}_api_key").get_secret_value()]
    if s.github_models_token.get_secret_value():
        configured.append("github")
    groups: dict | None = None
    try:
        from app.ai.llm.router import get_llm_router

        groups = get_llm_router().configured_groups()
    except Exception:  # noqa: S110 - router is optional (workstream B) and may be unconfigured
        pass
    return {"status": "ok" if configured else "offline", "configured": configured, "groups": groups}


@router.get("/health/ready")
async def readiness(db: AsyncSession = Depends(get_db)) -> JSONResponse:
    database, qdrant, redis = await asyncio.gather(_check_db(db), _check_qdrant(), _check_redis())
    checks = {"database": database, "qdrant": qdrant, "redis": redis, "llmProviders": _providers()}
    critical_down = database["status"] == "down" or qdrant["status"] == "down"
    degraded = redis["status"] == "down" or checks["llmProviders"]["status"] == "offline"
    status = "down" if critical_down else "degraded" if degraded else "ok"
    return JSONResponse({"status": status, "checks": checks}, status_code=503 if critical_down else 200)


@router.get("/metrics", include_in_schema=False)
async def metrics() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
