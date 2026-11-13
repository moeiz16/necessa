"""API-level tests for knowledge, assistant and admin routers."""

from __future__ import annotations

import json

import pytest

from tests.conftest import add_member, signup_with_org

pytestmark = pytest.mark.asyncio


def _sse(text: str) -> list[tuple[str, dict]]:
    events = []
    for block in text.replace("\r\n", "\n").split("\n\n"):
        ev, data = None, []
        for line in block.splitlines():
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data.append(line[5:].strip())
        if ev and data:
            events.append((ev, json.loads("\n".join(data))))
    return events


async def test_policy_library_search_detail_codes_and_chunks(client, fixtures_index):
    owner = await signup_with_org(client)
    r = await owner.get(
        "/api/v1/policies", params={"q": "meniscal tear conservative therapy knee arthroscopy"}
    )
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert items and items[0]["sourceKey"] == "PAYER-SYNHP-MP0101" and items[0]["snippet"]

    r = await owner.get("/api/v1/policies", params={"docType": "Payer Policy", "limit": 2})
    body = r.json()
    assert body["total"] >= 4 and len(body["items"]) == 2 and body["nextCursor"]
    r2 = await owner.get(
        "/api/v1/policies", params={"docType": "Payer Policy", "limit": 2, "cursor": body["nextCursor"]}
    )
    assert {i["id"] for i in r2.json()["items"]}.isdisjoint({i["id"] for i in body["items"]})

    r = await owner.get("/api/v1/policies/PAYER-SYNHP-MP0101")
    d = r.json()
    assert r.status_code == 200 and d["synthetic"] is True
    assert {"indication", "doc_reqs"} <= {s["sectionKey"] for s in d["sections"]}
    assert d["currentVersion"]["version"] == 3 and d["codeCounts"]["HCPCS"] == 4

    r = await owner.get(f"/api/v1/policies/{d['id']}/codes", params={"system": "ICD10_COVERED"})
    assert r.json()["total"] == 4
    r = await owner.get(f"/api/v1/policies/{d['id']}/chunks")
    assert r.json()["items"][0]["header"].startswith("[Payer Policy PAYER-SYNHP-MP0101")
    r = await owner.get(f"/api/v1/policies/{d['id']}/versions/v3")
    assert r.status_code == 200 and r.json()["isCurrent"]
    assert (await owner.get("/api/v1/policies/L00000")).status_code == 404


async def test_codes_search_detail_graph_and_stats(client, fixtures_index):
    owner = await signup_with_org(client)
    r = await owner.get("/api/v1/codes/search", params={"q": "E0601"})
    assert r.status_code == 200 and r.json()[0]["code"] == "E0601"
    r = await owner.get("/api/v1/codes/HCPCS/E0601")
    assert any(p["sourceKey"] == "PAYER-SYNHP-MP0207" for p in r.json()["policies"])
    r = await owner.get("/api/v1/codes/HCPCS/E0601/graph")
    g = r.json()
    assert {"code", "payer"} <= {n["type"] for n in g["nodes"]} and g["edges"]
    r = await owner.get("/api/v1/knowledge/stats")
    st = r.json()
    assert st["policies"].get("Payer Policy", 0) >= 4 and st["activeIndex"]["points"] > 0


async def test_retrieval_inspector_returns_trace(client, fixtures_index):
    owner = await signup_with_org(client)
    r = await owner.post(
        "/api/v1/search/retrieve",
        json={
            "query": "CPAP adherence 4 hours 70% of nights",
            "topK": 3,
            "filters": {"payerType": "commercial"},
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["chunks"] and body["route"]["strategy"] and "totalMs" in body["timings"]
    assert body["chunks"][0]["source"]["source_key"] == "PAYER-SYNHP-MP0207"
    bad = await owner.post("/api/v1/search/retrieve", json={"query": "x", "filters": {"nope": 1}})
    assert bad.status_code == 400


async def test_assistant_conversation_stream_persist_feedback(client, fixtures_index):
    owner = await signup_with_org(client)
    r = await owner.post("/api/v1/assistant/conversations", json={})
    conv = r.json()
    r = await owner.post(
        f"/api/v1/assistant/conversations/{conv['id']}/messages",
        json={"content": "What documentation must accompany a knee arthroscopy request?"},
    )
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = _sse(r.text)
    names = [e for e, _ in events]
    assert "route" in names and "token" in names and names[-1] == "done"
    done = events[-1][1]
    assert done["messageId"]
    detail = (await owner.get(f"/api/v1/assistant/conversations/{conv['id']}")).json()
    assert [m["role"] for m in detail["messages"]] == ["user", "assistant"]
    assert detail["messages"][1]["citations"] and detail["title"] != "New conversation"
    # A reloaded answer carries the same trace the live stream showed (retrieval inspector).
    saved = detail["messages"][1]
    live_route = next(d for e, d in events if e == "route" and "intent" in d)
    assert saved["route"]["intent"] == live_route["intent"] and "filters" in saved["route"]
    assert saved["retrieval"]["chunks"] and saved["conversationId"] == conv["id"]
    r = await owner.post(f"/api/v1/assistant/messages/{done['messageId']}/feedback", json={"rating": 1})
    assert r.status_code == 204
    convs = (await owner.get("/api/v1/assistant/conversations")).json()["items"]
    assert convs[0]["id"] == conv["id"] and convs[0]["messageCount"] == 2


async def test_conversations_are_private_to_their_owner(client, make_client, fixtures_index):
    owner = await signup_with_org(client)
    conv = (await owner.post("/api/v1/assistant/conversations", json={"title": "mine"})).json()
    other = await signup_with_org(make_client(), org_name="Other Practice")
    assert (await other.get(f"/api/v1/assistant/conversations/{conv['id']}")).status_code == 404
    colleague = await add_member(owner, make_client(), "coordinator")
    assert (await colleague.get(f"/api/v1/assistant/conversations/{conv['id']}")).status_code == 404


async def test_suggestions_and_analytics_ask(client, fixtures_index):
    owner = await signup_with_org(client)
    r = await owner.get("/api/v1/assistant/suggestions", params={"context": "policy:L33718"})
    assert len(r.json()) == 4
    r = await owner.post("/api/v1/analytics/ask", json={"question": "Cases by status"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["method"] == "template" and body["columns"] == ["status", "cases"]


async def test_admin_endpoints_and_rbac(client, make_client, fixtures_index):
    owner = await signup_with_org(client)
    r = await owner.get("/api/v1/admin/models")
    assert r.status_code == 200 and r.json()["groups"]
    r = await owner.post("/api/v1/admin/models/test", json={"group": "qa-public"})
    assert r.json()["ok"] is True
    assert (await owner.get("/api/v1/admin/models/usage", params={"range": "7d"})).status_code == 200
    assert (await owner.get("/api/v1/admin/cache/stats")).json()["backend"] in {"memory", "database", "redis"}
    assert (await owner.get("/api/v1/admin/system/ai")).json()["llmFake"] is True
    idx = (await owner.get("/api/v1/admin/indexes")).json()
    assert any(i["status"] == "active" for i in idx)
    r = await owner.post("/api/v1/admin/ingestion/runs", json={"source": "fixtures"})
    assert r.status_code == 202 and r.json()["job"]["type"] == "ingest.fixtures"
    assert (await owner.get("/api/v1/admin/ingestion/runs")).status_code == 200

    auditor = await add_member(owner, make_client(), "auditor")
    assert (
        await auditor.post("/api/v1/admin/ingestion/runs", json={"source": "fixtures"})
    ).status_code == 403
    assert (await auditor.get("/api/v1/admin/models")).status_code == 403
    assert (await auditor.get("/api/v1/policies")).status_code == 200


async def test_model_usage_is_scoped_to_the_callers_org(client, make_client):
    import uuid as _uuid

    from app.db.models.knowledge import LLMCall
    from app.db.session import session_scope

    owner = await signup_with_org(client)
    other = await signup_with_org(make_client(), org_name="Other Practice")
    other_org = _uuid.UUID(other.org["id"])
    async with session_scope() as db:
        db.add(
            LLMCall(
                org_id=other_org, group="judge", purpose="case.judge", provider="groq", model="secret-model"
            )
        )
    mine = (await owner.get("/api/v1/admin/models/usage", params={"range": "7d"})).json()
    assert all(d["model"] != "secret-model" for d in mine["byDeployment"])
    theirs = (await other.get("/api/v1/admin/models/usage", params={"range": "7d"})).json()
    assert any(d["model"] == "secret-model" for d in theirs["byDeployment"])
