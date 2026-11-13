"""Non-blocking LLM call telemetry → `llm_calls` table + in-memory ring buffer + Prometheus."""

from __future__ import annotations

import asyncio
import collections
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime

import structlog

log = structlog.get_logger(__name__)

try:  # pragma: no cover - optional
    from prometheus_client import Counter, Histogram

    LLM_CALLS = Counter("necessa_llm_calls_total", "LLM calls", ["group", "provider", "status"])
    LLM_LATENCY = Histogram(
        "necessa_llm_latency_ms",
        "LLM latency (ms)",
        ["group", "provider"],
        buckets=(50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000),
    )
    LLM_TOKENS = Counter("necessa_llm_tokens_total", "LLM tokens", ["group", "provider", "kind"])
except Exception:  # pragma: no cover
    LLM_CALLS = LLM_LATENCY = LLM_TOKENS = None  # type: ignore[assignment]


@dataclass
class CallRecord:
    group: str
    purpose: str
    provider: str
    model: str
    data_class: str = "PUBLIC"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: int = 0
    cache_hit: bool = False
    fallback_used: bool = False
    attempt: int = 1
    status: str = "ok"
    error: str | None = None
    org_id: uuid.UUID | None = None
    request_id: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


RING: collections.deque[CallRecord] = collections.deque(maxlen=2000)
_pending: set[asyncio.Task] = set()
_db_enabled = True


def disable_db_writes() -> None:
    """Tests / CLI without tables can turn off persistence."""
    global _db_enabled
    _db_enabled = False


def enable_db_writes() -> None:
    global _db_enabled
    _db_enabled = True


async def _persist(rec: CallRecord) -> None:
    try:
        from app.db.models.knowledge import LLMCall
        from app.db.session import session_scope

        async with session_scope() as s:
            data = asdict(rec)
            if data.get("error"):
                data["error"] = str(data["error"])[:2000]
            s.add(LLMCall(**data))
    except Exception as exc:  # telemetry must never break the request path
        log.debug("telemetry.persist_failed", error=str(exc))


def record(rec: CallRecord) -> None:
    RING.append(rec)
    if LLM_CALLS is not None:
        try:
            LLM_CALLS.labels(rec.group, rec.provider, rec.status).inc()
            LLM_LATENCY.labels(rec.group, rec.provider).observe(rec.latency_ms)
            LLM_TOKENS.labels(rec.group, rec.provider, "prompt").inc(rec.prompt_tokens)
            LLM_TOKENS.labels(rec.group, rec.provider, "completion").inc(rec.completion_tokens)
        except Exception:  # noqa: S110 - best-effort
            pass
    if not _db_enabled:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(_persist(rec))
    _pending.add(task)
    task.add_done_callback(_pending.discard)


async def flush() -> None:
    if _pending:
        await asyncio.gather(*list(_pending), return_exceptions=True)


def recent(limit: int = 200) -> list[dict]:
    out = []
    for rec in list(RING)[-limit:]:
        d = asdict(rec)
        d["created_at"] = rec.created_at.isoformat()
        d["org_id"] = str(rec.org_id) if rec.org_id else None
        out.append(d)
    return out
