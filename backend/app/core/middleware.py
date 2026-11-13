"""Pure-ASGI middleware (streaming/SSE safe): request id, timing, access log, metrics, security headers,
HTTP caching policy and response compression."""

from __future__ import annotations

import hashlib
import re
import time
import uuid

import structlog
from prometheus_client import Counter, Histogram
from starlette.datastructures import Headers, MutableHeaders
from starlette.middleware.gzip import GZipMiddleware, GZipResponder
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import get_settings
from app.core.logging import request_id_ctx
from app.db.session import query_stats

log = structlog.get_logger("necessa.access")

HTTP_REQUESTS = Counter("necessa_http_requests_total", "HTTP requests", ["method", "route", "status"])
HTTP_LATENCY = Histogram(
    "necessa_http_request_duration_seconds",
    "HTTP request latency",
    ["method", "route"],
    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
)
_RID_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        # Query counts/timings in Server-Timing help find N+1s from the browser; not exposed in prod.
        self.expose_db_timing = not get_settings().is_prod

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        incoming = headers.get("x-request-id", "")
        rid = incoming if _RID_RE.match(incoming) else uuid.uuid4().hex
        token = request_id_ctx.set(rid)
        stats: dict[str, float] = {"count": 0, "ms": 0.0}
        stats_token = query_stats.set(stats)
        started = time.perf_counter()
        status_holder = {"status": 500}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                elapsed_ms = (time.perf_counter() - started) * 1000
                timing = f"app;dur={elapsed_ms:.1f}"
                if self.expose_db_timing:
                    timing += f', db;desc="{int(stats["count"])} queries";dur={stats["ms"]:.1f}'
                extra = [
                    (b"x-request-id", rid.encode()),
                    (b"server-timing", timing.encode()),
                ]
                message["headers"] = list(message.get("headers", [])) + extra
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            elapsed = time.perf_counter() - started
            route = scope.get("route")
            route_path = getattr(route, "path", None) or "unmatched"
            method = scope.get("method", "GET")
            HTTP_REQUESTS.labels(method, route_path, str(status_holder["status"])).inc()
            HTTP_LATENCY.labels(method, route_path).observe(elapsed)
            if not scope.get("path", "").endswith(("/health", "/metrics")):
                log.info(
                    "request",
                    method=method,
                    path=scope.get("path"),
                    route=route_path,
                    status=status_holder["status"],
                    duration_ms=round(elapsed * 1000, 1),
                    db_queries=int(stats["count"]),
                )
            query_stats.reset(stats_token)
            request_id_ctx.reset(token)


_API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
_DOCS_CSP = (
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "img-src 'self' data: https://fastapi.tiangolo.com; "
    "frame-ancestors 'none'"
)


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.hsts = get_settings().is_prod

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope.get("path", "")
        csp = _DOCS_CSP if path.startswith(("/docs", "/redoc", "/openapi")) else _API_CSP

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                hdrs = [
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=()"),
                    (b"cross-origin-opener-policy", b"same-origin"),
                    (b"content-security-policy", csp.encode()),
                ]
                if self.hsts:
                    hdrs.append((b"strict-transport-security", b"max-age=63072000; includeSubDomains"))
                existing = {k.lower() for k, _ in message.get("headers", [])}
                message["headers"] = list(message.get("headers", [])) + [
                    h for h in hdrs if h[0] not in existing
                ]
            await send(message)

        await self.app(scope, receive, send_wrapper)


# ── HTTP caching ─────────────────────────────────────────────────────────────
# Read-only knowledge endpoints (coverage policies, codes, coverage graph) change only when the knowledge
# base is re-ingested, and their JSON is the largest the API serves. They get a short PRIVATE browser
# cache plus a validator: a repeat view is either served from the browser cache or revalidated with
# If-None-Match for a body-less 304. `private` + `Vary: Authorization, Cookie` because results include
# tenant-owned payer policies, so no shared cache may store them and a different login never reuses them.
# Compiled criteria are reviewed/approved by admins, so those always revalidate (`no-cache` + ETag).
# Everything else under the API (cases, PHI, analytics) is `no-store`. Responses that set their own
# Cache-Control (e.g. SSE's `no-cache, no-transform`) are left untouched.
KNOWLEDGE_CACHE_CONTROL = "private, max-age=60, stale-while-revalidate=300"
REVALIDATE_CACHE_CONTROL = "private, no-cache"
KNOWLEDGE_RESOURCES = ("policies", "codes")
_ALWAYS_REVALIDATE = re.compile(r"/criteria/?$")


def _etag_matches(if_none_match: str, etag: str) -> bool:
    if if_none_match.strip() == "*":
        return True
    opaque = etag.removeprefix("W/")
    return any(tag.strip().removeprefix("W/") == opaque for tag in if_none_match.split(","))


class HTTPCacheMiddleware:
    def __init__(self, app: ASGIApp, *, api_prefix: str = "/api/v1") -> None:
        self.app = app
        self.api_prefix = api_prefix
        self._knowledge_path = re.compile(
            rf"^{re.escape(api_prefix)}/({'|'.join(KNOWLEDGE_RESOURCES)})(/|$)"
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path: str = scope.get("path", "")
        if not path.startswith(self.api_prefix):
            await self.app(scope, receive, send)
            return
        method = scope.get("method", "GET")
        if method in ("GET", "HEAD") and self._knowledge_path.match(path):
            await self._knowledge(scope, receive, send)
            return

        async def send_no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                headers = MutableHeaders(scope=message)
                if "cache-control" not in headers:
                    headers["Cache-Control"] = "no-store"
            await send(message)

        await self.app(scope, receive, send_no_store)

    async def _knowledge(self, scope: Scope, receive: Receive, send: Send) -> None:
        request_headers = Headers(scope=scope)
        if_none_match = request_headers.get("if-none-match", "")
        path: str = scope.get("path", "")
        cache_control = (
            REVALIDATE_CACHE_CONTROL if _ALWAYS_REVALIDATE.search(path) else KNOWLEDGE_CACHE_CONTROL
        )
        start: Message | None = None
        passthrough = False

        async def send_wrapper(message: Message) -> None:
            nonlocal start, passthrough
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                headers = MutableHeaders(scope=message)
                if message["status"] != 200 or "cache-control" in headers:
                    if "cache-control" not in headers:  # errors (401/404/429...) are never cacheable
                        headers["Cache-Control"] = "no-store"
                    passthrough = True
                    await send(message)
                    return
                start = message  # hold until we have the body
                return
            if passthrough or start is None or message["type"] != "http.response.body":
                await send(message)
                return
            headers = MutableHeaders(scope=start)
            headers["Cache-Control"] = cache_control
            headers.add_vary_header("Authorization")
            headers.add_vary_header("Cookie")
            body = message.get("body", b"")
            if message.get("more_body", False):  # streamed: no validator, just the cache policy
                passthrough = True
                await send(start)
                await send(message)
                return
            etag = f'W/"{hashlib.blake2b(body, digest_size=16).hexdigest()}"'
            headers["ETag"] = etag
            if if_none_match and _etag_matches(if_none_match, etag):
                del headers["content-length"]
                del headers["content-type"]
                start["status"] = 304
                await send(start)
                await send({"type": "http.response.body", "body": b"", "more_body": False})
                return
            await send(start)
            await send(message)

        await self.app(scope, receive, send_wrapper)


# ── Compression ──────────────────────────────────────────────────────────────
class _NoTransformAwareGZip(GZipResponder):
    """Starlette's GZip responder, plus: never touch a response that says `Cache-Control: no-transform`
    (our SSE streams send it, so a stream is never buffered or gzipped even if its media type changes)."""

    _bypass = False

    async def send_with_compression(self, message: Message) -> None:
        if message["type"] == "http.response.start":
            cc = Headers(raw=message.get("headers", [])).get("cache-control", "")
            self._bypass = "no-transform" in cc.lower()
        if self._bypass:
            await self.send(message)
            return
        await super().send_with_compression(message)


class CompressionMiddleware(GZipMiddleware):
    """gzip for JSON (and other text) responses >= `minimum_size`; never for `text/event-stream` (excluded
    by Starlette's defaults) or `no-transform` responses. Level 6 is ~zlib's default: nearly level-9 ratios
    on JSON at a fraction of the CPU, which matters because compression runs on the event loop."""

    def __init__(self, app: ASGIApp, minimum_size: int = 1024, compresslevel: int = 6) -> None:
        super().__init__(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and "gzip" in Headers(scope=scope).get("accept-encoding", ""):
            responder = _NoTransformAwareGZip(
                self.app,
                self.minimum_size,
                compresslevel=self.compresslevel,
                thread_minimum_size=self.thread_minimum_size,
                exclude_content_types=self.exclude_content_types,
            )
            await responder(scope, receive, send)
            return
        await super().__call__(scope, receive, send)
