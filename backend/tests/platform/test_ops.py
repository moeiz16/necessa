"""Rate limiting, health/metrics, security headers, analytics and admin endpoints."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from app.core.config import get_settings
from app.db.models.cases import CaseEvaluation, CriterionResult, Denial
from app.db.session import session_scope
from tests.conftest import PASSWORD, create_case, signup_with_org, unique_email


async def test_auth_rate_limit(client):
    s = get_settings()
    original = s.auth_rate_limit_per_minute
    s.auth_rate_limit_per_minute = 3
    try:
        codes = []
        for _ in range(4):
            r = await client.post("/api/v1/auth/login", json={"email": unique_email(), "password": PASSWORD})
            codes.append(r.status_code)
        assert codes[:3] == [401, 401, 401] and codes[3] == 429
        assert int(r.headers["retry-after"]) >= 1 and r.json()["code"] == "rate_limited"
    finally:
        s.auth_rate_limit_per_minute = original


async def test_health_metrics_and_headers(client):
    r = await client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert len(r.headers["x-request-id"]) >= 16
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["x-frame-options"] == "DENY"
    assert "default-src 'none'" in r.headers["content-security-policy"]
    ready = await client.get("/health/ready")
    body = ready.json()
    assert ready.status_code == 200 and body["checks"]["database"]["status"] == "ok"
    assert body["checks"]["qdrant"]["status"] == "embedded"
    rid = "test-request-id-123"
    assert (await client.get("/api/v1/health", headers={"X-Request-ID": rid})).headers["x-request-id"] == rid
    metrics = await client.get("/metrics")
    assert metrics.status_code == 200 and "necessa_http_requests_total" in metrics.text


async def test_problem_details_for_unknown_routes(client):
    r = await client.get("/api/v1/does-not-exist")
    assert r.status_code == 404 and r.headers["content-type"].startswith("application/problem+json")


async def test_analytics_overview_team_activity(client):
    owner = await signup_with_org(client)
    case = await create_case(owner)
    await create_case(owner, payerType="medicare_advantage", priority="expedited")
    org_id, case_id = uuid.UUID(owner.org["id"]), uuid.UUID(case["id"])
    async with session_scope() as db:
        ev = CaseEvaluation(
            org_id=org_id,
            case_id=case_id,
            status="completed",
            readiness="gaps",
            readiness_score=0.6,
            finished_at=datetime.now(UTC),
        )
        db.add(ev)
        await db.flush()
        for cid, verdict, override in (
            ("C1", "MET", None),
            ("C2", "INSUFFICIENT", None),
            ("C3", "NOT_MET", "MET"),
        ):
            db.add(
                CriterionResult(
                    org_id=org_id,
                    evaluation_id=ev.id,
                    case_id=case_id,
                    criterion_id=cid,
                    criterion_text=f"Criterion {cid}",
                    verdict=verdict,
                    override_verdict=override,
                )
            )
        db.add(Denial(org_id=org_id, case_id=case_id, category="documentation", status="overturned"))
    await owner.patch(f"/api/v1/cases/{case['id']}", json={"status": "ready"})

    r = await owner.get("/api/v1/analytics/overview", params={"range": "30d"})
    assert r.status_code == 200
    data = r.json()
    k = data["kpis"]
    assert k["openCases"] == 2 and k["gapsCaughtPreSubmission"] == 1 and k["appealsOverturned"] == 1
    assert k["estimatedHoursSaved"] == 0.2  # one evaluation x 15 minutes
    assert data["topGapCriteria"] == [{"criterionText": "Criterion C2", "count": 1}]
    assert {p["payerType"] for p in data["payerMix"]} == {"medicare_ffs", "medicare_advantage"}
    assert len(data["trends"]["casesByDay"]) == 31 and data["trends"]["readinessByWeek"][0]["gaps"] == 1
    assert "estimatedHoursSaved" in data["methodology"]
    assert (await owner.get("/api/v1/analytics/overview", params={"range": "2d"})).status_code == 422

    team = (await owner.get("/api/v1/analytics/team")).json()
    assert team[0]["openCases"] == 2
    feed = (await owner.get("/api/v1/activity")).json()
    assert feed and feed[0]["caseNumber"] and "moved case" in feed[0]["message"]


async def test_admin_endpoints(client):
    owner = await signup_with_org(client)
    info = (await owner.get("/api/v1/admin/system")).json()
    assert info["database"] == "sqlite" and info["security"]["phiEncryptionKeyConfigured"] is True
    assert (await owner.get("/api/v1/admin/users")).status_code == 403  # superuser only


async def test_feedback(client):
    owner = await signup_with_org(client)
    r = await owner.post(
        "/api/v1/feedback",
        json={"targetType": "answer", "targetId": "abc", "rating": -1, "reason": "wrong_policy"},
    )
    assert r.status_code == 201 and r.json()["rating"] == -1
    assert (
        await owner.post("/api/v1/feedback", json={"targetType": "x", "targetId": "a", "rating": 5})
    ).status_code == 422
