"""Short-lived, per-organization caching for hot read-only aggregates (dashboard KPIs, worklist stats).

Correctness model (why this is safe for tenant data):

* Keys always include the org id, so a value computed for one tenant is never served to another.
* Keys also include the org's *generation*. Every committed ORM write to a row that carries an
  `org_id` bumps that org's generation (SQLAlchemy session events below), so a user who changes a case
  sees fresh numbers on the very next request in this process. Bulk ORM UPDATE/DELETE statements on
  org-scoped tables bump every org (we can't cheaply tell which org they touched).
* A short TTL bounds staleness for writes made by *other* processes/replicas (e.g. a separate job
  worker), which can't bump this process's generations.
* Bookkeeping tables that never feed a cached aggregate (audit log, notifications, jobs, LLM telemetry,
  sessions) don't invalidate, so routine auditing doesn't defeat the cache.

Cached values are shared between requests: treat them as immutable.
"""

from __future__ import annotations

import time
import uuid
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Hashable
from typing import Any, TypeVar

from sqlalchemy import event
from sqlalchemy.orm import ORMExecuteState, Session, UOWTransaction

T = TypeVar("T")

# Tables whose writes never change a cached aggregate.
_NON_INVALIDATING_TABLES = frozenset(
    {"audit_log", "notifications", "jobs", "llm_calls", "response_cache", "sessions", "feedback"}
)
# Knowledge-base content (public CMS + tenant payer uploads): a committed write bumps the knowledge
# generation, which keys caches of retrieval results.
_KNOWLEDGE_TABLES = frozenset(
    {
        "states",
        "contractors",
        "contractor_states",
        "policies",
        "policy_versions",
        "policy_sections",
        "policy_chunks",
        "policy_links",
        "policy_contractors",
        "policy_states",
        "policy_codes",
        "policy_code_groups",
        "codes",
        "index_versions",
        "criteria_sets",
    }
)
_INFO_ORGS = "necessa_written_orgs"
_INFO_ALL = "necessa_written_all_orgs"
_INFO_KNOWLEDGE = "necessa_written_knowledge"


class OrgCache:
    def __init__(self, maxsize: int = 2048) -> None:
        self.maxsize = maxsize
        self.enabled = True
        self._data: OrderedDict[tuple, tuple[float, Any]] = OrderedDict()
        self._gen: dict[uuid.UUID, int] = {}
        self._global_gen = 0
        self.knowledge_generation = 0
        self.hits = 0
        self.misses = 0

    # ── invalidation ─────────────────────────────────────────────────────────
    def generation(self, org_id: uuid.UUID) -> tuple[int, int]:
        return self._global_gen, self._gen.get(org_id, 0)

    def bump(self, org_id: uuid.UUID | None = None) -> None:
        """Invalidate one org (or every org when `org_id` is None)."""
        if org_id is None:
            self._global_gen += 1
        else:
            self._gen[org_id] = self._gen.get(org_id, 0) + 1

    def clear(self) -> None:
        self._data.clear()

    # ── lookup ───────────────────────────────────────────────────────────────
    async def get_or_compute(
        self,
        namespace: str,
        org_id: uuid.UUID,
        key: Hashable,
        ttl_s: float,
        compute: Callable[[], Awaitable[T]],
    ) -> T:
        if not self.enabled or ttl_s <= 0:
            return await compute()
        # Read the generation BEFORE computing: a write that commits while we compute bumps it, so
        # the (possibly stale) value lands under an already-superseded key and is never served.
        k = (namespace, org_id, self.generation(org_id), key)
        now = time.monotonic()
        item = self._data.get(k)
        if item is not None and item[0] > now:
            self._data.move_to_end(k)
            self.hits += 1
            return item[1]
        self.misses += 1
        value = await compute()
        self._data[k] = (time.monotonic() + ttl_s, value)
        self._data.move_to_end(k)
        while len(self._data) > self.maxsize:
            self._data.popitem(last=False)
        return value

    def stats(self) -> dict[str, int]:
        return {"entries": len(self._data), "hits": self.hits, "misses": self.misses}


org_cache = OrgCache()


class TTLCache:
    """Tiny in-process LRU with per-entry TTL (monotonic clock). Values are shared: treat as immutable."""

    def __init__(self, maxsize: int = 512, ttl_s: float = 60.0) -> None:
        self.maxsize = maxsize
        self.ttl_s = ttl_s
        self.enabled = True
        self._data: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()

    def get(self, key: Hashable) -> Any | None:
        if not self.enabled:
            return None
        item = self._data.get(key)
        if item is None:
            return None
        if item[0] <= time.monotonic():
            self._data.pop(key, None)
            return None
        self._data.move_to_end(key)
        return item[1]

    def set(self, key: Hashable, value: Any) -> None:
        if not self.enabled:
            return
        self._data[key] = (time.monotonic() + self.ttl_s, value)
        self._data.move_to_end(key)
        while len(self._data) > self.maxsize:
            self._data.popitem(last=False)

    def clear(self) -> None:
        self._data.clear()


# ── write tracking (SQLAlchemy session events) ───────────────────────────────
def _invalidates_org(table_name: str | None) -> bool:
    return table_name not in _NON_INVALIDATING_TABLES


def _after_flush(session: Session, _ctx: UOWTransaction) -> None:
    orgs: set[uuid.UUID] | None = None
    for obj in (*session.new, *session.dirty, *session.deleted):
        table = getattr(obj, "__tablename__", None)
        if table in _KNOWLEDGE_TABLES:
            session.info[_INFO_KNOWLEDGE] = True
        org_id = getattr(obj, "org_id", None)
        if org_id is not None and _invalidates_org(table):
            if orgs is None:
                orgs = session.info.setdefault(_INFO_ORGS, set())
            orgs.add(org_id)


def _do_orm_execute(state: ORMExecuteState) -> None:
    if not (state.is_update or state.is_delete or state.is_insert):
        return
    for mapper in state.all_mappers:
        table = getattr(mapper.local_table, "name", None)
        if table in _KNOWLEDGE_TABLES:
            state.session.info[_INFO_KNOWLEDGE] = True
        if (state.is_update or state.is_delete) and "org_id" in mapper.columns and _invalidates_org(table):
            state.session.info[_INFO_ALL] = True


def _after_commit(session: Session) -> None:
    orgs = session.info.pop(_INFO_ORGS, None)
    if session.info.pop(_INFO_ALL, False):
        org_cache.bump(None)
    for org_id in orgs or ():
        org_cache.bump(org_id)
    if session.info.pop(_INFO_KNOWLEDGE, False):
        org_cache.knowledge_generation += 1


_installed = False


def install_invalidation() -> None:
    """Idempotent: hook every ORM Session so committed org writes invalidate `org_cache`."""
    global _installed
    if _installed:
        return
    event.listen(Session, "after_flush", _after_flush)
    event.listen(Session, "do_orm_execute", _do_orm_execute)
    event.listen(Session, "after_commit", _after_commit)
    _installed = True
