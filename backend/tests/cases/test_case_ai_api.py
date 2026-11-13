"""API-level integration: evaluation → review → letters → denials/appeals → exports → admin (real app, SQLite)."""  # noqa: E501

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.ai.compiler.curated import load_curated
from app.ai.llm.fake import FakeLLMRouter
from app.ai.llm.router import get_llm_router, set_llm_router
from app.ai.synthetic.notes import OracleJudge, build_case
from app.ai.synthetic.patients import make_patient
from tests.conftest import CASE_PAYLOAD, add_member, create_case, signup_with_org

PATIENT_NAME = CASE_PAYLOAD["patient"]["fullName"]

DOS = date.today() + timedelta(days=14)


@pytest.fixture
def oracle_router():
    previous = get_llm_router()
    router = FakeLLMRouter()
    oracle = OracleJudge()
    oracle.install(router)
    set_llm_router(router)
    yield oracle
    set_llm_router(previous)


async def _run_job(job_id: str):
    from app.services.jobs import run_job_now

    job = await run_job_now(uuid.UUID(job_id))
    assert job.status == "succeeded", (job.type, job.error)
    return job


async def _setup_case(owner, oracle: OracleJudge, variants: dict) -> tuple[str, object]:
    case = await create_case(
        owner,
        payerType="commercial",
        payerName="Synthetic Health Plan",
        serviceCodes=["29881"],
        dxCodes=["S83.241A"],
        dateOfService=DOS.isoformat(),
    )
    tree = load_curated()["PAYER-SYNHP-MP0101"]
    sc = build_case(
        [tree],
        make_patient(case["id"], today=date.today()),
        seed=case["id"],
        date_of_service=DOS,
        variants=variants,
    )
    oracle.add_case(sc)
    for d in sc.documents:
        r = await owner.post(
            f"/api/v1/cases/{case['id']}/documents/text",
            json={
                "kind": d["kind"],
                "text": d["text"],
                "noteDate": d["note_date"].isoformat(),
                "title": d["title"],
            },
        )
        assert r.status_code == 201, r.text
    return case["id"], sc


async def test_evaluation_review_letters_denials_exports(client, make_client, oracle_router):
    owner = await signup_with_org(client)
    case_id, _sc = await _setup_case(owner, oracle_router, {"C5": "removed"})

    r = await owner.post(f"/api/v1/cases/{case_id}/policy-suggestions")
    assert r.status_code == 200
    assert "PAYER-SYNHP-MP0101" in [m["sourceKey"] for m in r.json()["matches"]]

    r = await owner.post(f"/api/v1/cases/{case_id}/evaluate", json={})
    assert r.status_code == 202, r.text
    ev_id, job_id = r.json()["evaluationId"], r.json()["jobId"]
    assert (
        await owner.post(f"/api/v1/cases/{case_id}/evaluate", json={})
    ).status_code == 409  # already running
    await _run_job(job_id)

    ev = (await owner.get(f"/api/v1/cases/{case_id}/evaluations/{ev_id}")).json()
    assert ev["status"] == "awaiting_review" and ev["readiness"] == "gaps"
    by_id = {c["criterionId"]: c for c in ev["criteria"]}
    assert by_id["PAYER-SYNHP-MP0101:C1"]["verdict"] == "MET"
    assert by_id["PAYER-SYNHP-MP0101:C5"]["verdict"] == "INSUFFICIENT"
    assert [g["criterionId"] for g in ev["gaps"]] == ["PAYER-SYNHP-MP0101:C5"]
    case = (await owner.get(f"/api/v1/cases/{case_id}")).json()
    assert case["status"] == "needs_review" and case["readiness"] == "gaps"

    actions = (await owner.get(f"/api/v1/cases/{case_id}/next-actions")).json()
    assert any(a["type"] == "resolve_gap" for a in actions) and any(
        a["type"] == "complete_review" for a in actions
    )

    # human override (reason required) recomputes readiness
    c5 = by_id["PAYER-SYNHP-MP0101:C5"]
    r = await owner.patch(f"/api/v1/cases/{case_id}/criteria/{c5['id']}", json={"overrideVerdict": "MET"})
    assert r.status_code == 400
    r = await owner.patch(
        f"/api/v1/cases/{case_id}/criteria/{c5['id']}",
        json={"overrideVerdict": "MET", "overrideReason": "KOOS 38 documented on paper intake form"},
    )
    assert r.status_code == 200 and r.json()["effectiveVerdict"] == "MET" and r.json()["override"]["reason"]
    r = await owner.post(f"/api/v1/cases/{case_id}/evaluations/{ev_id}/complete-review")
    assert r.status_code == 200 and r.json()["status"] == "completed" and r.json()["readiness"] == "ready"
    assert (await owner.get(f"/api/v1/cases/{case_id}")).json()["status"] == "ready"

    # letters: draft (template fallback in tests) → masked by default → reveal → export
    r = await owner.post(f"/api/v1/cases/{case_id}/letters", json={"kind": "lmn"})
    assert r.status_code == 202
    await _run_job(r.json()["jobId"])
    letters = (await owner.get(f"/api/v1/cases/{case_id}/letters")).json()
    letter = letters[0]
    assert "«Patient Name»" in letter["contentMd"] and letter["citations"]
    assert PATIENT_NAME not in letter["contentMd"]
    revealed = (await owner.get(f"/api/v1/cases/{case_id}/letters/{letter['id']}?reveal=true")).json()
    assert PATIENT_NAME in revealed["rendered"]
    r = await owner.patch(f"/api/v1/cases/{case_id}/letters/{letter['id']}", json={"status": "approved"})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    r = await owner.get(f"/api/v1/cases/{case_id}/letters/{letter['id']}/export?format=pdf")
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    r = await owner.get(f"/api/v1/cases/{case_id}/letters/{letter['id']}/export?format=md")
    assert PATIENT_NAME in r.text

    # FHIR exports
    qr = (await owner.get(f"/api/v1/cases/{case_id}/export/fhir")).json()
    assert qr["resourceType"] == "QuestionnaireResponse" and len(qr["item"]) == 6
    pas = (await owner.get(f"/api/v1/cases/{case_id}/export/fhir?type=pas")).json()
    assert pas["entry"][0]["resource"]["use"] == "preauthorization"

    # denial → analysis → appeal drafted
    r = await owner.post(
        f"/api/v1/cases/{case_id}/denials",
        json={
            "text": "Adverse determination CO-50. Radiographs show advanced osteoarthritis (Kellgren-Lawrence grade 4).",  # noqa: E501
            "receivedAt": date.today().isoformat(),
        },
    )
    assert r.status_code == 201, r.text
    denial_id = r.json()["id"]
    await _run_job(r.json()["jobId"])
    from app.db.models.platform import Job
    from app.db.session import get_sessionmaker

    async with get_sessionmaker()() as db:
        appeal_job = (
            (await db.execute(select(Job).where(Job.type == "letter.draft", Job.status == "queued")))
            .scalars()
            .first()
        )
    await _run_job(str(appeal_job.id))
    denials = (await owner.get(f"/api/v1/cases/{case_id}/denials")).json()
    d = next(x for x in denials if x["id"] == denial_id)
    assert d["category"] == "medical_necessity" and d["carcCodes"] == ["CO-50"]
    assert d["mappedCriteria"][0]["criterionId"] == "PAYER-SYNHP-MP0101:C4"
    assert d["appealDeadline"] and d["status"] == "appeal_drafted" and d["appealLetterId"]
    org_denials = (await owner.get("/api/v1/denials")).json()
    assert org_denials and org_denials[0]["case"]["id"] == case_id

    # timeline captured the whole story
    types = {e["type"] for e in (await owner.get(f"/api/v1/cases/{case_id}/timeline")).json()}
    assert {
        "evaluation_started",
        "evaluation_completed",
        "verdict_overridden",
        "letter_drafted",
        "letter_approved",
        "denial_recorded",
    } <= types


async def test_permissions_and_guards(client, make_client, oracle_router):
    owner = await signup_with_org(client)
    case_id, _ = await _setup_case(owner, oracle_router, {})
    auditor = await add_member(owner, make_client(), "auditor")
    coordinator = await add_member(owner, make_client(), "coordinator")
    assert (await auditor.post(f"/api/v1/cases/{case_id}/evaluate", json={})).status_code == 403
    r = await coordinator.post(f"/api/v1/cases/{case_id}/evaluate", json={})
    assert r.status_code == 202
    await _run_job(r.json()["jobId"])
    ev = (await coordinator.get(f"/api/v1/cases/{case_id}/evaluations")).json()[0]
    full = (await coordinator.get(f"/api/v1/cases/{case_id}/evaluations/{ev['id']}")).json()
    rid = full["criteria"][0]["id"]
    # coordinators cannot override verdicts (cases:review)
    r = await coordinator.patch(
        f"/api/v1/cases/{case_id}/criteria/{rid}", json={"overrideVerdict": "NOT_MET", "overrideReason": "x"}
    )
    assert r.status_code == 403
    # other orgs can't see the case
    other = await signup_with_org(make_client(), org_name="Other Practice")
    assert (await other.get(f"/api/v1/cases/{case_id}/evaluations")).status_code == 404
    # evaluating without documents is refused
    empty = await create_case(owner)
    assert (await owner.post(f"/api/v1/cases/{empty['id']}/evaluate", json={})).status_code == 409


async def test_admin_criteria_and_evals(client, oracle_router):
    owner = await signup_with_org(client)
    r = await owner.post("/api/v1/admin/criteria/compile", json={"syncCurated": True})
    assert r.status_code == 202
    await _run_job(r.json()["id"])
    page = (await owner.get("/api/v1/admin/criteria?status=approved")).json()
    assert page["total"] >= 10
    cs = next(i for i in page["items"] if i["policyKey"] == "L33718")
    full = (await owner.get(f"/api/v1/admin/criteria/{cs['id']}")).json()
    assert full["tree"]["root"]["op"] == "AND"
    bad = {**full["tree"]}
    bad["root"] = {
        **bad["root"],
        "children": [
            {
                **bad["root"]["children"][0],
                "sourceSpan": {
                    "sectionKey": "indication",
                    "quote": "this sentence is not in the policy text at all",
                },
            }
        ],
    }
    r = await owner.patch(f"/api/v1/admin/criteria/{cs['id']}", json={"tree": bad, "status": "approved"})
    assert r.status_code in (200, 400)
    curated = (await owner.get("/api/v1/admin/criteria/curated")).json()
    assert {c["policyKey"] for c in curated} >= {"L33718", "PAYER-SYNHP-MP0101"}

    r = await owner.post("/api/v1/admin/evals/runs", json={"suite": "criteria"})
    assert r.status_code == 202
    await _run_job(r.json()["id"])
    runs = (await owner.get("/api/v1/admin/evals/runs")).json()
    assert runs and runs[0]["suite"] == "criteria"
    detail = (await owner.get(f"/api/v1/admin/evals/runs/{runs[0]['id']}")).json()
    assert detail["results"]
    summary = (await owner.get("/api/v1/admin/evals/summary")).json()
    assert "criteria" in summary["latest"] and "verdicts" in summary["gates"]


async def test_demo_seed_subset(client):
    from app.ai.synthetic.demo_seed import SCENARIOS, seed_demo_cases
    from app.db.models.cases import Case, CaseEvaluation, Denial
    from app.db.session import get_sessionmaker

    owner = await signup_with_org(client)
    org_id = uuid.UUID(owner.org["id"])
    picked = [s for s in SCENARIOS if s.key in {"pap-ready", "knee-oa-denied", "pap-draft"}]
    out = await seed_demo_cases(org_id=org_id, actor_id=uuid.UUID(owner.user["id"]), scenarios=picked)
    assert out["count"] == 3
    async with get_sessionmaker()() as db:
        cases = (await db.execute(select(Case).where(Case.org_id == org_id))).scalars().all()
        statuses = {c.title: c.status for c in cases}
        evs = (
            (await db.execute(select(CaseEvaluation).where(CaseEvaluation.org_id == org_id))).scalars().all()
        )
        denials = (await db.execute(select(Denial).where(Denial.org_id == org_id))).scalars().all()
    assert "ready" in statuses.values() and "denied" in statuses.values() and "draft" in statuses.values()
    assert len(evs) == 2 and all(e.model_info.get("demo") for e in evs)
    assert denials and denials[0].category == "medical_necessity"
    r = await owner.post("/api/v1/orgs/current/demo-data")
    assert r.status_code == 202 and r.json()["type"] == "demo.seed"
