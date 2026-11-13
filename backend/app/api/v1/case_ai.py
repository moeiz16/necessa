"""Case-AI endpoints: policy suggestions, evaluation (SSE), human review, next-best-actions, letters,
denials/appeals, FHIR exports and demo data (contract §4.3)."""

from __future__ import annotations

import re
import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.agents.case_results import criterion_result_api, evaluation_summary_api
from app.ai.agents.case_review import complete_review, evaluation_payload, next_actions, override_criterion
from app.core.deps import RequestContext, get_db, require_perm
from app.core.errors import AppError, bad_request, conflict, not_found
from app.db.base import utcnow
from app.db.models.cases import CaseDocument, CaseEvaluation, CriterionResult, Denial, Letter
from app.schemas.evaluation import DenialIn, DenialPatch, EvaluateIn, EvaluateOut, OverrideIn
from app.schemas.letters import LetterCreateIn, LetterCreateOut, LetterPatch

router = APIRouter(tags=["case-ai"])


def _uuid(v: str, what: str = "id") -> uuid.UUID:
    try:
        return uuid.UUID(str(v))
    except ValueError as exc:
        raise not_found(what) from exc


async def _case(db: AsyncSession, ctx: RequestContext, case_id: uuid.UUID):
    from app.services.cases import get_case

    return await get_case(db, ctx.org_id, case_id)


async def _audit(db, ctx, action: str, resource_id, **meta) -> None:
    from app.services.audit import audit

    await audit(db, ctx, action=action, resource_type="case", resource_id=resource_id, metadata=meta)


# ── policy suggestions (assistive, during case creation) ──────────────────────────────────────


@router.post("/cases/{case_id}/policy-suggestions")
async def policy_suggestions(
    case_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.ai.agents.case_ports import merge_curated

    case = await _case(db, ctx, case_id)
    matches: list[dict] = []
    try:
        from app.ai.sql.tools import resolve_policies

        found = await resolve_policies(
            db,
            service_codes=list(case.service_codes or []),
            dx_codes=list(case.dx_codes or []),
            state=case.state,
            payer_type=case.payer_type,
            date_of_service=case.date_of_service or date.today(),
        )
        matches = [
            m
            if isinstance(m, dict)
            else (m.model_dump(by_alias=True) if hasattr(m, "model_dump") else vars(m))
            for m in found
        ]
    except Exception:
        matches = []
    matches = merge_curated(matches, list(case.service_codes or []), case.payer_type)
    from app.ai.compiler.criteria_compiler import approved_set

    for m in matches:
        if not m.get("criteriaSetStatus"):
            cs = await approved_set(db, m.get("sourceKey"), m.get("policyVersionId"))
            m["criteriaSetStatus"] = cs.status if cs else "missing"
    return {"matches": matches}


# ── evaluation ─────────────────────────────────────────────────────────────────────────────────


@router.post("/cases/{case_id}/evaluate", response_model=EvaluateOut, status_code=202)
async def start_evaluation(
    case_id: uuid.UUID,
    body: EvaluateIn | None = None,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
) -> EvaluateOut:
    from app.services.cases import add_event, set_status
    from app.services.jobs import enqueue

    case = await _case(db, ctx, case_id)
    running = (
        await db.execute(
            select(CaseEvaluation.id).where(
                CaseEvaluation.case_id == case.id, CaseEvaluation.status == "running"
            )
        )
    ).first()
    if running:
        raise conflict("evaluation_running", "An evaluation is already running for this case.")
    has_docs = (
        await db.execute(
            select(CaseDocument.id)
            .where(CaseDocument.case_id == case.id, CaseDocument.quarantined.is_(False))
            .limit(1)
        )
    ).first()
    if not has_docs:
        raise conflict(
            "no_documents", "Attach at least one (non-quarantined) clinical document before evaluating."
        )
    ev = CaseEvaluation(
        org_id=case.org_id,
        case_id=case.id,
        status="running",
        readiness="unknown",
        started_by=ctx.user.id,
        started_at=utcnow(),
    )
    db.add(ev)
    await db.flush()
    await set_status(db, case, "evaluating", actor_id=ctx.user.id, reason="evaluation started", force=True)
    await add_event(db, case, "evaluation_started", {"evaluationId": str(ev.id)}, ctx.user.id)
    job = await enqueue(
        db,
        "case.evaluate",
        {
            "caseId": str(case.id),
            "evaluationId": str(ev.id),
            "policyVersionIds": (body.policy_version_ids if body else None),
        },
        org_id=case.org_id,
        created_by=ctx.user.id,
    )
    await _audit(db, ctx, "case.evaluate", case.id, evaluationId=str(ev.id), jobId=str(job.id))
    return EvaluateOut(evaluation_id=str(ev.id), job_id=str(job.id))


@router.get("/cases/{case_id}/events")
async def case_events(
    case_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
):
    from app.core.events import bus, sse_response

    case = await _case(db, ctx, case_id)
    channel = f"case:{case.id}"
    replay = list(bus.recent(channel))
    if not replay and case.latest_evaluation_id:
        ev = await db.get(CaseEvaluation, case.latest_evaluation_id)
        if ev is not None:
            replay = [("evaluation.snapshot", {"evaluation": await evaluation_payload(db, ev)})]
    return sse_response(channel, replay=replay)


@router.get("/cases/{case_id}/evaluations")
async def list_evaluations(
    case_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    case = await _case(db, ctx, case_id)
    rows = (
        (
            await db.execute(
                select(CaseEvaluation)
                .where(CaseEvaluation.case_id == case.id)
                .order_by(CaseEvaluation.started_at.desc())
                .limit(50)
            )
        )
        .scalars()
        .all()
    )
    return [evaluation_summary_api(r) for r in rows]


async def _evaluation(db, case, eval_id: uuid.UUID) -> CaseEvaluation:
    ev = await db.get(CaseEvaluation, eval_id)
    if ev is None or ev.case_id != case.id:
        raise not_found("Evaluation")
    return ev


@router.get("/cases/{case_id}/evaluations/{eval_id}")
async def get_evaluation(
    case_id: uuid.UUID,
    eval_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    case = await _case(db, ctx, case_id)
    return await evaluation_payload(db, await _evaluation(db, case, eval_id))


@router.patch("/cases/{case_id}/criteria/{result_id}")
async def override(
    case_id: uuid.UUID,
    result_id: uuid.UUID,
    body: OverrideIn,
    ctx: RequestContext = Depends(require_perm("cases:review")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.core.events import publish

    case = await _case(db, ctx, case_id)
    row = await db.get(CriterionResult, result_id)
    if row is None or row.case_id != case.id:
        raise not_found("Criterion result")
    try:
        row = await override_criterion(
            db,
            case=case,
            result=row,
            verdict=body.override_verdict,
            reason=body.override_reason,
            actor_id=ctx.user.id,
        )
    except ValueError as exc:
        raise bad_request("invalid_override", str(exc)) from exc
    await _audit(
        db,
        ctx,
        "case.criterion.override",
        case.id,
        criterionId=row.criterion_id,
        verdict=row.override_verdict or "cleared",
    )
    api = criterion_result_api(row, {"id": str(ctx.user.id), "fullName": ctx.user.full_name})
    ev = await db.get(CaseEvaluation, row.evaluation_id)
    await publish(f"case:{case.id}", "criterion.verdict", {"result": api})
    if ev is not None:
        await publish(
            f"case:{case.id}",
            "evaluation.aggregate",
            {"readiness": ev.readiness, "readinessScore": ev.readiness_score, "tree": ev.tree_result},
        )
        await publish(f"case:{case.id}", "evaluation.gaps", {"gaps": ev.gaps})
    return api


@router.post("/cases/{case_id}/evaluations/{eval_id}/complete-review")
async def finish_review(
    case_id: uuid.UUID,
    eval_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("cases:review")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.core.events import publish

    case = await _case(db, ctx, case_id)
    ev = await _evaluation(db, case, eval_id)
    if ev.status not in {"awaiting_review", "completed"}:
        raise conflict("not_reviewable", f"Evaluation is '{ev.status}', it cannot be reviewed yet.")
    ev = await complete_review(db, case=case, ev=ev, actor_id=ctx.user.id)
    await _audit(db, ctx, "case.review.completed", case.id, evaluationId=str(ev.id), readiness=ev.readiness)
    payload = await evaluation_payload(db, ev)
    await publish(f"case:{case.id}", "evaluation.completed", {"evaluation": payload})
    return payload


@router.get("/cases/{case_id}/next-actions")
async def get_next_actions(
    case_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return await next_actions(db, await _case(db, ctx, case_id))


# ── letters ───────────────────────────────────────────────────────────────────────────────────


@router.post("/cases/{case_id}/letters", response_model=LetterCreateOut, status_code=202)
async def draft_letter(
    case_id: uuid.UUID,
    body: LetterCreateIn,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
) -> LetterCreateOut:
    from app.services.jobs import enqueue

    case = await _case(db, ctx, case_id)
    letter_id = uuid.uuid4()
    params = {"caseId": str(case.id), "kind": body.kind, "letterId": str(letter_id)}
    if body.denial_id:
        params["denialId"] = body.denial_id
    job = await enqueue(db, "letter.draft", params, org_id=case.org_id, created_by=ctx.user.id)
    await _audit(db, ctx, "case.letter.draft", case.id, kind=body.kind, letterId=str(letter_id))
    return LetterCreateOut(letter_id=str(letter_id), job_id=str(job.id))


async def _letter(db, case, letter_id: uuid.UUID) -> Letter:
    letter = await db.get(Letter, letter_id)
    if letter is None or letter.case_id != case.id:
        raise not_found("Letter")
    return letter


@router.get("/cases/{case_id}/letters")
async def list_letters(
    case_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    from app.ai.drafting.letters import letter_api

    case = await _case(db, ctx, case_id)
    rows = (
        (await db.execute(select(Letter).where(Letter.case_id == case.id).order_by(Letter.created_at.desc())))
        .scalars()
        .all()
    )
    return [letter_api(r) for r in rows]


@router.get("/cases/{case_id}/letters/{letter_id}")
async def get_letter(
    case_id: uuid.UUID,
    letter_id: uuid.UUID,
    reveal: bool = False,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.ai.drafting.letters import letter_api, rehydrate, rehydration_values

    case = await _case(db, ctx, case_id)
    letter = await _letter(db, case, letter_id)
    rendered = None
    if reveal:
        if not ctx.has("phi:reveal"):
            raise AppError(403, "forbidden", "Forbidden", "Missing permission 'phi:reveal'.")
        rendered = rehydrate(letter.content_md, await rehydration_values(db, case))
        await _audit(db, ctx, "case.letter.reveal", case.id, letterId=str(letter.id))
    return letter_api(letter, rendered=rendered)


_MASKED = re.compile(r"«([A-Za-z ]+)»")


def unmask(md: str) -> str:
    return _MASKED.sub(lambda m: f"<<{m.group(1).strip().upper().replace(' ', '_')}>>", md)


@router.patch("/cases/{case_id}/letters/{letter_id}")
async def update_letter(
    case_id: uuid.UUID,
    letter_id: uuid.UUID,
    body: LetterPatch,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.ai.drafting.letters import letter_api
    from app.services.cases import add_event

    case = await _case(db, ctx, case_id)
    letter = await _letter(db, case, letter_id)
    if letter.status == "approved" and body.content_md is not None:
        raise conflict("letter_locked", "Approved letters are locked; set status back to 'draft' to edit.")
    if body.content_md is not None:
        letter.content_md = unmask(body.content_md)
        letter.version += 1
    if body.status is not None:
        if body.status == "approved":
            if not ctx.has("letters:approve"):
                raise AppError(403, "forbidden", "Forbidden", "Only clinicians/admins can approve letters.")
            letter.approved_by, letter.approved_at = ctx.user.id, utcnow()
            await add_event(
                db, case, "letter_approved", {"letterId": str(letter.id), "kind": letter.kind}, ctx.user.id
            )
        elif letter.status == "approved":
            letter.approved_by, letter.approved_at = None, None
        letter.status = body.status
    await db.flush()
    await _audit(
        db,
        ctx,
        "case.letter.update",
        case.id,
        letterId=str(letter.id),
        status=letter.status,
        version=letter.version,
    )
    return letter_api(letter)


@router.get("/cases/{case_id}/letters/{letter_id}/export")
async def export_letter(
    case_id: uuid.UUID,
    letter_id: uuid.UUID,
    format: str = Query("pdf", pattern="^(pdf|md|docx-lite|fhir)$"),
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    from app.ai.drafting.exports import to_pdf, to_word_html
    from app.ai.drafting.letters import rehydrate, rehydration_values

    case = await _case(db, ctx, case_id)
    letter = await _letter(db, case, letter_id)
    if not ctx.has("phi:reveal"):
        raise AppError(403, "forbidden", "Forbidden", "Exports contain PHI and require 'phi:reveal'.")
    md = rehydrate(letter.content_md, await rehydration_values(db, case))
    await _audit(db, ctx, "case.letter.export", case.id, letterId=str(letter.id), format=format)
    if letter.status == "approved":
        letter.status = "exported"
    stem = f"{case.number}-{letter.kind}-v{letter.version}"
    if format == "md":
        return Response(
            md,
            media_type="text/markdown",
            headers={"Content-Disposition": f'attachment; filename="{stem}.md"'},
        )
    if format == "docx-lite":
        return Response(
            to_word_html(md, letter.title),
            media_type="application/msword",
            headers={"Content-Disposition": f'attachment; filename="{stem}.doc"'},
        )
    if format == "fhir":
        import base64
        import json

        doc = {
            "resourceType": "DocumentReference",
            "status": "current",
            "type": {"text": letter.title},
            "content": [
                {
                    "attachment": {
                        "contentType": "text/markdown",
                        "title": letter.title,
                        "data": base64.b64encode(md.encode()).decode(),
                    }
                }
            ],
        }
        return Response(
            json.dumps(doc),
            media_type="application/fhir+json",
            headers={"Content-Disposition": f'attachment; filename="{stem}.fhir.json"'},
        )
    return Response(
        to_pdf(md, title=letter.title, footer=f"{case.number} · {letter.title}"),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{stem}.pdf"'},
    )


# ── denials ───────────────────────────────────────────────────────────────────────────────────


def denial_api(d: Denial) -> dict:
    return {
        "id": str(d.id),
        "caseId": str(d.case_id),
        "documentId": str(d.document_id) if d.document_id else None,
        "receivedAt": d.received_at.isoformat() if d.received_at else None,
        "reasonText": d.reason_text,
        "carcCodes": d.carc_codes or [],
        "rarcCodes": d.rarc_codes or [],
        "category": d.category,
        "mappedCriteria": d.mapped_criteria or [],
        "appealDeadline": d.appeal_deadline.isoformat() if d.appeal_deadline else None,
        "appealLetterId": str(d.appeal_letter_id) if d.appeal_letter_id else None,
        "status": d.status,
        "analysis": d.analysis or {},
        "createdAt": d.created_at.isoformat() if d.created_at else None,
        "updatedAt": d.updated_at.isoformat() if d.updated_at else None,
    }


@router.post("/cases/{case_id}/denials", status_code=201)
async def record_denial(
    case_id: uuid.UUID,
    body: DenialIn,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.services.jobs import enqueue

    case = await _case(db, ctx, case_id)
    doc_id = _uuid(body.document_id, "Document") if body.document_id else None
    if doc_id:
        doc = await db.get(CaseDocument, doc_id)
        if doc is None or doc.case_id != case.id:
            raise not_found("Document")
    if not (body.text or doc_id):
        raise bad_request("denial_text_required", "Provide the denial text or a denial letter document.")
    d = Denial(
        org_id=case.org_id,
        case_id=case.id,
        document_id=doc_id,
        received_at=body.received_at or date.today(),
        reason_text=body.text,
        carc_codes=body.carc_codes,
        rarc_codes=[],
        category="other",
        mapped_criteria=[],
        status="analyzing",
        analysis={},
    )
    db.add(d)
    await db.flush()
    if case.status in {"submitted", "pending_payer", "appealing"}:
        from app.services.cases import set_status

        await set_status(db, case, "denied", actor_id=ctx.user.id, reason="denial recorded")
    job = await enqueue(
        db,
        "denial.analyze",
        {"caseId": str(case.id), "denialId": str(d.id), "draftAppeal": body.draft_appeal},
        org_id=case.org_id,
        created_by=ctx.user.id,
    )
    await _audit(db, ctx, "case.denial.record", case.id, denialId=str(d.id))
    return {**denial_api(d), "jobId": str(job.id)}


@router.get("/cases/{case_id}/denials")
async def list_case_denials(
    case_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    case = await _case(db, ctx, case_id)
    rows = (
        (await db.execute(select(Denial).where(Denial.case_id == case.id).order_by(Denial.created_at.desc())))
        .scalars()
        .all()
    )
    return [denial_api(r) for r in rows]


@router.patch("/cases/{case_id}/denials/{denial_id}")
async def update_denial(
    case_id: uuid.UUID,
    denial_id: uuid.UUID,
    body: DenialPatch,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    case = await _case(db, ctx, case_id)
    d = await db.get(Denial, denial_id)
    if d is None or d.case_id != case.id:
        raise not_found("Denial")
    for field in ("status", "appeal_deadline", "category", "reason_text"):
        val = getattr(body, field)
        if val is not None:
            setattr(d, field, val)
    if body.status == "appealed" and case.status == "denied":
        from app.services.cases import set_status

        await set_status(db, case, "appealing", actor_id=ctx.user.id, reason="appeal filed")
    await db.flush()
    await _audit(db, ctx, "case.denial.update", case.id, denialId=str(d.id), status=d.status)
    return denial_api(d)


@router.get("/denials")
async def list_denials(
    status: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Org-wide denials & appeals worklist (additive to the contract; powers the Denials page)."""
    from app.db.models.cases import Case
    from app.services.cases import case_summaries

    q = select(Denial).where(Denial.org_id == ctx.org_id)
    if status:
        q = q.where(Denial.status == status)
    rows = (
        (await db.execute(q.order_by(Denial.appeal_deadline.asc().nulls_last()).limit(limit))).scalars().all()
    )
    from app.schemas.cases import CaseSummary

    cases = {
        c.id: c
        for c in (await db.execute(select(Case).where(Case.id.in_({r.case_id for r in rows})))).scalars()
    }
    summaries = {}
    for s in (await case_summaries(db, list(cases.values()))) if cases else []:
        api = CaseSummary.model_validate(s).model_dump(mode="json", by_alias=True)
        summaries[api["id"]] = api
    return [{**denial_api(r), "case": summaries.get(str(r.case_id))} for r in rows]


# ── exports ───────────────────────────────────────────────────────────────────────────────────


@router.get("/cases/{case_id}/export/fhir")
async def export_fhir(
    case_id: uuid.UUID,
    type: str = Query("questionnaire", pattern="^(questionnaire|pas)$"),
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.ai.drafting.exports import pas_claim_bundle, questionnaire_response
    from app.ai.drafting.letters import letter_api

    case = await _case(db, ctx, case_id)
    if not case.latest_evaluation_id:
        raise conflict("no_evaluation", "Run an evaluation before exporting.")
    ev = await db.get(CaseEvaluation, case.latest_evaluation_id)
    payload = await evaluation_payload(db, ev)
    case_dict = {
        "patientId": str(case.patient_id),
        "payerName": case.payer_name,
        "payerType": case.payer_type,
        "priority": case.priority,
        "dxCodes": case.dx_codes or [],
        "serviceCodes": case.service_codes or [],
        "dateOfService": case.date_of_service.isoformat() if case.date_of_service else None,
    }
    await _audit(db, ctx, "case.export.fhir", case.id, type=type)
    if type == "pas":
        letters = (
            (
                await db.execute(
                    select(Letter).where(
                        Letter.case_id == case.id, Letter.status.in_(["approved", "exported"])
                    )
                )
            )
            .scalars()
            .all()
        )
        return pas_claim_bundle(case_dict, payload, payload["criteria"], [letter_api(x) for x in letters])
    return questionnaire_response(case_dict, payload, payload["criteria"])


# ── demo data ─────────────────────────────────────────────────────────────────────────────────


@router.post("/orgs/current/demo-data", status_code=202)
async def seed_demo(
    ctx: RequestContext = Depends(require_perm("org:admin")), db: AsyncSession = Depends(get_db)
) -> dict:
    from app.services.jobs import enqueue, job_to_dict

    job = await enqueue(
        db, "demo.seed", {"orgId": str(ctx.org_id)}, org_id=ctx.org_id, created_by=ctx.user.id
    )
    from app.services.audit import audit

    await audit(
        db,
        ctx,
        action="org.demo_data.seed",
        resource_type="org",
        resource_id=ctx.org_id,
        metadata={"jobId": str(job.id)},
    )
    return job_to_dict(job)
