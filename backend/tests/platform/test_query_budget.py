"""Query-count regression tests: statements per request stay bounded and do not grow with the data.

Counts come from the per-request accounting in `app.db.session` (exposed as `Server-Timing: db;desc="N
queries"` outside prod). Every authenticated request pays exactly ONE statement for the auth context
(user + session + membership + org in a single join), so budgets below are "1 + endpoint work".
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime

import httpx

from app.core.cache import OrgCache, org_cache
from app.db.models.cases import Case, CaseEvaluation, CriterionResult, Denial
from app.db.session import session_scope
from tests.conftest import Account, add_member, create_case, signup_with_org

_DB = re.compile(r'db;desc="(\d+) queries"')


def statements(r: httpx.Response) -> int:
    m = _DB.search(r.headers.get("server-timing", ""))
    assert m, f"no db accounting in Server-Timing: {r.headers.get('server-timing')!r}"
    return int(m.group(1))


async def _get(acct: Account, url: str, **params) -> tuple[httpx.Response, int]:
    r = await acct.get(url, params=params or None)
    assert r.status_code == 200, (url, r.status_code, r.text[:200])
    return r, statements(r)


async def _seed_evaluation(org_id: str, case_id: str, n_criteria: int = 3) -> uuid.UUID:
    async with session_scope() as db:
        ev = CaseEvaluation(
            org_id=uuid.UUID(org_id),
            case_id=uuid.UUID(case_id),
            status="completed",
            readiness="gaps",
            readiness_score=0.5,
            finished_at=datetime.now(UTC),
        )
        db.add(ev)
        await db.flush()
        for i in range(n_criteria):
            db.add(
                CriterionResult(
                    org_id=ev.org_id,
                    evaluation_id=ev.id,
                    case_id=ev.case_id,
                    criterion_id=f"C{i}",
                    criterion_text=f"Criterion {i}",
                    verdict="INSUFFICIENT" if i % 2 else "MET",
                    confidence=0.4,
                )
            )
        case = await db.get(Case, ev.case_id)
        assert case is not None
        case.latest_evaluation_id = ev.id
        return ev.id


# Budgets: 1 auth statement + the endpoint's own (batched) statements. Before the batching work these
# were 4 auth statements + per-row lookups, e.g. the coverage graph issued 59 statements.
BUDGETS = {
    "/api/v1/analytics/overview": 7,  # cold (cache miss): 6 aggregate/range queries
    "/api/v1/activity": 3,
    "/api/v1/notifications": 3,  # list + unread count => auth is a single statement
    "/api/v1/cases": 5,
    "/api/v1/cases/stats": 2,
    "case": 5,
    "evaluations": 3,
    "evaluation": 5,
    "documents": 3,
    "timeline": 4,
    "next-actions": 5,
}


async def _measure(owner: Account, case_id: str, eval_id: uuid.UUID) -> dict[str, int]:
    org_cache.clear()  # measure the cold (uncached) path of cached aggregates
    out: dict[str, int] = {}
    for path, params in (
        ("/api/v1/analytics/overview", {"range": "30d"}),
        ("/api/v1/activity", {}),
        ("/api/v1/notifications", {}),
        ("/api/v1/cases", {"limit": 25}),
        ("/api/v1/cases/stats", {}),
    ):
        out[path] = (await _get(owner, path, **params))[1]
    base = f"/api/v1/cases/{case_id}"
    out["case"] = (await _get(owner, base))[1]
    out["evaluations"] = (await _get(owner, f"{base}/evaluations"))[1]
    out["evaluation"] = (await _get(owner, f"{base}/evaluations/{eval_id}"))[1]
    out["documents"] = (await _get(owner, f"{base}/documents"))[1]
    out["timeline"] = (await _get(owner, f"{base}/timeline"))[1]
    out["next-actions"] = (await _get(owner, f"{base}/next-actions"))[1]
    return out


async def test_statement_budgets_hold_and_do_not_grow_with_data(client, make_client):
    owner = await signup_with_org(client)
    member = await add_member(owner, make_client(), "coordinator")
    case = await create_case(owner)
    eval_id = await _seed_evaluation(owner.org["id"], case["id"])
    small = await _measure(owner, case["id"], eval_id)
    for key, budget in BUDGETS.items():
        assert small[key] <= budget, (key, small[key], budget)

    # Grow every collection these endpoints touch: more cases (different assignees and patients),
    # more timeline events from different actors, more criteria — the statement counts must not move.
    for i in range(6):
        c = await create_case(owner, assigneeId=member.user["id"] if i % 2 else None)
        await owner.post(f"/api/v1/cases/{c['id']}/comments", json={"body": f"note {i}"})
        await member.post(f"/api/v1/cases/{case['id']}/comments", json={"body": f"member note {i}"})
        await owner.post(f"/api/v1/cases/{case['id']}/comments", json={"body": f"owner note {i}"})
    await _seed_evaluation(owner.org["id"], case["id"], n_criteria=12)
    big = await _measure(owner, case["id"], eval_id)
    assert big == small, {k: (small[k], big[k]) for k in small if small[k] != big[k]}


async def test_overview_and_stats_cache_hits_then_invalidate_on_write(client):
    owner = await signup_with_org(client)
    await create_case(owner)
    org_cache.clear()
    r1, cold = await _get(owner, "/api/v1/analytics/overview", range="30d")
    r2, warm = await _get(owner, "/api/v1/analytics/overview", range="30d")
    assert cold > 1 and warm == 1  # warm: only the auth statement
    assert r1.json() == r2.json() and r1.json()["kpis"]["openCases"] == 1
    s1, stats_cold = await _get(owner, "/api/v1/cases/stats")
    s2, stats_warm = await _get(owner, "/api/v1/cases/stats")
    assert stats_cold == 2 and stats_warm == 1 and s1.json() == s2.json()

    # A write through the API is visible on the very next read (read-your-writes).
    await create_case(owner)
    r3, _ = await _get(owner, "/api/v1/analytics/overview", range="30d")
    assert r3.json()["kpis"]["openCases"] == 2
    assert (await _get(owner, "/api/v1/cases/stats"))[0].json()["total"] == 2

    # A write from outside a request (e.g. a background job's session) invalidates too.
    case_id = (await owner.get("/api/v1/cases")).json()["items"][0]["id"]
    async with session_scope() as db:
        db.add(
            Denial(org_id=uuid.UUID(owner.org["id"]), case_id=uuid.UUID(case_id), category="coding",
                   status="overturned")
        )
    r4, _ = await _get(owner, "/api/v1/analytics/overview", range="30d")
    assert r4.json()["kpis"]["appealsOverturned"] == 1
    assert r4.json()["denialReasons"] == [{"category": "coding", "count": 1}]


async def test_cached_aggregates_are_isolated_per_org_and_user(client, make_client):
    a = await signup_with_org(client, "Org A")
    b = await signup_with_org(make_client(), "Org B")
    member = await add_member(a, make_client(), "coordinator")
    await create_case(a)
    await create_case(a, assigneeId=member.user["id"])
    await create_case(b)
    assert (await _get(a, "/api/v1/analytics/overview"))[0].json()["kpis"]["openCases"] == 2
    assert (await _get(b, "/api/v1/analytics/overview"))[0].json()["kpis"]["openCases"] == 1
    assert (await _get(a, "/api/v1/cases/stats"))[0].json()["mine"] == 1
    assert (await _get(member, "/api/v1/cases/stats"))[0].json()["mine"] == 1
    assert (await _get(b, "/api/v1/cases/stats"))[0].json()["total"] == 1


async def test_case_stats_aggregate_matches_case_states(client):
    owner = await signup_with_org(client)
    ids = [(await create_case(owner, priority=p))["id"] for p in ("standard", "expedited", "standard")]
    await owner.patch(f"/api/v1/cases/{ids[0]}", json={"status": "ready"})
    await owner.delete(f"/api/v1/cases/{ids[2]}")  # closed: counted in byStatus only
    st = (await _get(owner, "/api/v1/cases/stats"))[0].json()
    assert st["total"] == 3 and st["byStatus"] == {"closed": 1, "draft": 1, "ready": 1}
    assert st["byPriority"] == {"expedited": 1, "standard": 1} and st["mine"] == 2
    assert st["overdue"] == 0 and st["dueSoon"] == 0  # SLA due dates are days out


async def test_single_statement_auth_still_enforces_membership_and_role(client, make_client):
    owner = await signup_with_org(client)
    member = await add_member(owner, make_client(), "reviewer")
    assert (await member.get("/api/v1/cases")).status_code == 200
    assert (await member.post("/api/v1/cases", json={})).status_code == 403  # reviewers can't write
    uid = member.user["id"]
    r = await owner.patch(f"/api/v1/orgs/current/members/{uid}", json={"role": "coordinator"})
    assert r.status_code == 200
    r = await member.post("/api/v1/cases", json={})
    assert r.status_code == 400 and r.json()["code"] == "patient_required"  # past the permission check
    assert (
        await owner.patch(f"/api/v1/orgs/current/members/{uid}", json={"status": "suspended"})
    ).status_code == 200
    r = await member.get("/api/v1/cases")
    assert r.status_code == 403 and r.json()["code"] == "no_active_org"
    assert (await member.get("/api/v1/auth/me")).status_code == 200  # user-level routes still work
    await owner.patch(f"/api/v1/orgs/current/members/{uid}", json={"status": "active"})
    assert (await member.get("/api/v1/cases")).status_code == 200


async def test_org_cache_never_serves_a_value_computed_across_a_write():
    cache = OrgCache()
    org = uuid.uuid4()
    calls = 0

    async def compute_racing_a_write() -> int:
        nonlocal calls
        calls += 1
        cache.bump(org)  # a write commits while the aggregate is being computed
        return calls

    assert await cache.get_or_compute("ns", org, "k", 60, compute_racing_a_write) == 1
    # the value was stored under the superseded generation, so it is recomputed, not served
    assert await cache.get_or_compute("ns", org, "k", 60, compute_racing_a_write) == 2
    cache.bump(None)  # global bump (bulk UPDATE/DELETE) invalidates every org
    other = uuid.uuid4()

    async def one() -> int:
        return 1

    assert await cache.get_or_compute("ns", other, "k", 60, one) == 1
    assert cache.stats()["misses"] == 3
