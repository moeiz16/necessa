"""Case worklist, case CRUD, documents, timeline, comments, outcomes and patients (non-AI endpoints)."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, File, Form, Query, Response, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import RequestContext, get_db, require_perm
from app.core.errors import AppError, forbidden, not_found
from app.core.events import publish
from app.db.models.cases import Case, CaseDocument, Patient
from app.schemas.base import Page
from app.schemas.cases import (
    CaseCreateIn,
    CaseDocumentDetailOut,
    CaseDocumentOut,
    CaseEventOut,
    CaseOut,
    CaseStatsOut,
    CaseSummary,
    CaseUpdateIn,
    CommentIn,
    DocumentKind,
    DocumentTextIn,
    OutcomeIn,
    PatientOut,
)
from app.services import cases as case_svc
from app.services import documents as doc_svc
from app.services.audit import audit
from app.services.notifications import notify

router = APIRouter(tags=["cases"])


async def _broadcast(case: Case, event: str, data: dict) -> None:
    await publish(f"case:{case.id}", event, data)


# ── Worklist ─────────────────────────────────────────────────────────────────
@router.get("/cases", response_model=Page[CaseSummary])
async def list_cases(
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
    status_: str | None = Query(None, alias="status", description="Comma-separated statuses or 'open'"),
    priority: str | None = None,
    assignee: str | None = Query(None, description="'me', 'unassigned' or a user id"),
    readiness: str | None = None,
    payer_type: str | None = Query(None, alias="payerType"),
    q: str | None = Query(None, max_length=120),
    due_before: datetime | None = Query(None, alias="dueBefore"),
    tag: str | None = Query(None, max_length=60),
    include_closed: bool = Query(False, alias="includeClosed"),
    sort: str = "-updatedAt",
    limit: int = Query(25, ge=1, le=100),
    cursor: str | None = None,
):
    filters = {
        "status": status_,
        "priority": priority,
        "assignee": assignee,
        "readiness": readiness,
        "payer_type": payer_type,
        "q": q,
        "due_before": due_before,
        "tag": tag,
        "include_closed": include_closed,
    }
    rows, next_cursor, total = await case_svc.list_cases(
        db, ctx.org_id, ctx.user.id, filters, sort=sort, limit=limit, cursor=cursor
    )
    return Page[CaseSummary](
        items=await case_svc.case_summaries(db, rows), next_cursor=next_cursor, total=total
    )


@router.get("/cases/stats", response_model=CaseStatsOut)
async def case_stats(
    ctx: RequestContext = Depends(require_perm("cases:read")), db: AsyncSession = Depends(get_db)
):
    return await case_svc.case_stats(db, ctx.org_id, ctx.user.id)


@router.post("/cases", response_model=CaseOut, status_code=status.HTTP_201_CREATED)
async def create_case(
    body: CaseCreateIn,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
):
    case = await case_svc.create_case(db, ctx.org, ctx.user, body.model_dump())  # type: ignore[arg-type]
    await audit(
        db,
        ctx,
        action="case.created",
        resource_type="case",
        resource_id=case.id,
        metadata={"number": case.number, "serviceCodes": case.service_codes},
    )
    if case.assignee_id and case.assignee_id != ctx.user.id:
        await notify(
            db,
            org_id=ctx.org_id,
            type="case_assigned",
            title=f"{case.number} was assigned to you",
            link=f"/cases/{case.id}",
            user_ids=[case.assignee_id],
        )
    return await case_svc.case_detail(db, case)


@router.get("/cases/{case_id}", response_model=CaseOut)
async def get_case(
    case_id: uuid.UUID,
    reveal: bool = False,
    reason: str | None = Query(
        None, max_length=200, description="Purpose of use, recorded with a PHI reveal"
    ),
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
):
    case = await case_svc.get_case(db, ctx.org_id, case_id)
    detail = await case_svc.case_detail(db, case)
    if not reveal:
        return detail
    if not ctx.has("phi:reveal"):
        raise forbidden("Missing permission 'phi:reveal'.")
    patient = await case_svc.get_patient(db, ctx.org_id, case.patient_id)
    demo = case_svc.patient_out(patient, reveal=True).get("demographics") or {}
    await audit(
        db,
        ctx,
        action="phi.patient_revealed",
        resource_type="patient",
        resource_id=patient.id,
        metadata={"caseId": str(case.id), "reason": (reason or "").strip() or None},
    )
    out = CaseOut.model_validate(detail)
    out.patient_revealed = {k: demo.get(k) for k in ("fullName", "dob", "memberId", "mrn")}
    return out


@router.patch("/cases/{case_id}", response_model=CaseOut)
async def update_case(
    case_id: uuid.UUID,
    body: CaseUpdateIn,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
):
    case = await case_svc.get_case(db, ctx.org_id, case_id)
    patch = body.model_dump(exclude_unset=True)
    previous_assignee = case.assignee_id
    changed = await case_svc.update_case(db, ctx.org, case, patch, ctx.user.id)  # type: ignore[arg-type]
    if changed:
        await audit(
            db,
            ctx,
            action="case.updated",
            resource_type="case",
            resource_id=case.id,
            metadata={"fields": changed},
        )
        await _broadcast(
            case, "case.updated", {"caseId": str(case.id), "fields": changed, "status": case.status}
        )
    if case.assignee_id and case.assignee_id != previous_assignee and case.assignee_id != ctx.user.id:
        await notify(
            db,
            org_id=ctx.org_id,
            type="case_assigned",
            title=f"{case.number} was assigned to you",
            link=f"/cases/{case.id}",
            user_ids=[case.assignee_id],
        )
    return await case_svc.case_detail(db, case)


@router.delete("/cases/{case_id}", status_code=status.HTTP_204_NO_CONTENT)
async def close_case(
    case_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    case = await case_svc.get_case(db, ctx.org_id, case_id)
    if case.status != "closed":
        await case_svc.set_status(db, case, "closed", actor_id=ctx.user.id, reason="closed by user")
        await audit(db, ctx, action="case.closed", resource_type="case", resource_id=case.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Documents ────────────────────────────────────────────────────────────────
def _doc_out(doc: CaseDocument) -> CaseDocumentOut:
    return CaseDocumentOut.model_validate(doc)


async def _case_and_patient(
    db: AsyncSession, ctx: RequestContext, case_id: uuid.UUID
) -> tuple[Case, Patient]:
    case = await case_svc.get_case(db, ctx.org_id, case_id)
    if case.status == "closed":
        raise AppError(409, "case_closed", "Case is closed", "Reopen the case before adding documents.")
    patient = await db.get(Patient, case.patient_id)
    assert patient is not None
    return case, patient


@router.post(
    "/cases/{case_id}/documents", response_model=CaseDocumentOut, status_code=status.HTTP_201_CREATED
)
async def upload_document(
    case_id: uuid.UUID,
    file: UploadFile = File(...),
    kind: DocumentKind = Form("clinical_note"),
    note_date: date | None = Form(None, alias="noteDate"),
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
):
    case, patient = await _case_and_patient(db, ctx, case_id)
    raw = await file.read(doc_svc.MAX_UPLOAD_BYTES + 1)
    extracted = doc_svc.extract(raw, file.filename or "upload", file.content_type)
    if extracted.mime == "application/fhir+json":
        kind = "fhir_bundle"
    doc = await doc_svc.store_document(
        db,
        case,
        patient,
        kind=kind,
        filename=file.filename or "upload",
        raw=raw,
        extracted=extracted,
        note_date=note_date,
        uploaded_by=ctx.user.id,
    )
    await audit(
        db,
        ctx,
        action="case.document_uploaded",
        resource_type="case_document",
        resource_id=doc.id,
        metadata={
            "caseId": str(case.id),
            "kind": kind,
            "mime": doc.mime,
            "sizeBytes": doc.size_bytes,
            "quarantined": doc.quarantined,
        },
    )
    await _broadcast(case, "document.added", {"documentId": str(doc.id), "kind": doc.kind})
    return _doc_out(doc)


@router.post(
    "/cases/{case_id}/documents/text", response_model=CaseDocumentOut, status_code=status.HTTP_201_CREATED
)
async def add_text_document(
    case_id: uuid.UUID,
    body: DocumentTextIn,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
):
    case, patient = await _case_and_patient(db, ctx, case_id)
    raw = body.text.encode("utf-8")
    extracted = doc_svc.Extracted(text=doc_svc.clean_text(body.text), mime="text/markdown")
    filename = (body.title or f"{body.kind.replace('_', ' ').title()}").strip()[:200] + ".md"
    doc = await doc_svc.store_document(
        db,
        case,
        patient,
        kind=body.kind,
        filename=filename,
        raw=raw,
        extracted=extracted,
        note_date=body.note_date,
        uploaded_by=ctx.user.id,
    )
    await audit(
        db,
        ctx,
        action="case.document_added",
        resource_type="case_document",
        resource_id=doc.id,
        metadata={"caseId": str(case.id), "kind": body.kind, "quarantined": doc.quarantined},
    )
    await _broadcast(case, "document.added", {"documentId": str(doc.id), "kind": doc.kind})
    return _doc_out(doc)


@router.get("/cases/{case_id}/documents", response_model=list[CaseDocumentOut])
async def list_documents(
    case_id: uuid.UUID,
    limit: int = Query(200, ge=1, le=500),
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
):
    case = await case_svc.get_case(db, ctx.org_id, case_id)
    rows = (
        (
            await db.execute(
                select(CaseDocument)
                .where(CaseDocument.case_id == case.id)
                .order_by(CaseDocument.created_at)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [_doc_out(d) for d in rows]


@router.get("/cases/{case_id}/documents/{doc_id}", response_model=CaseDocumentDetailOut)
async def get_document(
    case_id: uuid.UUID,
    doc_id: uuid.UUID,
    reveal: bool = False,
    reason: str | None = Query(
        None, max_length=200, description="Purpose of use, recorded with a PHI reveal"
    ),
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
):
    case = await case_svc.get_case(db, ctx.org_id, case_id)
    doc = await db.get(CaseDocument, doc_id)
    if not doc or doc.case_id != case.id:
        raise not_found("Document")
    if reveal:
        if not ctx.has("phi:reveal"):
            raise forbidden("Missing permission 'phi:reveal'.")
        await audit(
            db,
            ctx,
            action="phi.document_revealed",
            resource_type="case_document",
            resource_id=doc.id,
            metadata={"caseId": str(case.id), "reason": (reason or "").strip() or None},
        )
    out = CaseDocumentDetailOut.model_validate(doc)
    out.text = doc_svc.document_text(doc, reveal)
    out.revealed = reveal
    return out


@router.delete("/cases/{case_id}/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    case_id: uuid.UUID,
    doc_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    case = await case_svc.get_case(db, ctx.org_id, case_id)
    doc = await db.get(CaseDocument, doc_id)
    if not doc or doc.case_id != case.id:
        raise not_found("Document")
    await db.delete(doc)
    await case_svc.add_event(
        db, case, "document_removed", {"documentId": str(doc_id), "filename": doc.filename}, ctx.user.id
    )
    await audit(
        db,
        ctx,
        action="case.document_deleted",
        resource_type="case_document",
        resource_id=doc_id,
        metadata={"caseId": str(case.id)},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Timeline / comments / outcome ────────────────────────────────────────────
@router.get("/cases/{case_id}/timeline", response_model=list[CaseEventOut])
async def get_timeline(
    case_id: uuid.UUID,
    limit: int = Query(200, ge=1, le=500),
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
):
    return await case_svc.timeline(db, await case_svc.get_case(db, ctx.org_id, case_id), limit=limit)


@router.post("/cases/{case_id}/comments", response_model=CaseEventOut, status_code=status.HTTP_201_CREATED)
async def add_comment(
    case_id: uuid.UUID,
    body: CommentIn,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
):
    case = await case_svc.get_case(db, ctx.org_id, case_id)
    ev = await case_svc.add_event(db, case, "comment", {"body": body.body.strip()}, ctx.user.id)
    await _broadcast(case, "case.comment", {"eventId": str(ev.id)})
    if case.assignee_id and case.assignee_id != ctx.user.id:
        await notify(
            db,
            org_id=ctx.org_id,
            type="case_comment",
            title=f"New comment on {case.number}",
            body=body.body[:140],
            link=f"/cases/{case.id}",
            user_ids=[case.assignee_id],
        )
    return {
        "id": ev.id,
        "type": ev.type,
        "payload": ev.payload,
        "actor": case_svc.user_mini(ctx.user),
        "created_at": ev.created_at,
    }


@router.post("/cases/{case_id}/outcome", response_model=CaseOut)
async def record_outcome(
    case_id: uuid.UUID,
    body: OutcomeIn,
    ctx: RequestContext = Depends(require_perm("cases:write")),
    db: AsyncSession = Depends(get_db),
):
    case = await case_svc.get_case(db, ctx.org_id, case_id)
    await case_svc.record_outcome(db, case, body.outcome, body.note, ctx.user.id)
    await audit(
        db,
        ctx,
        action="case.outcome_recorded",
        resource_type="case",
        resource_id=case.id,
        metadata={"outcome": body.outcome},
    )
    await _broadcast(
        case, "case.updated", {"caseId": str(case.id), "status": case.status, "outcome": case.outcome}
    )
    return await case_svc.case_detail(db, case)


# ── Patients ─────────────────────────────────────────────────────────────────
@router.get("/patients", response_model=Page[PatientOut])
async def list_patients(
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    total = (
        await db.execute(select(func.count()).select_from(Patient).where(Patient.org_id == ctx.org_id))
    ).scalar_one()
    rows = (
        (
            await db.execute(
                select(Patient)
                .where(Patient.org_id == ctx.org_id)
                .order_by(Patient.created_at.desc())
                .offset(offset)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    nxt = str(offset + limit) if offset + limit < total else None
    return Page[PatientOut](items=[case_svc.patient_out(p) for p in rows], next_cursor=nxt, total=total)


@router.get("/patients/{patient_id}", response_model=PatientOut)
async def get_patient(
    patient_id: uuid.UUID,
    reveal: bool = False,
    ctx: RequestContext = Depends(require_perm("cases:read")),
    db: AsyncSession = Depends(get_db),
):
    p = await case_svc.get_patient(db, ctx.org_id, patient_id)
    if reveal:
        if not ctx.has("phi:reveal"):
            raise forbidden("Missing permission 'phi:reveal'.")
        await audit(db, ctx, action="phi.patient_revealed", resource_type="patient", resource_id=p.id)
    return case_svc.patient_out(p, reveal=reveal)
