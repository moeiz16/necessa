"""Pub/sub event bus + Server-Sent Events helpers.

* No `REDIS_URL`: in-process fan-out (single API instance, the default for local runs).
* With `REDIS_URL` (Upstash free tier): Redis pub/sub, so multiple API replicas share streams.

Channels: `case:{case_id}`, `job:{job_id}`, `org:{org_id}`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections import defaultdict, deque
from collections.abc import AsyncIterator
from typing import Any

import structlog
from sse_starlette.sse import EventSourceResponse

from app.core.config import get_settings

log = structlog.get_logger(__name__)

HEARTBEAT_SECONDS = 15.0
_QUEUE_MAX = 1000
_RECENT_MAX = 50
_REDIS_PREFIX = "necessa:events:"


class EventBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[tuple[str, dict]]]] = defaultdict(set)
        self._recent: dict[str, deque[tuple[str, dict]]] = defaultdict(lambda: deque(maxlen=_RECENT_MAX))
        self._redis: Any = None
        self._redis_checked = False

    def _redis_client(self) -> Any:
        if not self._redis_checked:
            self._redis_checked = True
            url = get_settings().redis_url
            if url:
                try:
                    import redis.asyncio as aioredis

                    self._redis = aioredis.from_url(url, decode_responses=True)
                except Exception as exc:  # pragma: no cover - depends on infra
                    log.warning("event_bus_redis_unavailable", error=str(exc))
        return self._redis

    def recent(self, channel: str) -> list[tuple[str, dict]]:
        return list(self._recent.get(channel, ()))

    async def publish(self, channel: str, event: str, data: dict) -> None:
        self._recent[channel].append((event, data))
        redis = self._redis_client()
        if redis is not None:
            try:
                await redis.publish(_REDIS_PREFIX + channel, json.dumps({"e": event, "d": data}, default=str))
                return
            except Exception as exc:  # pragma: no cover - infra
                log.warning("event_publish_redis_failed", channel=channel, error=str(exc))
        for q in list(self._subs.get(channel, ())):
            try:
                q.put_nowait((event, data))
            except asyncio.QueueFull:
                log.warning("event_queue_full_dropping", channel=channel)

    async def subscribe(self, channel: str) -> AsyncIterator[tuple[str, dict]]:
        redis = self._redis_client()
        if redis is not None:
            pubsub = redis.pubsub()
            await pubsub.subscribe(_REDIS_PREFIX + channel)
            try:
                async for msg in pubsub.listen():
                    if msg.get("type") != "message":
                        continue
                    payload = json.loads(msg["data"])
                    yield payload["e"], payload["d"]
            finally:
                with contextlib.suppress(Exception):
                    await pubsub.unsubscribe(_REDIS_PREFIX + channel)
                    await pubsub.aclose()
            return
        q: asyncio.Queue[tuple[str, dict]] = asyncio.Queue(maxsize=_QUEUE_MAX)
        self._subs[channel].add(q)
        try:
            while True:
                yield await q.get()
        finally:
            self._subs[channel].discard(q)
            if not self._subs[channel]:
                self._subs.pop(channel, None)

    def subscriber_count(self, channel: str) -> int:
        return len(self._subs.get(channel, ()))


bus = EventBus()


async def publish(channel: str, event: str, data: dict) -> None:
    await bus.publish(channel, event, data)


def subscribe(channel: str) -> AsyncIterator[tuple[str, dict]]:
    return bus.subscribe(channel)


def format_sse(event: str, data: dict) -> dict[str, str]:
    return {"event": event, "data": json.dumps(data, default=str, separators=(",", ":"))}


async def _with_heartbeat(
    channel: str, replay: list[tuple[str, dict]] | None, heartbeat: float
) -> AsyncIterator[dict[str, str]]:
    for event, data in replay or []:
        yield format_sse(event, data)
    stream = subscribe(channel).__aiter__()
    pending: asyncio.Task | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(stream.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=heartbeat)
            if not done:
                yield format_sse("heartbeat", {})
                continue
            try:
                event, data = pending.result()
            except StopAsyncIteration:
                return
            finally:
                pending = None
            yield format_sse(event, data)
    finally:
        if pending is not None:
            pending.cancel()
        with contextlib.suppress(Exception):
            await stream.aclose()  # type: ignore[attr-defined]


def sse_response(
    channel: str, *, replay: list[tuple[str, dict]] | None = None, heartbeat: float = HEARTBEAT_SECONDS
) -> EventSourceResponse:
    """Stream a channel as SSE. `replay` events are sent first (current state for late joiners)."""
    return EventSourceResponse(
        _with_heartbeat(channel, replay, heartbeat),
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        ping=None,
    )
