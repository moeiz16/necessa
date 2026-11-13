"""Background job handlers for case intelligence (registered with app.services.jobs via JOB_HANDLERS)."""

from __future__ import annotations

import uuid

import structlog
from sqlalchemy import select

from app.ai.agents.case_ports import DbCasePorts
from app.core.config import get_settings
from app.db.base import utcnow
from app.db.models.cases import Case, CaseDocument, CaseEvaluation, CriterionResult, Denial
from app.db.session import get_sessionmaker

log = structlog.get_logger(__name__)


def _router():
    try:
        from app.ai.llm.router import get_llm_router

        return get_llm_router()
    except Exception:
        return None


def _uuid(v) -> uuid.UUID | None:
    return uuid.UUID(str(v)) if v else None


async def run_case_evaluation(ctx) -> dict:
    """params: {caseId, evaluationId?, policyVersionIds?}"""
    from app.ai.agents.case_graph import evaluate

    params = ctx.params or {}
    case_id = _uuid(params["caseId"])
    sm = get_sessionmaker()
    async with sm() as db:
        case = (await db.execute(select(Case).where(Case.id == case_id))).scalar_one()
        org_id = case.org_id
        ev_id = _uuid(params.get("evaluationId"))
        ev = await db.get(CaseEvaluation, ev_id) if ev_id else None
        if ev is None:
            ev = CaseEvaluation(
                id=ev_id or uuid.uuid4(),
                org_id=org_id,
                case_id=case.id,
                status="running",
                readiness="unknown",
                started_by=ctx.created_by,
                started_at=utcnow(),
            )
            db.add(ev)
        ev.status = "running"
        if case.status not in {"evaluating"}:
            from app.services.cases import set_status

            await set_status(
                db, case, "evaluating", actor_id=ctx.created_by, reason="evaluation started", force=True
            )
        await db.commit()
        ev_id = ev.id
    await ctx.progress(0.05, "Evaluation started")
    router = params.get("_router") or _router()
    ports = DbCasePorts(
        case_id=case_id,
        org_id=org_id,
        evaluation_id=ev_id,
        actor_id=ctx.created_by,
        policy_version_ids=params.get("policyVersionIds"),
        job_id=getattr(ctx, "job_id", None),
        router=router,
    )
    summary = await evaluate(
        ports,
        evaluation_id=str(ev_id),
        router=router,
        token_budget=int(getattr(get_settings(), "case_token_budget", 60_000)),
    )
    await ctx.progress(1.0, f"Readiness: {summary.get('readiness')}")
    return {
        "evaluationId": str(ev_id),
        "readiness": summary.get("readiness"),
        "readinessScore": summary.get("readiness_score"),
        "gaps": len(summary.get("gaps", [])),
        "degraded": summary.get("degraded"),
        "tokens": summary.get("token_usage"),
    }


async def draft_letter_job(ctx) -> dict:
    """params: {caseId, kind, letterId?, denialId?}"""
    from app.ai.drafting.letters import create_letter, letter_api
    from app.core.events import publish

    params = ctx.params or {}
    case_id = _uuid(params["caseId"])
    kind = params.get("kind", "lmn")
    letter_id = _uuid(params.get("letterId")) or uuid.uuid4()
    channel = f"case:{case_id}"
    await publish(channel, "letter.started", {"letterId": str(letter_id), "kind": kind})

    async def on_token(piece: str) -> None:
        await publish(channel, "letter.token", {"letterId": str(letter_id), "text": piece})

    sm = get_sessionmaker()
    async with sm() as db:
        case = await db.get(Case, case_id)
        denial_ctx, mapped = None, None
        if params.get("denialId"):
            d = await db.get(Denial, _uuid(params["denialId"]))
            if d is not None:
                denial_ctx = {
                    "received_at": d.received_at.isoformat() if d.received_at else "",
                    "category": d.category,
                    "carc_codes": d.carc_codes or [],
                    "rarc_codes": d.rarc_codes or [],
                    "reason_text": d.reason_text or "",
                    "appeal_deadline": d.appeal_deadline.isoformat() if d.appeal_deadline else "",
                }
                mapped = d.mapped_criteria or []
        letter = await create_letter(
            db,
            case=case,
            kind=kind,
            router=params.get("_router") or _router(),
            actor_id=ctx.created_by,
            denial=denial_ctx,
            mapped=mapped,
            on_token=on_token,
            letter_id=letter_id,
        )
        if params.get("denialId"):
            d = await db.get(Denial, _uuid(params["denialId"]))
            if d is not None:
                d.appeal_letter_id = letter.id
                d.status = "appeal_drafted"
        await db.commit()
        payload = letter_api(letter)
    await publish(channel, "letter.completed", {"letter": payload})
    return {"letterId": str(letter_id), "kind": kind, "source": payload["modelInfo"].get("source")}


async def criteria_candidates(db, case: Case) -> list[dict]:
    if not case.latest_evaluation_id:
        return []
    rows = (
        (
            await db.execute(
                select(CriterionResult).where(CriterionResult.evaluation_id == case.latest_evaluation_id)
            )
        )
        .scalars()
        .all()
    )
    from app.ai.agents.case_results import effective_verdict

    return [
        {
            "criterionId": r.criterion_id,
            "text": r.criterion_text,
            "verdict": effective_verdict(r),
            "policyQuote": (r.policy_citation or {}).get("quote"),
        }
        for r in rows
    ]


async def analyze_denial_job(ctx) -> dict:
    """params: {caseId, denialId, draftAppeal?: bool}"""
    from app.ai.drafting.denials import analyze_denial
    from app.core.events import publish

    params = ctx.params or {}
    sm = get_sessionmaker()
    async with sm() as db:
        case = await db.get(Case, _uuid(params["caseId"]))
        denial = await db.get(Denial, _uuid(params["denialId"]))
        text = denial.reason_text or ""
        if denial.document_id and not text:
            doc = await db.get(CaseDocument, denial.document_id)
            text = (doc.text_deid or "") if doc else ""
        analysis = await analyze_denial(
            text,
            received=denial.received_at,
            payer_type=case.payer_type,
            criteria=await criteria_candidates(db, case),
            router=params.get("_router") or _router(),
            org_id=case.org_id,
        )
        denial.carc_codes = sorted(set((denial.carc_codes or []) + analysis.carc_codes))
        denial.rarc_codes = sorted(set((denial.rarc_codes or []) + analysis.rarc_codes))
        denial.category = analysis.category
        denial.mapped_criteria = analysis.mapped_criteria
        denial.appeal_deadline = denial.appeal_deadline or analysis.appeal_deadline
        denial.analysis = analysis.as_dict()
        denial.status = "new" if denial.status == "analyzing" else denial.status
        from app.services.cases import add_event

        await add_event(
            db,
            case,
            "denial_recorded",
            {"denialId": str(denial.id), "category": denial.category, "carc": denial.carc_codes},
            ctx.created_by,
        )
        await db.commit()
        from app.api.v1.case_ai import denial_api

        payload = denial_api(denial)
    await publish(f"case:{params['caseId']}", "denial.analyzed", {"denial": payload})
    if params.get("draftAppeal", True):
        from app.services.jobs import enqueue

        async with sm() as db:
            await enqueue(
                db,
                "letter.draft",
                {"caseId": params["caseId"], "kind": "appeal", "denialId": params["denialId"]},
                org_id=ctx.org_id,
                created_by=ctx.created_by,
            )
            await db.commit()
    return {"denialId": params["denialId"], "category": payload["category"]}


async def compile_criteria_job(ctx) -> dict:
    """params: {sourceKeys?: [...], policyVersionIds?: [...], syncCurated?: bool}"""
    from app.ai.compiler.criteria_compiler import compile_policy, sync_curated

    params = ctx.params or {}
    keys: list[str] = list(params.get("sourceKeys") or [])
    sm = get_sessionmaker()
    out: dict[str, str] = {}
    async with sm() as db:
        if params.get("syncCurated", not keys and not params.get("policyVersionIds")):
            for cs in await sync_curated(db):
                out[cs.policy_key] = "approved (curated)"
            await db.commit()
        if params.get("policyVersionIds"):
            try:
                from app.db.models.knowledge import Policy, PolicyVersion

                for vid in params["policyVersionIds"]:
                    key = (
                        await db.execute(
                            select(Policy.source_key)
                            .join(PolicyVersion, PolicyVersion.policy_id == Policy.id)
                            .where(PolicyVersion.id == _uuid(vid))
                        )
                    ).scalar_one_or_none()
                    if key:
                        keys.append(key)
            except Exception:
                log.warning("criteria.compile.version_lookup_failed")
    router = _router()
    for i, key in enumerate(dict.fromkeys(keys)):
        await ctx.progress(i / max(1, len(keys)), f"Compiling {key}")
        async with sm() as db:
            try:
                cs = await compile_policy(
                    db,
                    policy_key=key,
                    router=router,
                    actor_id=ctx.created_by,
                    job_id=getattr(ctx, "job_id", None),
                )
                await db.commit()
                out[key] = cs.status
            except Exception as exc:
                await db.rollback()
                out[key] = f"error: {type(exc).__name__}: {str(exc)[:120]}"
    return {"results": out}


async def seed_demo_job(ctx) -> dict:
    """params: {orgId?, createOrg?: bool}"""
    from app.ai.synthetic.demo_seed import seed_demo_cases, seed_demo_org

    params = ctx.params or {}
    if params.get("createOrg") or not (params.get("orgId") or ctx.org_id):
        return await seed_demo_org(progress=ctx.progress)
    return await seed_demo_cases(
        org_id=_uuid(params.get("orgId")) or ctx.org_id, actor_id=ctx.created_by, progress=ctx.progress
    )


async def eval_run_job(ctx) -> dict:
    """params: {suite, limit?, live?}"""
    from app.ai.evaluation.runner import run_suite

    params = ctx.params or {}
    return await run_suite(
        params.get("suite", "verdicts"),
        limit=params.get("limit"),
        live=bool(params.get("live", False)),
        job_id=getattr(ctx, "job_id", None),
        progress=ctx.progress,
    )


JOB_HANDLERS = {
    "case.evaluate": run_case_evaluation,
    "letter.draft": draft_letter_job,
    "denial.analyze": analyze_denial_job,
    "criteria.compile": compile_criteria_job,
    "demo.seed": seed_demo_job,
    "eval.run": eval_run_job,
}
