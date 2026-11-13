"""Rate limiting (OWASP LLM10 / API abuse).

Backends: Redis fixed-window counters (shared across replicas) when `REDIS_URL` is set, otherwise an
in-memory sliding-window log. Auth endpoints get a much stricter bucket (credential stuffing).
"""

from __future__ import annotations

import asyncio
import math
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any

import structlog
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.clientip import resolve_client_ip
from app.core.config import get_settings
from app.core.errors import problem

log = structlog.get_logger(__name__)

_AUTH_SENSITIVE = (
    "/auth/login",
    "/auth/signup",
    "/auth/password/forgot",
    "/auth/password/reset",
    "/auth/mfa/verify",
)
_EXEMPT_SUFFIXES = ("/health", "/health/ready", "/metrics")
_EXEMPT_STREAM_HINT = ("/events", "/stream")


@dataclass
class Decision:
    allowed: bool
    limit: int
    remaining: int
    reset_s: int


class InMemoryLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = asyncio.Lock()

    async def hit(self, key: str, limit: int, window_s: int = 60) -> Decision:
        now = time.monotonic()
        async with self._lock:
            q = self._hits[key]
            while q and now - q[0] >= window_s:
                q.popleft()
            if len(q) >= limit:
                reset = math.ceil(window_s - (now - q[0])) if q else window_s
                return Decision(False, limit, 0, max(reset, 1))
            q.append(now)
            return Decision(True, limit, limit - len(q), window_s)

    def reset(self) -> None:
        self._hits.clear()


class RedisLimiter:
    def __init__(self, client: Any) -> None:
        self._r = client

    async def hit(self, key: str, limit: int, window_s: int = 60) -> Decision:
        bucket = int(time.time() // window_s)
        rkey = f"necessa:rl:{key}:{bucket}"
        count = await self._r.incr(rkey)
        if count == 1:
            await self._r.expire(rkey, window_s + 1)
        reset = window_s - int(time.time() % window_s)
        return Decision(count <= limit, limit, max(limit - count, 0), reset)

    def reset(self) -> None:  # pragma: no cover - not used in tests
        pass


class _LimiterHolder:
    def __init__(self) -> None:
        self._impl: InMemoryLimiter | RedisLimiter | None = None

    def get(self) -> InMemoryLimiter | RedisLimiter:
        if self._impl is None:
            url = get_settings().redis_url
            if url:
                try:
                    import redis.asyncio as aioredis

                    self._impl = RedisLimiter(aioredis.from_url(url, decode_responses=True))
                except Exception as exc:  # pragma: no cover
                    log.warning("ratelimit_redis_unavailable", error=str(exc))
            if self._impl is None:
                self._impl = InMemoryLimiter()
        return self._impl

    def reset(self) -> None:
        if self._impl is not None:
            self._impl.reset()


limiter = _LimiterHolder()


def _client_key(scope: Scope) -> str:
    headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
    client = scope.get("client")
    peer = client[0] if client else None
    return resolve_client_ip(peer, headers.get("x-forwarded-for")) or "unknown"


class RateLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope.get("path", "")
        if (
            path.endswith(_EXEMPT_SUFFIXES)
            or any(h in path for h in _EXEMPT_STREAM_HINT)
            or scope.get("method") == "OPTIONS"
        ):
            await self.app(scope, receive, send)
            return
        s = get_settings()
        sensitive = any(path.endswith(p) for p in _AUTH_SENSITIVE)
        limit = s.auth_rate_limit_per_minute if sensitive else s.rate_limit_per_minute
        bucket = "auth" if sensitive else "api"
        try:
            decision = await limiter.get().hit(f"{bucket}:{_client_key(scope)}", limit)
        except Exception as exc:  # fail open on limiter infra errors, but log loudly
            log.error("ratelimit_backend_error", error=str(exc))
            await self.app(scope, receive, send)
            return
        rl_headers = [
            (b"x-ratelimit-limit", str(decision.limit).encode()),
            (b"x-ratelimit-remaining", str(decision.remaining).encode()),
            (b"x-ratelimit-reset", str(decision.reset_s).encode()),
        ]
        if not decision.allowed:
            resp = problem(
                429,
                "Too many requests",
                code="rate_limited",
                detail=(
                    f"Rate limit of {decision.limit} requests/minute exceeded. Retry in {decision.reset_s}s."
                ),
                headers={"Retry-After": str(decision.reset_s)},
            )
            resp.raw_headers.extend(rl_headers)
            await resp(scope, receive, send)
            return

        async def send_with_headers(message: dict) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + rl_headers
            await send(message)

        await self.app(scope, receive, send_with_headers)
