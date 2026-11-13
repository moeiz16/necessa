"""Necessa API — application factory."""

from __future__ import annotations

import importlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.core.config import get_settings
from app.core.errors import install_error_handlers
from app.core.logging import configure_logging
from app.core.middleware import RequestContextMiddleware, SecurityHeadersMiddleware
from app.core.ratelimit import RateLimitMiddleware

log = structlog.get_logger("necessa")

# (module, owner). Platform routers must exist; B/C routers are optional so the API always boots.
PLATFORM_ROUTERS = (
    "auth",
    "users",
    "orgs",
    "cases",
    "notifications",
    "audit",
    "jobs",
    "analytics",
    "feedback",
    "admin_users",
)
OPTIONAL_ROUTERS = (
    "policies",
    "codes",
    "search",
    "assistant",
    "admin_knowledge",
    "admin_models",  # knowledge & RAG
    "case_ai",
    "admin_criteria",
    "admin_evals",
)  # case intelligence

OPENAPI_TAGS = [
    {"name": "auth", "description": "Sessions, MFA, password reset"},
    {"name": "organizations", "description": "Onboarding, members, invitations, API keys"},
    {"name": "cases", "description": "Prior-authorization cases, documents, timeline"},
    {"name": "case-ai", "description": "Criteria evaluation, letters, denials (assistive AI)"},
    {"name": "knowledge", "description": "Coverage policies, codes, coverage graph"},
    {"name": "assistant", "description": "Ask Necessa — hybrid RAG assistant"},
    {"name": "analytics", "description": "KPIs, trends, activity"},
    {"name": "admin", "description": "Knowledge ops, models, evals, system"},
    {"name": "health", "description": "Liveness, readiness, metrics"},
]


def _load_routers() -> tuple[list[APIRouter], list[str]]:
    routers: list[APIRouter] = []
    missing: list[str] = []
    for name in PLATFORM_ROUTERS:
        routers.append(importlib.import_module(f"app.api.v1.{name}").router)
    for name in OPTIONAL_ROUTERS:
        try:
            mod = importlib.import_module(f"app.api.v1.{name}")
        except ModuleNotFoundError as exc:
            if exc.name in (f"app.api.v1.{name}",):
                missing.append(name)
                continue
            log.exception("optional_router_import_failed", router=name)
            missing.append(name)
            continue
        except Exception:
            log.exception("optional_router_import_failed", router=name)
            missing.append(name)
            continue
        routers.append(mod.router)
    return routers, missing


async def _bootstrap_schema() -> None:
    """Dev/test convenience on SQLite. Postgres schemas are managed by Alembic (`necessa db upgrade`)."""
    import app.db.models  # noqa: F401  (register all tables)
    from app.db.base import Base
    from app.db.session import get_engine

    async with get_engine().begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def _maybe_seed_demo() -> None:
    from sqlalchemy import select

    from app.db.models.platform import Job
    from app.db.session import session_scope
    from app.services.jobs import enqueue, get_handlers

    if "demo.seed" not in get_handlers():
        log.warning("demo_mode_without_seed_handler")
        return
    async with session_scope() as db:
        already = (await db.execute(select(Job.id).where(Job.type == "demo.seed").limit(1))).first()
        if not already:
            await enqueue(db, "demo.seed", {}, org_id=None, created_by=None)
            log.info("demo_seed_enqueued")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    from app.services.jobs import runner

    s = get_settings()
    if s.is_sqlite or s.environment in ("dev", "test"):
        await _bootstrap_schema()
    if getattr(s, "jobs_inline", True):
        await runner.start()
    if s.demo_mode:
        await _maybe_seed_demo()
    log.info(
        "necessa_started",
        environment=s.environment,
        db="sqlite" if s.is_sqlite else "postgresql",
        missing_routers=app.state.missing_routers,
    )
    try:
        yield
    finally:
        await runner.stop()
        from app.db.session import get_engine

        await get_engine().dispose()


def create_app() -> FastAPI:
    s = get_settings()
    configure_logging(s.log_level, s.log_json)
    app = FastAPI(
        title="Necessa API",
        version="0.1.0",
        description=(
            "Medical-necessity intelligence for prior authorization and denial appeals. "
            "Necessa reports **documentation readiness** — it never makes a coverage decision."
        ),
        openapi_tags=OPENAPI_TAGS,
        lifespan=lifespan,
        docs_url="/docs" if not s.is_prod else None,
        redoc_url="/redoc" if not s.is_prod else None,
    )
    install_error_handlers(app)

    # Starlette applies middleware in reverse order of addition: the last added is outermost.
    app.add_middleware(RateLimitMiddleware)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-CSRF-Token", "X-Request-ID"],
        expose_headers=["X-Request-ID", "X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After"],
    )
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RequestContextMiddleware)

    from app.api.v1.health import router as health_router

    app.include_router(health_router)  # /health, /health/ready, /metrics at the root for probes
    app.include_router(health_router, prefix=s.api_prefix, include_in_schema=False)
    routers, missing = _load_routers()
    for r in routers:
        app.include_router(r, prefix=s.api_prefix)
    app.state.missing_routers = missing
    if missing:
        log.warning("optional_routers_missing", routers=missing)
    return app


app = create_app()
