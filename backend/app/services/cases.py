"""Case management: creation, worklist queries, status state machine, timeline, outcomes.

Other workstreams should use `add_event`, `set_status` and `case_summary` rather than touching rows ad hoc,
so the timeline and SLA logic stay consistent.
"""

from __future__ import annotations

import base64
import json
import secrets
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import String, cast, func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import decrypt_json, encrypt_json
from app.core.errors import bad_request, conflict, not_found
from app.db.base import utcnow
from app.db.models.cases import OPEN_STATUSES, Case, CaseDocument, CaseEvent, Patient
from app.db.models.platform import DEFAULT_ORG_SETTINGS, Membership, Organization, User

# status -> allowed next statuses. "closed" is reachable from everywhere (soft delete / withdraw);
# a closed case can be reopened to draft.
TRANSITIONS: dict[str, set[str]] = {
    "draft": {"evaluating", "needs_review", "ready", "closed"},
    "evaluating": {"draft", "needs_review", "ready", "closed"},
    "needs_review": {"evaluating", "ready", "draft", "closed"},
    "ready": {"submitted", "evaluating", "needs_review", "draft", "closed"},
    "submitted": {"pending_payer", "approved", "denied", "closed"},
    "pending_payer": {"approved", "denied", "closed"},
    "denied": {"appealing", "closed"},
    "appealing": {"pending_payer", "approved", "denied", "closed"},
    "approved": {"closed"},
    "closed": {"draft"},
}
OUTCOME_FROM = {"submitted", "pending_payer", "appealing"}
OUTCOME_TO_STATUS = {"approved": "approved", "partial": "approved", "denied": "denied", "withdrawn": "closed"}
SORTS = {"dueAt", "-dueAt", "updatedAt", "-updatedAt", "createdAt", "-createdAt", "number", "-number"}
_FAR_FUTURE = datetime(9999, 1, 1, tzinfo=UTC)


# ── Patients ─────────────────────────────────────────────────────────────────
def mask_name(full_name: str) -> str:
    parts = [p for p in full_name.replace(",", " ").split() if p[:1].isalpha()]
    if not parts:
        return "Patient"
    initials = [parts[0][0].upper()]
    if len(parts) > 1:
        initials.append(parts[-1][0].upper())
    return " ".join(f"{i}." for i in initials)


async def create_patient(
    db: AsyncSession,
    org_id: uuid.UUID,
    data: dict,
    *,
    source: str = "manual",
    fhir_bundle: dict | None = None,
) -> Patient:
    dob = data.get("dob")
    dob_s = dob.isoformat() if isinstance(dob, date) else dob
    mrn = data.get("mrn") or f"MRN-{secrets.token_hex(4).upper()}"
    demographics = {
        "fullName": data["full_name"],
        "dob": dob_s,
        "sex": data.get("sex"),
        "state": data.get("state"),
        "memberId": data.get("member_id"),
        "phone": data.get("phone"),
        "address": data.get("address"),
        "mrn": mrn,
    }
    patient = Patient(
        org_id=org_id,
        external_ref=mrn,
        demographics_enc=encrypt_json(demographics),
        masked_name=mask_name(data["full_name"]),
        sex=data.get("sex"),
        birth_year=int(dob_s[:4]) if dob_s else None,
        state=data.get("state"),
        source=source,
        fhir_bundle_enc=encrypt_json(fhir_bundle) if fhir_bundle else None,
    )
    db.add(patient)
    await db.flush()
    return patient


def patient_identifiers(patient: Patient) -> dict[str, str]:
    """Known identifiers for de-identification (never logged)."""
    demo = decrypt_json(patient.demographics_enc) or {}
    known = {
        "name": demo.get("fullName"),
        "dob": demo.get("dob"),
        "mrn": demo.get("mrn"),
        "member_id": demo.get("memberId"),
        "phone": demo.get("phone"),
        "address": demo.get("address"),
    }
    return {k: str(v) for k, v in known.items() if v}


async def get_patient(db: AsyncSession, org_id: uuid.UUID, patient_id: uuid.UUID) -> Patient:
    p = await db.get(Patient, patient_id)
    if not p or p.org_id != org_id:
        raise not_found("Patient")
    return p


def patient_mini(p: Patient) -> dict:
    return {"id": p.id, "display_name": p.masked_name, "birth_year": p.birth_year, "sex": p.sex}


def patient_out(p: Patient, reveal: bool = False) -> dict:
    out = {
        **patient_mini(p),
        "external_ref": p.external_ref,
        "state": p.state,
        "source": p.source,
        "created_at": p.created_at,
    }
    if reveal:
        out["demographics"] = decrypt_json(p.demographics_enc)
    return out


# ── Cases ────────────────────────────────────────────────────────────────────
async def get_case(db: AsyncSession, org_id: uuid.UUID, case_id: uuid.UUID) -> Case:
    case = await db.get(Case, case_id)
    if not case or case.org_id != org_id:  # 404 (not 403) so ids from other tenants leak nothing
        raise not_found("Case")
    return case


async def next_case_number(db: AsyncSession, org_id: uuid.UUID, year: int | None = None) -> str:
    year = year or utcnow().year
    prefix = f"NC-{year}-"
    last = (
        await db.execute(
            select(Case.number)
            .where(Case.org_id == org_id, Case.number.like(f"{prefix}%"))
            .order_by(Case.number.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    seq = int(last.rsplit("-", 1)[1]) + 1 if last else 1
    return f"{prefix}{seq:05d}"


def sla_due_at(org: Organization, priority: str, start: datetime | None = None) -> datetime:
    settings = {**DEFAULT_ORG_SETTINGS, **(org.settings or {})}
    hours = settings["slaHoursExpedited"] if priority == "expedited" else settings["slaHoursStandard"]
    return (start or utcnow()) + timedelta(hours=int(hours))


async def _ensure_member(db: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID) -> None:
    ok = (
        await db.execute(
            select(Membership.id).where(
                Membership.org_id == org_id, Membership.user_id == user_id, Membership.status == "active"
            )
        )
    ).first()
    if not ok:
        raise bad_request("invalid_assignee", "Assignee must be an active member of this organization.")


def default_title(service_codes: list[str], dx_codes: list[str]) -> str:
    if service_codes:
        dx = f" · {', '.join(dx_codes[:2])}" if dx_codes else ""
        return f"Prior authorization {', '.join(service_codes[:3])}{dx}"
    return "New prior authorization"


async def add_event(
    db: AsyncSession, case: Case, type: str, payload: dict | None = None, actor_id: uuid.UUID | None = None
) -> CaseEvent:
    ev = CaseEvent(org_id=case.org_id, case_id=case.id, actor_id=actor_id, type=type, payload=payload or {})
    db.add(ev)
    await db.flush()
    return ev


async def create_case(db: AsyncSession, org: Organization, actor: User, data: dict) -> Case:
    if data.get("patient_id"):
        patient = await get_patient(db, org.id, data["patient_id"])
    elif data.get("patient"):
        patient = await create_patient(db, org.id, data["patient"])
    else:
        raise bad_request("patient_required", "Provide either patientId or patient details.")
    if data.get("assignee_id"):
        await _ensure_member(db, org.id, data["assignee_id"])
    priority = data.get("priority", "standard")
    now = utcnow()
    for attempt in range(3):
        number = await next_case_number(db, org.id)
        exists = (
            await db.execute(select(Case.id).where(Case.org_id == org.id, Case.number == number))
        ).first()
        if not exists:
            break
        if attempt == 2:
            raise conflict("case_number_conflict", "Could not allocate a case number; retry.")
    case = Case(
        org_id=org.id,
        number=number,
        patient_id=patient.id,
        title=(data.get("title") or default_title(data.get("service_codes", []), data.get("dx_codes", []))),
        status="draft",
        priority=priority,
        payer_type=data.get("payer_type", "medicare_ffs"),
        payer_name=data.get("payer_name"),
        state=data.get("state") or patient.state,
        service_codes=data.get("service_codes", []),
        dx_codes=data.get("dx_codes", []),
        date_of_service=data.get("date_of_service"),
        place_of_service=data.get("place_of_service"),
        assignee_id=data.get("assignee_id") or actor.id,
        due_at=sla_due_at(org, priority, now),
        tags=data.get("tags", []),
        created_by=actor.id,
    )
    db.add(case)
    await db.flush()
    await add_event(db, case, "created", {"number": number, "priority": priority}, actor.id)
    return case


def allowed_transitions(status: str) -> list[str]:
    return sorted(TRANSITIONS.get(status, set()))


async def set_status(
    db: AsyncSession,
    case: Case,
    new_status: str,
    *,
    actor_id: uuid.UUID | None,
    reason: str | None = None,
    force: bool = False,
) -> None:
    if new_status == case.status:
        return
    if not force and new_status not in TRANSITIONS.get(case.status, set()):
        raise conflict(
            "invalid_transition",
            f"Cannot move a case from '{case.status}' to '{new_status}'. "
            f"Allowed: {', '.join(allowed_transitions(case.status)) or 'none'}.",
        )
    old = case.status
    case.status = new_status
    if new_status == "submitted" and not case.submitted_at:
        case.submitted_at = utcnow()
    await add_event(db, case, "status_changed", {"from": old, "to": new_status, "reason": reason}, actor_id)


async def update_case(
    db: AsyncSession, org: Organization, case: Case, patch: dict, actor_id: uuid.UUID
) -> list[str]:
    changed: list[str] = []
    status = patch.pop("status", None)
    reason = patch.pop("status_reason", None)
    if "assignee_id" in patch and patch["assignee_id"] != case.assignee_id:
        if patch["assignee_id"] is not None:
            await _ensure_member(db, org.id, patch["assignee_id"])
        await add_event(
            db,
            case,
            "assigned",
            {
                "from": str(case.assignee_id) if case.assignee_id else None,
                "to": str(patch["assignee_id"]) if patch["assignee_id"] else None,
            },
            actor_id,
        )
    if "priority" in patch and patch["priority"] and patch["priority"] != case.priority:
        case.due_at = sla_due_at(org, patch["priority"], case.created_at)
    for field, value in patch.items():
        if getattr(case, field) != value:
            setattr(case, field, value)
            changed.append(field)
    if changed:
        await add_event(db, case, "updated", {"fields": [f for f in changed if f != "assignee_id"]}, actor_id)
    if status:
        await set_status(db, case, status, actor_id=actor_id, reason=reason)
        changed.append("status")
    case.updated_at = utcnow()
    return changed


async def record_outcome(
    db: AsyncSession, case: Case, outcome: str, note: str | None, actor_id: uuid.UUID
) -> None:
    if case.status not in OUTCOME_FROM:
        raise conflict(
            "invalid_outcome",
            f"Outcomes can only be recorded for submitted/pending/appealing cases (current: {case.status}).",
        )
    await set_status(
        db,
        case,
        OUTCOME_TO_STATUS[outcome],
        actor_id=actor_id,
        reason=f"payer outcome: {outcome}",
        force=outcome == "withdrawn",
    )
    case.outcome, case.outcome_at = outcome, utcnow()
    await add_event(db, case, "outcome_recorded", {"outcome": outcome, "note": note}, actor_id)


# ── Queries ──────────────────────────────────────────────────────────────────
def _encode_cursor(value: Any, row_id: uuid.UUID) -> str:
    raw = json.dumps({"v": value.isoformat() if isinstance(value, datetime) else value, "id": str(row_id)})
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[Any, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
        data = json.loads(raw)
        return data["v"], uuid.UUID(data["id"])
    except Exception as exc:
        raise bad_request("invalid_cursor", "Malformed pagination cursor.") from exc


def _sort_column(sort: str) -> tuple[Any, bool, str]:
    desc = sort.startswith("-")
    key = sort.lstrip("-")
    col = {
        "dueAt": func.coalesce(Case.due_at, _FAR_FUTURE),
        "updatedAt": Case.updated_at,
        "createdAt": Case.created_at,
        "number": Case.number,
    }[key]
    return col, desc, key


def _filters(org_id: uuid.UUID, user_id: uuid.UUID, f: dict) -> list:
    conds: list = [Case.org_id == org_id]
    if f.get("status"):
        statuses = [s.strip() for s in f["status"].split(",") if s.strip()]
        if "open" in statuses:
            statuses = [s for s in statuses if s != "open"] + list(OPEN_STATUSES)
        conds.append(Case.status.in_(statuses))
    elif not f.get("include_closed"):
        conds.append(Case.status != "closed")
    if f.get("priority"):
        conds.append(Case.priority == f["priority"])
    if f.get("readiness"):
        conds.append(Case.readiness.in_(f["readiness"].split(",")))
    if f.get("payer_type"):
        conds.append(Case.payer_type == f["payer_type"])
    assignee = f.get("assignee")
    if assignee == "me":
        conds.append(Case.assignee_id == user_id)
    elif assignee == "unassigned":
        conds.append(Case.assignee_id.is_(None))
    elif assignee:
        try:
            conds.append(Case.assignee_id == uuid.UUID(assignee))
        except ValueError as exc:
            raise bad_request(
                "invalid_assignee", "assignee must be 'me', 'unassigned' or a user id."
            ) from exc
    if f.get("due_before"):
        conds.append(Case.due_at <= f["due_before"])
    if f.get("tag"):
        conds.append(cast(Case.tags, String).like(f'%"{f["tag"]}"%'))
    if f.get("q"):
        like = f"%{f['q'].strip().lower()}%"
        conds.append(
            or_(
                func.lower(Case.number).like(like),
                func.lower(Case.title).like(like),
                func.lower(func.coalesce(Case.payer_name, "")).like(like),
                func.lower(cast(Case.service_codes, String)).like(like),
                func.lower(cast(Case.dx_codes, String)).like(like),
            )
        )
    return conds


async def list_cases(
    db: AsyncSession,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    filters: dict,
    *,
    sort: str = "-updatedAt",
    limit: int = 25,
    cursor: str | None = None,
) -> tuple[list[Case], str | None, int]:
    if sort not in SORTS:
        raise bad_request("invalid_sort", f"sort must be one of: {', '.join(sorted(SORTS))}")
    conds = _filters(org_id, user_id, filters)
    total = (await db.execute(select(func.count()).select_from(Case).where(*conds))).scalar_one()
    col, desc, key = _sort_column(sort)
    q = select(Case).where(*conds)
    if cursor:
        value, last_id = _decode_cursor(cursor)
        if key in ("dueAt", "updatedAt", "createdAt"):
            value = datetime.fromisoformat(value)
        cmp = (
            tuple_(col, Case.id) < tuple_(value, last_id)
            if desc
            else tuple_(col, Case.id) > tuple_(value, last_id)
        )
        q = q.where(cmp)
    q = q.order_by(col.desc() if desc else col.asc(), Case.id.desc() if desc else Case.id.asc()).limit(
        limit + 1
    )
    rows = list((await db.execute(q)).scalars().all())
    next_cursor = None
    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        last_val = {
            "dueAt": last.due_at or _FAR_FUTURE,
            "updatedAt": last.updated_at,
            "createdAt": last.created_at,
            "number": last.number,
        }[key]
        next_cursor = _encode_cursor(last_val, last.id)
    return rows, next_cursor, total


async def case_summaries(db: AsyncSession, cases: list[Case]) -> list[dict]:
    if not cases:
        return []
    pids = {c.patient_id for c in cases}
    uids = {c.assignee_id for c in cases if c.assignee_id}
    patients = {p.id: p for p in (await db.execute(select(Patient).where(Patient.id.in_(pids)))).scalars()}
    users = (
        {u.id: u for u in (await db.execute(select(User).where(User.id.in_(uids)))).scalars()} if uids else {}
    )
    return [
        _summary(c, patients[c.patient_id], users.get(c.assignee_id) if c.assignee_id else None)
        for c in cases
    ]


def user_mini(u: User | None) -> dict | None:
    return {"id": u.id, "full_name": u.full_name, "avatar_color": u.avatar_color} if u else None


def _summary(c: Case, p: Patient, assignee: User | None) -> dict:
    return {
        "id": c.id,
        "number": c.number,
        "title": c.title,
        "status": c.status,
        "priority": c.priority,
        "payer_type": c.payer_type,
        "payer_name": c.payer_name,
        "state": c.state,
        "service_codes": c.service_codes or [],
        "dx_codes": c.dx_codes or [],
        "date_of_service": c.date_of_service,
        "readiness": c.readiness,
        "readiness_score": c.readiness_score,
        "due_at": c.due_at,
        "assignee": user_mini(assignee),
        "patient": patient_mini(p),
        "updated_at": c.updated_at,
    }


async def case_detail(db: AsyncSession, c: Case) -> dict:
    (summary,) = await case_summaries(db, [c])
    docs = (
        await db.execute(select(func.count()).select_from(CaseDocument).where(CaseDocument.case_id == c.id))
    ).scalar_one()
    return {
        **summary,
        "place_of_service": c.place_of_service,
        "policy_refs": c.policy_refs or [],
        "latest_evaluation_id": c.latest_evaluation_id,
        "outcome": c.outcome,
        "outcome_at": c.outcome_at,
        "submitted_at": c.submitted_at,
        "tags": c.tags or [],
        "documents_count": docs,
        "created_by": c.created_by,
        "created_at": c.created_at,
        "allowed_transitions": allowed_transitions(c.status),
    }


async def case_stats(db: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID) -> dict:
    rows = (
        await db.execute(
            select(Case.status, Case.readiness, Case.priority, Case.due_at, Case.assignee_id).where(
                Case.org_id == org_id
            )
        )
    ).all()
    now = utcnow()
    by_status: dict[str, int] = {}
    by_readiness: dict[str, int] = {}
    by_priority: dict[str, int] = {}
    overdue = due_soon = mine = 0
    for status, readiness, priority, due_at, assignee in rows:
        by_status[status] = by_status.get(status, 0) + 1
        if status in OPEN_STATUSES:
            by_readiness[readiness] = by_readiness.get(readiness, 0) + 1
            by_priority[priority] = by_priority.get(priority, 0) + 1
            if due_at and due_at < now:
                overdue += 1
            elif due_at and due_at < now + timedelta(hours=48):
                due_soon += 1
            if assignee == user_id:
                mine += 1
    return {
        "total": len(rows),
        "by_status": by_status,
        "by_readiness": by_readiness,
        "by_priority": by_priority,
        "overdue": overdue,
        "due_soon": due_soon,
        "mine": mine,
    }


async def timeline(db: AsyncSession, case: Case, limit: int = 200) -> list[dict]:
    events = (
        (
            await db.execute(
                select(CaseEvent)
                .where(CaseEvent.case_id == case.id)
                .order_by(CaseEvent.created_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    uids = {e.actor_id for e in events if e.actor_id}
    users = (
        {u.id: u for u in (await db.execute(select(User).where(User.id.in_(uids)))).scalars()} if uids else {}
    )
    return [
        {
            "id": e.id,
            "type": e.type,
            "payload": e.payload,
            "actor": user_mini(users.get(e.actor_id)),
            "created_at": e.created_at,
        }
        for e in events
    ]
