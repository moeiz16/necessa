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

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import org_cache
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


OVERVIEW_CACHE_TTL_S = 30.0


async def overview(db: AsyncSession, org_id: uuid.UUID, range_days: int = 30) -> dict:
    """Dashboard KPIs. Cached per org for a few seconds; any committed write to the org invalidates."""
    return await org_cache.get_or_compute(
        "analytics.overview",
        org_id,
        range_days,
        OVERVIEW_CACHE_TTL_S,
        lambda: _overview(db, org_id, range_days),
    )


async def _overview(db: AsyncSession, org_id: uuid.UUID, range_days: int) -> dict:
    """Aggregates run in the database; only range-bounded rows come back (never the whole org)."""
    now = utcnow()
    since = now - timedelta(days=range_days)
    is_open = Case.status.in_(OPEN_STATUSES)
    totals = (
        await db.execute(
            select(
                func.coalesce(func.sum(case((is_open, 1), else_=0)), 0),
                func.coalesce(
                    func.sum(
                        case(
                            (is_open & (Case.due_at >= now) & (Case.due_at < now + timedelta(hours=48)), 1),
                            else_=0,
                        )
                    ),
                    0,
                ),
                func.coalesce(
                    func.sum(
                        case(
                            (
                                ((Case.status == "denied") | (Case.outcome == "denied"))
                                & (func.coalesce(Case.outcome_at, Case.created_at) >= since),
                                1,
                            ),
                            else_=0,
                        )
                    ),
                    0,
                ),
            ).where(Case.org_id == org_id)
        )
    ).one()
    open_cases, due_soon, denied = (int(x or 0) for x in totals)
    in_range = (
        await db.execute(
            select(
                Case.readiness, Case.readiness_score, Case.created_at, Case.submitted_at, Case.payer_type
            ).where(Case.org_id == org_id, Case.created_at >= since)
        )
    ).all()
    evaluated = [c for c in in_range if c.readiness != "unknown"]
    scores = [c.readiness_score for c in evaluated if c.readiness_score is not None]
    turnaround = [
        (c.submitted_at - c.created_at).total_seconds() / 3600
        for c in in_range
        if c.submitted_at and c.submitted_at >= c.created_at
    ]

    # Gap criteria grouped by text in SQL; `override or verdict` is the reviewer-effective verdict.
    effective = func.coalesce(func.nullif(CriterionResult.override_verdict, ""), CriterionResult.verdict)
    gap_groups = (
        await db.execute(
            select(CriterionResult.criterion_text, func.count())
            .where(
                CriterionResult.org_id == org_id,
                CriterionResult.created_at >= since,
                effective != "MET",
            )
            .group_by(CriterionResult.criterion_text)
        )
    ).all()
    gap_counter: Counter[str] = Counter()
    for text_, n in sorted(gap_groups, key=lambda r: r[0]):
        gap_counter[text_.strip()[:160]] += n
    gaps_total = sum(gap_counter.values())
    top_gaps = gap_counter.most_common(8)

    completed_evals = (
        await db.execute(
            select(CaseEvaluation.readiness, CaseEvaluation.finished_at).where(
                CaseEvaluation.org_id == org_id,
                CaseEvaluation.started_at >= since,
                CaseEvaluation.status.in_(("completed", "awaiting_review")),
                CaseEvaluation.finished_at.is_not(None),
            )
        )
    ).all()
    letters = (
        await db.execute(
            select(func.count())
            .select_from(Letter)
            .where(Letter.org_id == org_id, Letter.created_at >= since)
        )
    ).scalar_one()
    denial_groups = (
        await db.execute(
            select(Denial.category, Denial.status, func.count())
            .where(Denial.org_id == org_id, Denial.created_at >= since)
            .group_by(Denial.category, Denial.status)
        )
    ).all()
    denial_reasons: Counter[str] = Counter()
    overturned = 0
    for category, status, n in sorted(denial_groups, key=lambda r: (r[0] or "", r[1] or "")):
        denial_reasons[category] += n
        if status == "overturned":
            overturned += n

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
    payer_mix = Counter(c.payer_type for c in sorted(in_range, key=lambda r: r.payer_type))
    return {
        "range_days": range_days,
        "kpis": {
            "open_cases": open_cases,
            "due_soon": due_soon,
            "ready_rate": round(sum(1 for c in evaluated if c.readiness == "ready") / len(evaluated), 4)
            if evaluated
            else 0.0,
            "avg_readiness_score": round(sum(scores) / len(scores), 4) if scores else None,
            "gaps_caught_pre_submission": gaps_total,
            "denied_cases": denied,
            "appeals_overturned": overturned,
            "avg_turnaround_hours": round(sum(turnaround) / len(turnaround), 1) if turnaround else None,
            "estimated_hours_saved": round(hours_saved, 1),
        },
        "trends": {"casesByDay": cases_by_day, "readinessByWeek": readiness_by_week},
        "top_gap_criteria": [{"criterionText": t, "count": n} for t, n in top_gaps],
        "denial_reasons": [{"category": k, "count": v} for k, v in denial_reasons.most_common()],
        "payer_mix": [{"payerType": k, "count": v} for k, v in payer_mix.most_common()],
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
