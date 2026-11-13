from __future__ import annotations

from datetime import datetime, timedelta

from tests.conftest import add_member, create_case, signup_with_org


async def test_create_case_defaults(client):
    owner = await signup_with_org(client)
    case = await create_case(owner)
    assert case["number"].startswith(f"NC-{datetime.now().year}-") and case["number"].endswith("00001")
    assert case["status"] == "draft" and case["readiness"] == "unknown"
    assert case["patient"]["displayName"] == "J. D."  # masked; demographics are encrypted at rest
    assert case["serviceCodes"] == ["29881"] and case["dxCodes"] == ["M23.221", "M17.11"]
    created = datetime.fromisoformat(case["createdAt"])
    due = datetime.fromisoformat(case["dueAt"])
    assert timedelta(hours=167) < due - created <= timedelta(hours=168, minutes=1)
    assert case["assignee"]["id"] == owner.user["id"]
    assert "ready" in case["allowedTransitions"]

    expedited = await create_case(owner, priority="expedited")
    assert expedited["number"].endswith("00002")
    gap = datetime.fromisoformat(expedited["dueAt"]) - datetime.fromisoformat(expedited["createdAt"])
    assert gap <= timedelta(hours=72, minutes=1)


async def test_case_validation(client):
    owner = await signup_with_org(client)
    r = await owner.post("/api/v1/cases", json={"serviceCodes": ["29881"]})
    assert r.status_code == 400 and r.json()["code"] == "patient_required"
    r = await owner.post(
        "/api/v1/cases",
        json={"patient": {"fullName": "A", "dob": "1950-01-01"}, "serviceCodes": ["not-a-code"]},
    )
    assert r.status_code == 422 and r.json()["errors"][0]["field"] == "serviceCodes"


async def test_status_state_machine_and_outcome(client):
    owner = await signup_with_org(client)
    case = await create_case(owner)
    url = f"/api/v1/cases/{case['id']}"
    bad = await owner.patch(url, json={"status": "approved"})
    assert bad.status_code == 409 and bad.json()["code"] == "invalid_transition"
    for status in ("ready", "submitted"):
        r = await owner.patch(url, json={"status": status})
        assert r.status_code == 200 and r.json()["status"] == status
    assert r.json()["submittedAt"] is not None
    r = await owner.post(f"{url}/outcome", json={"outcome": "denied", "note": "Missing PT notes"})
    assert r.status_code == 200 and r.json()["status"] == "denied" and r.json()["outcome"] == "denied"
    r = await owner.post(f"{url}/outcome", json={"outcome": "approved"})
    assert r.status_code == 409
    assert (await owner.patch(url, json={"status": "appealing"})).json()["status"] == "appealing"

    events = (await owner.get(f"{url}/timeline")).json()
    types = [e["type"] for e in events]
    assert types.count("status_changed") >= 4 and "outcome_recorded" in types and types[-1] == "created"


async def test_worklist_filters_sort_and_pagination(client):
    owner = await signup_with_org(client)
    numbers = [
        (await create_case(owner, priority="expedited" if i % 2 else "standard"))["number"] for i in range(5)
    ]
    r = (await owner.get("/api/v1/cases", params={"limit": 2, "sort": "number"})).json()
    assert r["total"] == 5 and [c["number"] for c in r["items"]] == numbers[:2] and r["nextCursor"]
    seen = [c["number"] for c in r["items"]]
    cursor = r["nextCursor"]
    while cursor:
        page = (
            await owner.get("/api/v1/cases", params={"limit": 2, "sort": "number", "cursor": cursor})
        ).json()
        seen += [c["number"] for c in page["items"]]
        cursor = page["nextCursor"]
    assert seen == numbers

    exp = (await owner.get("/api/v1/cases", params={"priority": "expedited"})).json()
    assert exp["total"] == 2
    by_due = (await owner.get("/api/v1/cases", params={"sort": "dueAt"})).json()["items"]
    assert [c["priority"] for c in by_due[:2]] == ["expedited", "expedited"]
    assert (await owner.get("/api/v1/cases", params={"q": numbers[3]})).json()["total"] == 1
    assert (await owner.get("/api/v1/cases", params={"q": "29881"})).json()["total"] == 5
    assert (await owner.get("/api/v1/cases", params={"assignee": "me"})).json()["total"] == 5
    assert (await owner.get("/api/v1/cases", params={"sort": "bogus"})).status_code == 400
    stats = (await owner.get("/api/v1/cases/stats")).json()
    assert stats["total"] == 5 and stats["byStatus"]["draft"] == 5 and stats["mine"] == 5


async def test_tenant_isolation(client, make_client):
    org_a = await signup_with_org(client, "Org A")
    org_b = await signup_with_org(make_client(), "Org B")
    case = await create_case(org_a)
    for path in ("", "/timeline", "/documents"):
        r = await org_b.get(f"/api/v1/cases/{case['id']}{path}")
        assert r.status_code == 404, path
    assert (await org_b.patch(f"/api/v1/cases/{case['id']}", json={"title": "x"})).status_code == 404
    assert (await org_b.get("/api/v1/cases")).json()["total"] == 0
    assert (await org_b.get(f"/api/v1/patients/{case['patient']['id']}")).status_code == 404
    # Reusing an existing patient from another tenant is impossible.
    r = await org_b.post("/api/v1/cases", json={"patientId": case["patient"]["id"]})
    assert r.status_code == 404


async def test_assignment_comments_and_notifications(client, make_client):
    owner = await signup_with_org(client)
    clin = await add_member(owner, make_client(), "clinician")
    case = await create_case(owner)
    url = f"/api/v1/cases/{case['id']}"
    r = await owner.patch(url, json={"assigneeId": clin.user["id"]})
    assert r.json()["assignee"]["id"] == clin.user["id"]
    notes = (await clin.get("/api/v1/notifications")).json()
    assert notes["unread"] >= 1 and any(n["type"] == "case_assigned" for n in notes["items"])
    assert (await clin.post("/api/v1/notifications/read-all")).status_code == 204
    assert (await clin.get("/api/v1/notifications")).json()["unread"] == 0

    c = await clin.post(f"{url}/comments", json={"body": "PT notes requested from Dr. Lee's office."})
    assert c.status_code == 201 and c.json()["actor"]["id"] == clin.user["id"]
    bad = await owner.patch(url, json={"assigneeId": "00000000-0000-0000-0000-000000000000"})
    assert bad.status_code == 400 and bad.json()["code"] == "invalid_assignee"


async def test_patient_reveal_is_permissioned_and_audited(client, make_client):
    owner = await signup_with_org(client)
    reviewer = await add_member(owner, make_client(), "reviewer")
    case = await create_case(owner)
    pid = case["patient"]["id"]
    masked = (await owner.get(f"/api/v1/patients/{pid}")).json()
    assert masked["demographics"] is None
    revealed = (await owner.get(f"/api/v1/patients/{pid}", params={"reveal": "true"})).json()
    assert revealed["demographics"]["fullName"] == "Jordan Avery Doe"
    assert (await reviewer.get(f"/api/v1/patients/{pid}", params={"reveal": "true"})).status_code == 403
    audit = (await owner.get("/api/v1/audit", params={"action": "phi.*"})).json()
    assert audit["total"] == 1 and audit["items"][0]["resourceId"] == pid


async def test_close_case(client):
    owner = await signup_with_org(client)
    case = await create_case(owner)
    assert (await owner.delete(f"/api/v1/cases/{case['id']}")).status_code == 204
    assert (await owner.get(f"/api/v1/cases/{case['id']}")).json()["status"] == "closed"
    assert (await owner.get("/api/v1/cases")).json()["total"] == 0
    assert (await owner.get("/api/v1/cases", params={"includeClosed": "true"})).json()["total"] == 1
