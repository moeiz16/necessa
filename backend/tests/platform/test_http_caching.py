"""HTTP caching policy, compression and pagination caps."""

from __future__ import annotations

import gzip

import httpx
from starlette.applications import Starlette
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from app.core.events import SSE_HEADERS
from app.core.middleware import (
    KNOWLEDGE_CACHE_CONTROL,
    REVALIDATE_CACHE_CONTROL,
    CompressionMiddleware,
    HTTPCacheMiddleware,
)
from tests.conftest import create_case, signup_with_org


async def test_knowledge_reads_get_private_cache_and_etag_revalidation(client):
    owner = await signup_with_org(client)
    r = await owner.get("/api/v1/policies", params={"limit": 5})
    assert r.status_code == 200
    assert r.headers["cache-control"] == KNOWLEDGE_CACHE_CONTROL
    vary = {v.strip().lower() for v in r.headers["vary"].split(",")}
    assert {"authorization", "cookie"} <= vary  # per-login: payer uploads are tenant data
    etag = r.headers["etag"]
    assert etag.startswith('W/"')

    again = await owner.get("/api/v1/policies", params={"limit": 5}, headers={"If-None-Match": etag})
    assert again.status_code == 304 and again.content == b"" and again.headers["etag"] == etag
    assert "content-type" not in again.headers and again.headers["cache-control"] == KNOWLEDGE_CACHE_CONTROL
    stale = await owner.get("/api/v1/policies", params={"limit": 5}, headers={"If-None-Match": 'W/"nope"'})
    assert stale.status_code == 200 and stale.json() == r.json()

    codes = await owner.get("/api/v1/codes/search", params={"q": "E0601"})
    assert codes.status_code == 200 and codes.headers["cache-control"] == KNOWLEDGE_CACHE_CONTROL


async def test_admin_editable_criteria_always_revalidate():
    async def criteria(request):
        return JSONResponse({"status": "approved", "tree": {"op": "AND", "children": []}})

    app = Starlette(routes=[Route("/api/v1/policies/{ref}/criteria", criteria)])
    app.add_middleware(HTTPCacheMiddleware, api_prefix="/api/v1")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/v1/policies/L33718/criteria")
        assert r.headers["cache-control"] == REVALIDATE_CACHE_CONTROL == "private, no-cache"
        again = await c.get("/api/v1/policies/L33718/criteria", headers={"If-None-Match": r.headers["etag"]})
        assert again.status_code == 304 and again.content == b""


async def test_tenant_data_and_errors_are_never_cached(client):
    anon = await client.get("/api/v1/policies")
    assert anon.status_code == 401 and anon.headers["cache-control"] == "no-store"
    assert "etag" not in anon.headers
    owner = await signup_with_org(client)
    await create_case(owner)
    for url in ("/api/v1/cases", "/api/v1/analytics/overview", "/api/v1/notifications"):
        r = await owner.get(url)
        assert r.status_code == 200 and r.headers["cache-control"] == "no-store", url
        assert "etag" not in r.headers
    missing = await owner.get("/api/v1/policies/L00000")
    assert missing.status_code == 404 and missing.headers["cache-control"] == "no-store"


async def test_json_is_gzipped_when_accepted(client):
    owner = await signup_with_org(client)
    for _ in range(4):
        await create_case(owner)
    r = await owner.get("/api/v1/cases", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers["content-encoding"] == "gzip"
    assert "accept-encoding" in r.headers["vary"].lower() and len(r.json()["items"]) == 4
    plain = await owner.get("/api/v1/cases", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.json() == r.json()


def _mini_app() -> Starlette:
    big = {"items": [{"id": i, "text": "documentation requirement " * 4} for i in range(60)]}

    async def as_json(request):
        return JSONResponse(big)

    async def no_transform(request):
        return JSONResponse(big, headers={"Cache-Control": "no-cache, no-transform"})

    async def sse(request):
        async def gen():
            for i in range(50):
                yield f"event: tick\ndata: {{\"i\": {i}, \"pad\": \"{'x' * 64}\"}}\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)

    app = Starlette(
        routes=[
            Route("/api/v1/json", as_json),
            Route("/api/v1/no-transform", no_transform),
            Route("/api/v1/sse", sse),
        ]
    )
    app.add_middleware(HTTPCacheMiddleware, api_prefix="/api/v1")
    app.add_middleware(CompressionMiddleware, minimum_size=1024)
    return app


async def test_compression_never_touches_event_streams_or_no_transform():
    transport = httpx.ASGITransport(app=_mini_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.get("/api/v1/json", headers={"Accept-Encoding": "gzip"})
        assert r.headers["content-encoding"] == "gzip" and len(r.json()["items"]) == 60
        assert r.headers["cache-control"] == "no-store"

        s = await c.get("/api/v1/sse", headers={"Accept-Encoding": "gzip"})
        assert "content-encoding" not in s.headers
        assert s.headers["cache-control"] == SSE_HEADERS["Cache-Control"]  # untouched by the cache policy
        assert s.text.count("event: tick") == 50  # plain text on the wire, not gzip bytes

        nt = await c.get("/api/v1/no-transform", headers={"Accept-Encoding": "gzip"})
        assert "content-encoding" not in nt.headers
        assert nt.headers["cache-control"] == "no-cache, no-transform"
        raw = nt.content
        assert raw[:2] != b"\x1f\x8b" and len(gzip.compress(raw)) < len(raw)  # compressible, left alone


async def test_pagination_caps(client):
    owner = await signup_with_org(client)
    case = await create_case(owner)
    base = f"/api/v1/cases/{case['id']}"
    await owner.post(f"{base}/comments", json={"body": "one"})
    await owner.post(f"{base}/comments", json={"body": "two"})
    assert len((await owner.get(f"{base}/timeline")).json()) == 3
    assert len((await owner.get(f"{base}/timeline", params={"limit": 1})).json()) == 1
    assert (await owner.get(f"{base}/timeline", params={"limit": 501})).status_code == 422
    assert (await owner.get(f"{base}/documents", params={"limit": 0})).status_code == 422
    assert (await owner.get("/api/v1/cases", params={"limit": 101})).status_code == 422
