"""Quota + budget tracking for free-tier deployments.

* Daily request/token counters per deployment (proactive skip before providers return 429).
* Cooldowns after rate limits / failures (honors Retry-After).
* Per-org daily token budget.

Backed by Redis when configured (shared across replicas), otherwise an in-process store.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime

import structlog

from app.ai.infra import get_redis
from app.core.config import get_settings

log = structlog.get_logger(__name__)


def _day() -> str:
    return datetime.now(UTC).strftime("%Y%m%d")


class QuotaTracker:
    def __init__(self) -> None:
        self._mem: dict[str, float] = {}
        self._cooldowns: dict[str, float] = {}
        self._latency: dict[str, list[int]] = {}
        self._errors: dict[str, list[int]] = {}  # rolling: 1 = error, 0 = ok

    # ── counters ────────────────────────────────────────────────────────────
    async def _incr(self, key: str, amount: float = 1, ttl: int = 2 * 86400) -> float:
        r = get_redis()
        if r is not None:
            try:
                val = await r.incrbyfloat(key, amount)
                await r.expire(key, ttl)
                return float(val)
            except Exception as exc:  # pragma: no cover - network
                log.warning("quota.redis_error", error=str(exc))
        self._mem[key] = self._mem.get(key, 0) + amount
        return self._mem[key]

    async def _get(self, key: str) -> float:
        r = get_redis()
        if r is not None:
            try:
                val = await r.get(key)
                return float(val or 0)
            except Exception:  # noqa: S110 - best-effort
                pass
        return self._mem.get(key, 0)

    async def record_request(self, deployment_id: str, tokens: int, latency_ms: int, ok: bool) -> None:
        await self._incr(f"nq:req:{deployment_id}:{_day()}")
        if tokens:
            await self._incr(f"nq:tok:{deployment_id}:{_day()}", tokens)
        lat = self._latency.setdefault(deployment_id, [])
        lat.append(latency_ms)
        del lat[:-200]
        errs = self._errors.setdefault(deployment_id, [])
        errs.append(0 if ok else 1)
        del errs[:-200]

    async def used_today(self, deployment_id: str) -> int:
        return int(await self._get(f"nq:req:{deployment_id}:{_day()}"))

    async def tokens_today(self, deployment_id: str) -> int:
        return int(await self._get(f"nq:tok:{deployment_id}:{_day()}"))

    async def over_daily_quota(self, deployment_id: str, rpd: int) -> bool:
        if rpd <= 0:
            return False
        return await self.used_today(deployment_id) >= int(rpd * 0.98)

    # ── cooldowns ───────────────────────────────────────────────────────────
    def cooldown(self, deployment_id: str, seconds: float) -> None:
        until = time.time() + max(1.0, seconds)
        self._cooldowns[deployment_id] = max(self._cooldowns.get(deployment_id, 0), until)

    def cooling_until(self, deployment_id: str) -> float | None:
        until = self._cooldowns.get(deployment_id)
        if until and until > time.time():
            return until
        return None

    # ── org budgets ─────────────────────────────────────────────────────────
    async def org_tokens_today(self, org_id: str) -> int:
        return int(await self._get(f"nq:org:{org_id}:{_day()}"))

    async def add_org_tokens(self, org_id: str, tokens: int) -> None:
        if tokens:
            await self._incr(f"nq:org:{org_id}:{_day()}", tokens)

    async def org_budget_ok(self, org_id: str | None, estimate: int) -> bool:
        if not org_id:
            return True
        budget = int(getattr(get_settings(), "llm_daily_token_budget", 2_000_000))
        return (await self.org_tokens_today(org_id)) + estimate <= budget

    # ── health snapshot for /admin/models ──────────────────────────────────
    def health(self, deployment_id: str) -> dict:
        lat = sorted(self._latency.get(deployment_id, []))
        errs = self._errors.get(deployment_id, [])
        p50 = lat[len(lat) // 2] if lat else None
        until = self.cooling_until(deployment_id)
        return {
            "p50LatencyMs": p50,
            "errorRate": round(sum(errs) / len(errs), 3) if errs else 0.0,
            "cooldownUntil": datetime.fromtimestamp(until, UTC).isoformat() if until else None,
            "healthy": until is None and (not errs or sum(errs[-10:]) < 5),
        }


_tracker: QuotaTracker | None = None


def get_quota_tracker() -> QuotaTracker:
    global _tracker
    if _tracker is None:
        _tracker = QuotaTracker()
    return _tracker


class RequestBudget:
    """Token budget for one logical operation (a case evaluation, a Q&A turn).

    Pass the same instance to every LLM call in the operation; `charge` raises BudgetExceeded
    when the operation would exceed its ceiling — the agent then ends gracefully with partial
    results instead of looping (answer to "50k recursive tool calls over the weekend").
    """

    def __init__(self, limit_tokens: int, label: str = "request") -> None:
        self.limit = int(limit_tokens)
        self.used = 0
        self.calls = 0
        self.label = label

    def remaining(self) -> int:
        return max(0, self.limit - self.used)

    def can_spend(self, estimate: int) -> bool:
        return self.used + estimate <= self.limit

    def charge(self, tokens: int) -> None:
        from app.ai.llm.types import BudgetExceeded

        self.used += int(tokens)
        self.calls += 1
        if self.used > self.limit:
            raise BudgetExceeded(f"{self.label} token budget exceeded ({self.used}/{self.limit})")
