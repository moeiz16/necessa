"""Demo data: "Riverbend Orthopedics & Spine" (synthetic) with users, patients, cases, documents,
evaluations, letters, a denial + appeal, notifications and audit events.

Everything flows through the real services and the real case-evaluation graph; the only scripted part
is the judge (`OracleJudge`), which knows which synthetic sentence documents which criterion so the demo
works offline with zero API keys. Evaluations seeded this way are labelled `demo-oracle` in model_info.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

import structlog
from sqlalchemy import select

from app.ai.compiler.curated import load_curated
from app.ai.synthetic.notes import OracleJudge, build_case
from app.ai.synthetic.patients import fhir_bundle, make_patient
from app.db.base import utcnow
from app.db.session import get_sessionmaker

log = structlog.get_logger(__name__)

DEMO_ORG = {
    "name": "Riverbend Orthopedics & Spine",
    "npi": "1999999984",
    "specialty": "Orthopedics & Pain Medicine",
    "practice_type": "clinic",
    "states": ["OH", "TX", "AZ"],
    "timezone": "America/New_York",
    "payers": [
        {"type": "medicare_ffs", "name": "Medicare Part B"},
        {"type": "medicare_advantage", "name": "Summit Medicare Advantage (synthetic)"},
        {"type": "commercial", "name": "Synthetic Health Plan"},
    ],
}
DEMO_USERS = [
    ("maya.okafor@riverbend.demo", "Dr. Maya Okafor", "Medical Director", "owner", "#0F766E"),
    (
        "jordan.reyes@riverbend.demo",
        "Jordan Reyes",
        "Prior Authorization Coordinator",
        "coordinator",
        "#7C3AED",
    ),
    ("sam.whitfield@riverbend.demo", "Dr. Sam Whitfield", "Physiatrist", "clinician", "#2563EB"),
    ("priya.natarajan@riverbend.demo", "Priya Natarajan, RN", "Clinical Reviewer", "reviewer", "#DB2777"),
    ("leo.martins@riverbend.demo", "Leo Martins", "Revenue Cycle Manager", "rcm_manager", "#EA580C"),
]


@dataclass
class Scenario:
    key: str
    policy: str
    services: list[str]
    dx: list[str]
    payer_type: str
    payer_name: str
    state: str
    variants: dict[str, str] = field(default_factory=dict)
    priority: str = "standard"
    final_status: str = "needs_review"  # status after seeding
    outcome: str | None = None
    letter: str | None = None  # lmn | pa_cover | appeal
    denial: str | None = None  # denial text
    assignee: str = "coordinator"
    tags: list[str] = field(default_factory=list)
    dos_in_days: int = 10
    review_complete: bool = False
    documents: bool = True
    title: str | None = None


SCENARIOS: list[Scenario] = [
    Scenario(
        "pap-ready",
        "L33718",
        ["E0601"],
        ["G47.33", "I10"],
        "medicare_ffs",
        "Medicare Part B",
        "OH",
        final_status="ready",
        review_complete=True,
        letter="pa_cover",
        tags=["DME", "sleep"],
        title="CPAP (E0601) — obstructive sleep apnea",
    ),
    Scenario(
        "pap-gap",
        "L33718",
        ["E0601"],
        ["G47.33"],
        "medicare_advantage",
        "Summit Medicare Advantage (synthetic)",
        "TX",
        variants={"C7": "removed", "C1": "buried"},
        tags=["DME", "sleep"],
        dos_in_days=4,
        title="CPAP — supplier instruction missing",
    ),
    Scenario(
        "esi-not-supported",
        "L33906",
        ["64483"],
        ["M54.16", "M51.16"],
        "medicare_ffs",
        "Medicare Part B",
        "OH",
        variants={"C4": "contradicted"},
        assignee="clinician",
        tags=["spine", "injection"],
        title="Lumbar transforaminal ESI — conservative care too short",
    ),
    Scenario(
        "esi-submitted",
        "L33906",
        ["64483"],
        ["M54.17"],
        "medicare_ffs",
        "Medicare Part B",
        "OH",
        final_status="pending_payer",
        review_complete=True,
        letter="lmn",
        tags=["spine", "injection"],
        dos_in_days=14,
        title="Lumbar transforaminal ESI — submitted to Medicare",
    ),
    Scenario(
        "facet-attestation",
        "L33930",
        ["64493"],
        ["M47.816"],
        "medicare_ffs",
        "Medicare Part B",
        "AZ",
        variants={"C3": "removed"},
        assignee="clinician",
        tags=["spine"],
        title="Lumbar medial branch block — radiculopathy not addressed",
    ),
    Scenario(
        "tens-clbp",
        "L33802",
        ["E0730"],
        ["M54.50", "G89.29"],
        "medicare_ffs",
        "Medicare Part B",
        "TX",
        variants={"C5": "contradicted"},
        final_status="denied",
        outcome="denied",
        tags=["DME"],
        denial=(
            "Claim adjustment: CO-50. These are non-covered services because this is not deemed a medical "
            "necessity by the payer. RARC N115: This decision was based on a Local Coverage Determination "
            "(LCD). TENS for chronic low back pain is not reasonable and necessary under L33802."
        ),
        title="TENS unit — chronic low back pain",
    ),
    Scenario(
        "bleph-fields",
        "L33944",
        ["15823"],
        ["H02.831", "H02.834"],
        "medicare_ffs",
        "Medicare Part B",
        "OH",
        variants={"C3": "negated", "C4": "removed"},
        tags=["ophthalmic"],
        dos_in_days=21,
        title="Bilateral upper blepharoplasty — visual fields not yet done",
    ),
    Scenario(
        "scs-psych",
        "L35136",
        ["63650"],
        ["M96.1", "G89.4"],
        "medicare_advantage",
        "Summit Medicare Advantage (synthetic)",
        "AZ",
        variants={"C4": "negated"},
        priority="expedited",
        assignee="reviewer",
        tags=["neuromodulation"],
        dos_in_days=3,
        title="Spinal cord stimulator trial — psychological screening pending",
    ),
    Scenario(
        "knee-ready",
        "PAYER-SYNHP-MP0101",
        ["29881"],
        ["S83.241A"],
        "commercial",
        "Synthetic Health Plan",
        "OH",
        final_status="pending_payer",
        review_complete=True,
        letter="lmn",
        tags=["knee", "surgery"],
        title="Right knee arthroscopic partial meniscectomy",
    ),
    Scenario(
        "knee-oa-denied",
        "PAYER-SYNHP-MP0101",
        ["29881"],
        ["M23.221", "M17.11"],
        "commercial",
        "Synthetic Health Plan",
        "TX",
        variants={"C4": "contradicted", "C2": "paraphrased"},
        final_status="denied",
        outcome="denied",
        tags=["knee", "surgery"],
        denial=(
            "Notice of adverse determination. Reason code CO-50 (not medically necessary) and RARC M127. "
            "Weight-bearing radiographs show advanced osteoarthritis (Kellgren-Lawrence grade 4) of the "
            "affected compartment; arthroscopic partial meniscectomy does not meet policy MP0101 criteria."
        ),
        title="Knee arthroscopy — advanced osteoarthritis",
    ),
    Scenario(
        "mri-redflag",
        "PAYER-SYNHP-MP0510",
        ["72148"],
        ["M54.16"],
        "commercial",
        "Synthetic Health Plan",
        "OH",
        variants={"C1": "present", "C2": "removed", "C3": "removed"},
        final_status="approved",
        outcome="approved",
        review_complete=True,
        priority="expedited",
        tags=["imaging"],
        dos_in_days=1,
        title="Lumbar MRI — suspected cauda equina",
    ),
    Scenario(
        "mri-early",
        "PAYER-SYNHP-MP0510",
        ["72148"],
        ["M54.50"],
        "commercial",
        "Synthetic Health Plan",
        "TX",
        variants={"C1": "negated", "C2": "negated", "C3": "present"},
        tags=["imaging"],
        title="Lumbar MRI — acute back pain, no red flags",
    ),
    Scenario(
        "pap-draft",
        "L33718",
        ["E0601"],
        ["G47.33"],
        "medicare_ffs",
        "Medicare Part B",
        "OH",
        documents=False,
        final_status="draft",
        tags=["DME"],
        dos_in_days=30,
        title="CPAP — new referral (documents pending)",
    ),
    Scenario(
        "knee-appealing",
        "PAYER-SYNHP-MP0101",
        ["29881"],
        ["S83.241A"],
        "commercial",
        "Synthetic Health Plan",
        "AZ",
        variants={"C5": "paraphrased"},
        final_status="appealing",
        outcome="denied",
        letter="appeal",
        tags=["knee", "appeal"],
        denial=(
            "Adverse determination: CO-16 claim lacks information needed for adjudication. N290: missing "
            "functional assessment documentation. Please submit documentation of functional limitation."
        ),
        title="Knee arthroscopy — appeal in progress",
    ),
]


def demo_password() -> str:
    return os.environ.get("DEMO_PASSWORD") or "Demo!Pass2026"


async def seed_demo_org(progress: Callable[[float, str], Awaitable[None]] | None = None) -> dict:
    from app.core.security import hash_password
    from app.db.models.platform import Membership, Organization, User
    from app.services.orgs import create_org

    sm = get_sessionmaker()
    async with sm() as db:
        users: dict[str, User] = {}
        for email, name, title, _role, color in DEMO_USERS:
            u = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
            if u is None:
                u = User(
                    email=email,
                    full_name=name,
                    title=title,
                    password_hash=hash_password(demo_password()),
                    avatar_color=color,
                    email_verified_at=utcnow(),
                    is_active=True,
                )
                db.add(u)
                await db.flush()
            users[email] = u
        owner = users[DEMO_USERS[0][0]]
        org = (
            (await db.execute(select(Organization).where(Organization.name == DEMO_ORG["name"])))
            .scalars()
            .first()
        )
        created = org is None
        if org is None:
            org, _ = await create_org(db, owner, DEMO_ORG)
            org.onboarding_completed_at = utcnow()
        for email, _n, _t, role, _c in DEMO_USERS:
            u = users[email]
            m = (
                await db.execute(
                    select(Membership).where(Membership.org_id == org.id, Membership.user_id == u.id)
                )
            ).scalar_one_or_none()
            if m is None:
                db.add(Membership(org_id=org.id, user_id=u.id, role=role, status="active"))
            u.preferences = {**(u.preferences or {}), "lastOrgId": str(org.id)}
        await db.commit()
        org_id, owner_id = org.id, owner.id
    result = {
        "orgId": str(org_id),
        "created": created,
        "users": [{"email": e, "role": r, "password": demo_password()} for e, _n, _t, r, _c in DEMO_USERS],
    }
    if created:
        result.update(await seed_demo_cases(org_id=org_id, actor_id=owner_id, progress=progress))
    return result


async def seed_demo_cases(
    *,
    org_id: uuid.UUID,
    actor_id: uuid.UUID | None,
    progress: Callable[[float, str], Awaitable[None]] | None = None,
    scenarios: list[Scenario] | None = None,
) -> dict:
    from app.ai.agents.case_graph import evaluate
    from app.ai.agents.case_ports import DbCasePorts
    from app.ai.llm.fake import FakeLLMRouter
    from app.db.models.cases import CaseEvaluation
    from app.db.models.platform import Membership, Organization, User
    from app.services import cases as case_svc
    from app.services import documents as doc_svc

    sm = get_sessionmaker()
    curated = load_curated()
    today = date.today()
    oracle = OracleJudge()
    router = FakeLLMRouter()
    oracle.install(router)
    created: list[str] = []
    scenarios = scenarios or SCENARIOS

    async with sm() as db:
        org = await db.get(Organization, org_id)
        actor = await db.get(User, actor_id) if actor_id else None
        members = (
            await db.execute(
                select(Membership, User)
                .join(User, User.id == Membership.user_id)
                .where(Membership.org_id == org_id)
            )
        ).all()
        by_role = {m.role: u for m, u in members}
        if actor is None:
            actor = by_role.get("owner") or members[0][1]

    for i, sc in enumerate(scenarios):
        if progress:
            await progress(i / len(scenarios), f"Seeding {sc.key}")
        tree = curated[sc.policy]
        dos = today + timedelta(days=sc.dos_in_days)
        patient = make_patient(f"{org_id}:{sc.key}", state=sc.state, today=today)
        synth = build_case(
            [tree], patient, seed=f"{org_id}:{sc.key}", date_of_service=dos, variants=sc.variants
        )
        oracle.add_case(synth)
        async with sm() as db:
            org = await db.get(Organization, org_id)
            actor_row = await db.get(User, actor.id)
            assignee = by_role.get(sc.assignee) or actor_row
            case = await case_svc.create_case(
                db,
                org,
                actor_row,
                {
                    "patient": patient.demographics(),
                    "title": sc.title,
                    "priority": sc.priority,
                    "payer_type": sc.payer_type,
                    "payer_name": sc.payer_name,
                    "state": sc.state,
                    "service_codes": sc.services,
                    "dx_codes": sc.dx,
                    "date_of_service": dos,
                    "place_of_service": "11",
                    "assignee_id": assignee.id,
                    "tags": sc.tags,
                },
            )
            pat = await case_svc.get_patient(db, org_id, case.patient_id)
            if sc.documents:
                bundle = fhir_bundle(
                    patient,
                    payer_name=sc.payer_name,
                    payer_type=sc.payer_type,
                    dx_codes=sc.dx,
                    service_codes=sc.services,
                    documents=[],
                    date_of_service=dos,
                    seed=sc.key,
                )
                import json

                raw = json.dumps(bundle).encode()
                ext = doc_svc.extract(raw, f"{sc.key}-bundle.json", "application/fhir+json")
                await doc_svc.store_document(
                    db,
                    case,
                    pat,
                    kind="fhir_bundle",
                    filename="patient-summary.fhir.json",
                    raw=raw,
                    extracted=ext,
                    note_date=dos - timedelta(days=2),
                    uploaded_by=actor_row.id,
                )
                for d in synth.documents:
                    raw = d["text"].encode()
                    ext = doc_svc.extract(raw, f"{d['title']}.txt", "text/plain")
                    await doc_svc.store_document(
                        db,
                        case,
                        pat,
                        kind=d["kind"],
                        filename=f"{d['title']}.txt",
                        raw=raw,
                        extracted=ext,
                        note_date=d["note_date"],
                        uploaded_by=actor_row.id,
                    )
            await db.commit()
            case_id, case_org = case.id, case.org_id
        created.append(str(case_id))
        if not sc.documents:
            continue
        ev_id = uuid.uuid4()
        async with sm() as db:
            db.add(
                CaseEvaluation(
                    id=ev_id,
                    org_id=case_org,
                    case_id=case_id,
                    status="running",
                    readiness="unknown",
                    started_by=actor.id,
                    started_at=utcnow(),
                )
            )
            c = await case_svc.get_case(db, case_org, case_id)
            await case_svc.set_status(db, c, "evaluating", actor_id=actor.id, reason="demo seed", force=True)
            await db.commit()
        ports = DbCasePorts(
            case_id=case_id, org_id=case_org, evaluation_id=ev_id, actor_id=actor.id, router=router
        )
        try:
            await evaluate(ports, evaluation_id=str(ev_id), router=router, token_budget=None, concurrency=4)
        except Exception:
            log.exception("demo.evaluation_failed", scenario=sc.key)
            continue
        async with sm() as db:
            ev = await db.get(CaseEvaluation, ev_id)
            ev.model_info = {
                **(ev.model_info or {}),
                "models": {"judge": "demo-oracle", "verifier": "demo-oracle"},
                "demo": True,
            }
            c = await case_svc.get_case(db, case_org, case_id)
            if sc.review_complete:
                from app.ai.agents.case_review import complete_review

                await complete_review(db, case=c, ev=ev, actor_id=(by_role.get("reviewer") or actor).id)
            await db.commit()
        await _finish_scenario(sc, case_id, case_org, actor, by_role, router)

    if progress:
        await progress(1.0, "Demo data ready")
    await _seed_notifications(org_id, by_role)
    return {"cases": created, "count": len(created)}


async def _finish_scenario(sc: Scenario, case_id, org_id, actor, by_role, router) -> None:
    from app.ai.drafting.denials import analyze_denial
    from app.ai.drafting.letters import create_letter
    from app.ai.jobs_cases import criteria_candidates
    from app.db.models.cases import Denial
    from app.services import cases as case_svc

    sm = get_sessionmaker()
    async with sm() as db:
        c = await case_svc.get_case(db, org_id, case_id)
        clinician = by_role.get("clinician") or actor
        if sc.letter and sc.letter != "appeal":
            letter = await create_letter(db, case=c, kind=sc.letter, router=None, actor_id=actor.id)
            if sc.final_status in {"pending_payer", "approved", "submitted"}:
                letter.status, letter.approved_by, letter.approved_at = "approved", clinician.id, utcnow()
        if sc.final_status in {"pending_payer", "approved", "denied", "appealing"}:
            for st in ("ready", "submitted", "pending_payer"):
                await case_svc.set_status(db, c, st, actor_id=actor.id, reason="demo seed", force=True)
            c.submitted_at = utcnow() - timedelta(days=3)
        if sc.outcome:
            target = {"approved": "approved", "denied": "denied"}[sc.outcome]
            await case_svc.set_status(
                db, c, target, actor_id=actor.id, reason="payer decision (demo)", force=True
            )
            c.outcome, c.outcome_at = sc.outcome, utcnow() - timedelta(days=1)
        if sc.denial:
            received = date.today() - timedelta(days=2)
            analysis = await analyze_denial(
                sc.denial,
                received=received,
                payer_type=c.payer_type,
                criteria=await criteria_candidates(db, c),
                router=None,
            )
            d = Denial(
                org_id=org_id,
                case_id=c.id,
                received_at=received,
                reason_text=sc.denial,
                carc_codes=analysis.carc_codes,
                rarc_codes=analysis.rarc_codes,
                category=analysis.category,
                mapped_criteria=analysis.mapped_criteria,
                appeal_deadline=analysis.appeal_deadline,
                status="new",
                analysis=analysis.as_dict(),
            )
            db.add(d)
            await db.flush()
            await case_svc.add_event(
                db,
                c,
                "denial_recorded",
                {"denialId": str(d.id), "category": d.category, "carc": d.carc_codes},
                actor.id,
            )
            if sc.letter == "appeal" or sc.final_status == "appealing":
                letter = await create_letter(
                    db,
                    case=c,
                    kind="appeal",
                    router=None,
                    actor_id=actor.id,
                    denial={
                        "received_at": received.isoformat(),
                        "category": d.category,
                        "carc_codes": d.carc_codes,
                        "rarc_codes": d.rarc_codes,
                        "reason_text": sc.denial,
                        "appeal_deadline": d.appeal_deadline.isoformat() if d.appeal_deadline else "",
                    },
                    mapped=d.mapped_criteria,
                )
                d.appeal_letter_id, d.status = letter.id, "appeal_drafted"
                if sc.final_status == "appealing":
                    await case_svc.set_status(
                        db, c, "appealing", actor_id=actor.id, reason="appeal filed (demo)", force=True
                    )
                    d.status = "appealed"
        if sc.final_status == "draft":
            await case_svc.set_status(db, c, "draft", actor_id=actor.id, force=True)
        await db.commit()


async def _seed_notifications(org_id, by_role) -> None:
    from app.services.notifications import notify

    sm = get_sessionmaker()
    async with sm() as db:
        try:
            await notify(
                db,
                org_id=org_id,
                type="policy_updated",
                title="L33930 Facet Joint Interventions was revised",
                body="A new version of the LCD is effective soon. 1 open case references this policy.",
                link="/policies?q=L33930",
            )
            await notify(
                db,
                org_id=org_id,
                type="denial_received",
                title="New denial: knee arthroscopy (CO-50)",
                body="Mapped to criterion C4 (advanced osteoarthritis). Appeal deadline in 178 days.",
                link="/denials",
                roles=["rcm_manager", "owner", "coordinator"],
            )
            await notify(
                db,
                org_id=org_id,
                type="sla_risk",
                title="Expedited case due within 24 hours",
                body="Spinal cord stimulator trial — psychological screening pending.",
                link="/cases?priority=expedited",
            )
            await db.commit()
        except Exception:
            log.exception("demo.notifications_failed")


def _now() -> datetime:
    return datetime.now(UTC)
