"""Lazy shared clients (Redis) with graceful in-process fallback."""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Any

import structlog

from app.core.config import get_settings

log = structlog.get_logger(__name__)


@lru_cache
def get_redis() -> Any | None:
    """Return an asyncio Redis client when REDIS_URL is configured (Upstash free tier), else None."""
    url = get_settings().redis_url
    if not url:
        return None
    try:
        import redis.asyncio as aioredis

        return aioredis.from_url(url, decode_responses=True, socket_timeout=3, socket_connect_timeout=3)
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("redis.unavailable", error=str(exc))
        return None


def env_flag(name: str, default: bool = False) -> bool:
    val = getattr(get_settings(), name.lower(), None)
    if isinstance(val, bool):
        return val
    raw = os.environ.get(name.upper())
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def llm_fake_enabled() -> bool:
    return env_flag("LLM_FAKE") or get_settings().environment == "test"
