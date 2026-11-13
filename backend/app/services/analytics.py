"""Operational analytics (no LLM): KPIs, trends, gap/denial breakdowns, team workload, activity feed.

Aggregations use portable SQL + small Python group-bys so they run identically on Postgres and SQLite.

`estimatedHoursSaved` methodology: the AMA 2025 Prior Authorization Physician Survey reports ~40 PAs and
~13 staff/physician hours per physician per week, i.e. ≈ 19.5 minutes per PA. We conservatively credit
**15 minutes per completed evaluation** (criteria lookup + chart review) and **20 minutes per drafted letter**
(LMN / appeal). The heuristic is surfaced to the UI so it is never presented as a measured number.
"""

from __future__ import annotations

import uuid
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import utcnow
from app.db.models.cases import (
    OPEN_STATUSES,
    Case,
    CaseEvaluation,
    CaseEvent,
    CriterionResult,
    Denial,
    Letter,
)
from app.db.models.platform import Membership, User
from app.services.cases import user_mini

MINUTES_PER_EVALUATION = 15
MINUTES_PER_LETTER = 20
METHODOLOGY = {
    "estimatedHoursSaved": (
        f"{MINUTES_PER_EVALUATION} min per completed evaluation + "
        f"{MINUTES_PER_LETTER} min per drafted letter; "
        "derived conservatively from the AMA 2025 PA survey (~13 h / ~40 PAs per physician-week)."
    ),
    "gapsCaughtPreSubmission": (
        "Criteria judged NOT_MET or INSUFFICIENT (after reviewer overrides) in the range."
    ),
    "readyRate": "Share of evaluated cases whose latest readiness is 'ready'.",
}


def _effective(verdict: str, override: str | None) -> str:
    return override or verdict


async def overview(db: AsyncSession, org_id: uuid.UUID, range_days: int = 30) -> dict:
    now = utcnow()
    since = now - timedelta(days=range_days)
    cases = (
        await db.execute(
            select(
                Case.status,
                Case.readiness,
                Case.readiness_score,
                Case.due_at,
                Case.created_at,
                Case.submitted_at,
                Case.payer_type,
                Case.outcome,
                Case.outcome_at,
            ).where(Case.org_id == org_id)
        )
    ).all()
    open_cases = [c for c in cases if c.status in OPEN_STATUSES]
    in_range = [c for c in cases if c.created_at >= since]
    evaluated = [c for c in in_range if c.readiness != "unknown"]
    scores = [c.readiness_score for c in evaluated if c.readiness_score is not None]
    turnaround = [
        (c.submitted_at - c.created_at).total_seconds() / 3600
        for c in in_range
        if c.submitted_at and c.submitted_at >= c.created_at
    ]
    denied = sum(
        1
        for c in cases
        if (c.status == "denied" or c.outcome == "denied") and (c.outcome_at or c.created_at) >= since
    )

    crit_rows = (
        await db.execute(
            select(
                CriterionResult.criterion_text, CriterionResult.verdict, CriterionResult.override_verdict
            ).where(CriterionResult.org_id == org_id, CriterionResult.created_at >= since)
        )
    ).all()
    gap_rows = [r for r in crit_rows if _effective(r.verdict, r.override_verdict) != "MET"]
    top_gaps = Counter(r.criterion_text.strip()[:160] for r in gap_rows).most_common(8)

    evals = (
        await db.execute(
            select(CaseEvaluation.readiness, CaseEvaluation.finished_at, CaseEvaluation.status).where(
                CaseEvaluation.org_id == org_id, CaseEvaluation.started_at >= since
            )
        )
    ).all()
    completed_evals = [e for e in evals if e.status in ("completed", "awaiting_review") and e.finished_at]
    letters = (
        await db.execute(
            select(func.count())
            .select_from(Letter)
            .where(Letter.org_id == org_id, Letter.created_at >= since)
        )
    ).scalar_one()
    denial_rows = (
        await db.execute(
            select(Denial.category, Denial.status).where(Denial.org_id == org_id, Denial.created_at >= since)
        )
    ).all()

    by_day: dict[str, int] = defaultdict(int)
    for c in in_range:
        by_day[c.created_at.date().isoformat()] += 1
    cases_by_day = [
        {
            "date": (since + timedelta(days=i)).date().isoformat(),
            "count": by_day.get((since + timedelta(days=i)).date().isoformat(), 0),
        }
        for i in range(range_days + 1)
    ]
    weekly: dict[str, Counter] = defaultdict(Counter)
    for e in completed_evals:
        iso = e.finished_at.isocalendar()
        weekly[f"{iso.year}-W{iso.week:02d}"][e.readiness] += 1
    readiness_by_week = [
        {
            "week": wk,
            "ready": c.get("ready", 0),
            "gaps": c.get("gaps", 0),
            "notSupported": c.get("not_supported", 0),
        }
        for wk, c in sorted(weekly.items())
    ]
    hours_saved = (len(completed_evals) * MINUTES_PER_EVALUATION + letters * MINUTES_PER_LETTER) / 60
    return {
        "range_days": range_days,
        "kpis": {
            "open_cases": len(open_cases),
            "due_soon": sum(
                1 for c in open_cases if c.due_at and now <= c.due_at < now + timedelta(hours=48)
            ),
            "ready_rate": round(sum(1 for c in evaluated if c.readiness == "ready") / len(evaluated), 4)
            if evaluated
            else 0.0,
            "avg_readiness_score": round(sum(scores) / len(scores), 4) if scores else None,
            "gaps_caught_pre_submission": len(gap_rows),
            "denied_cases": denied,
            "appeals_overturned": sum(1 for d in denial_rows if d.status == "overturned"),
            "avg_turnaround_hours": round(sum(turnaround) / len(turnaround), 1) if turnaround else None,
            "estimated_hours_saved": round(hours_saved, 1),
        },
        "trends": {"casesByDay": cases_by_day, "readinessByWeek": readiness_by_week},
        "top_gap_criteria": [{"criterionText": t, "count": n} for t, n in top_gaps],
        "denial_reasons": [
            {"category": k, "count": v} for k, v in Counter(d.category for d in denial_rows).most_common()
        ],
        "payer_mix": [
            {"payerType": k, "count": v} for k, v in Counter(c.payer_type for c in in_range).most_common()
        ],
        "methodology": METHODOLOGY,
    }


async def team(db: AsyncSession, org_id: uuid.UUID) -> list[dict]:
    now = utcnow()
    members = (
        await db.execute(
            select(User, Membership.role)
            .join(Membership, Membership.user_id == User.id)
            .where(Membership.org_id == org_id, Membership.status == "active")
            .order_by(User.full_name)
        )
    ).all()
    rows = (
        await db.execute(
            select(Case.assignee_id, Case.status, Case.due_at, Case.updated_at).where(
                Case.org_id == org_id, Case.assignee_id.is_not(None)
            )
        )
    ).all()
    stats: dict[uuid.UUID, Counter] = defaultdict(Counter)
    for assignee, status, due_at, updated_at in rows:
        s = stats[assignee]
        if status in OPEN_STATUSES:
            s["open"] += 1
            if due_at and due_at < now:
                s["overdue"] += 1
            elif due_at and due_at < now + timedelta(hours=48):
                s["due_soon"] += 1
        elif updated_at >= now - timedelta(days=30) and status in (
            "approved",
            "denied",
            "closed",
            "submitted",
            "pending_payer",
        ):
            s["done"] += 1
    return [
        {
            "user": user_mini(u),
            "role": role,
            "open_cases": stats[u.id]["open"],
            "due_soon": stats[u.id]["due_soon"],
            "overdue": stats[u.id]["overdue"],
            "completed_30d": stats[u.id]["done"],
        }
        for u, role in members
    ]


_EVENT_TEXT = {
    "created": "created case",
    "status_changed": "moved case",
    "document_added": "added a document to",
    "evaluation_started": "started an evaluation of",
    "evaluation_completed": "completed the evaluation of",
    "verdict_overridden": "overrode a criterion on",
    "letter_drafted": "drafted a letter for",
    "letter_approved": "approved a letter for",
    "denial_recorded": "recorded a denial on",
    "comment": "commented on",
    "assigned": "reassigned",
    "updated": "updated",
    "outcome_recorded": "recorded the payer outcome for",
}


def _event_message(ev: CaseEvent, number: str) -> str:
    verb = _EVENT_TEXT.get(ev.type, ev.type.replace("_", " "))
    if ev.type == "status_changed":
        return f"{verb} {number} to {ev.payload.get('to', '?').replace('_', ' ')}"
    if ev.type == "outcome_recorded":
        return f"{verb} {number}: {ev.payload.get('outcome')}"
    return f"{verb} {number}"


async def activity(
    db: AsyncSession, org_id: uuid.UUID, limit: int = 50, before: datetime | None = None
) -> list[dict]:
    q = (
        select(CaseEvent, Case.number)
        .join(Case, Case.id == CaseEvent.case_id)
        .where(CaseEvent.org_id == org_id)
    )
    if before:
        q = q.where(CaseEvent.created_at < before)
    rows = (await db.execute(q.order_by(CaseEvent.created_at.desc()).limit(limit))).all()
    uids = {ev.actor_id for ev, _ in rows if ev.actor_id}
    users = (
        {u.id: u for u in (await db.execute(select(User).where(User.id.in_(uids)))).scalars()} if uids else {}
    )
    return [
        {
            "id": str(ev.id),
            "type": ev.type,
            "message": _event_message(ev, number),
            "actor": user_mini(users.get(ev.actor_id)) if ev.actor_id else None,
            "case_id": ev.case_id,
            "case_number": number,
            "created_at": ev.created_at,
        }
        for ev, number in rows
    ]
