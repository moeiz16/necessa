"""Human-in-the-loop review + assistive next-best-actions.

Overrides never mutate the model's verdict: they are stored alongside it (who/why/when), the tree is
recomputed from *effective* verdicts with the same Kleene logic, and both are audited. Reviewer
overrides are also the raw material for the eval set (see eval/generators/overrides_to_gold.py).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.agents.case_results import criterion_result_api, effective_verdict, evaluation_api
from app.ai.compiler.logic import gaps_for, summarize
from app.ai.compiler.schema import CriteriaTree, Verdict
from app.db.base import utcnow
from app.db.models.cases import Case, CaseDocument, CaseEvaluation, CriterionResult
from app.db.models.criteria import CriteriaSet


async def trees_for(db: AsyncSession, ev: CaseEvaluation) -> list[CriteriaTree]:
    ids = [uuid.UUID(str(i)) for i in (ev.criteria_set_ids or [])]
    if not ids:
        return []
    rows = (await db.execute(select(CriteriaSet).where(CriteriaSet.id.in_(ids)))).scalars().all()
    by_id = {str(r.id): r for r in rows}
    return [CriteriaTree.model_validate(by_id[str(i)].tree) for i in ids if str(i) in by_id]


async def results_for(db: AsyncSession, ev: CaseEvaluation) -> list[CriterionResult]:
    return list(
        (
            await db.execute(
                select(CriterionResult)
                .where(CriterionResult.evaluation_id == ev.id)
                .order_by(CriterionResult.tree_path)
            )
        )
        .scalars()
        .all()
    )


async def recompute(db: AsyncSession, ev: CaseEvaluation, case: Case) -> None:
    trees = await trees_for(db, ev)
    rows = await results_for(db, ev)
    if not trees:
        return
    verdicts = {r.criterion_id: Verdict(effective_verdict(r)) for r in rows}
    root, readiness, score = summarize(trees, verdicts)
    ev.tree_result = root.model_dump(by_alias=True, exclude_none=True)
    ev.readiness, ev.readiness_score = readiness.value, score
    ev.gaps = [g.model_dump(by_alias=True) for g in gaps_for(trees, verdicts)]
    if case.latest_evaluation_id == ev.id:
        case.readiness, case.readiness_score = ev.readiness, ev.readiness_score


async def override_criterion(
    db: AsyncSession,
    *,
    case: Case,
    result: CriterionResult,
    verdict: str | None,
    reason: str | None,
    actor_id: uuid.UUID,
) -> CriterionResult:
    if verdict is not None and verdict not in {v.value for v in Verdict}:
        raise ValueError("invalid verdict")
    if verdict is not None and not (reason or "").strip():
        raise ValueError("an override reason is required")
    previous = effective_verdict(result)
    result.override_verdict = verdict
    result.override_reason = (reason or "").strip() or None if verdict else None
    result.overridden_by = actor_id if verdict else None
    result.overridden_at = utcnow() if verdict else None
    ev = await db.get(CaseEvaluation, result.evaluation_id)
    if ev is not None:
        await recompute(db, ev, case)
    from app.services.cases import add_event

    await add_event(
        db,
        case,
        "verdict_overridden",
        {
            "criterionId": result.criterion_id,
            "from": previous,
            "to": effective_verdict(result),
            "reason": result.override_reason,
        },
        actor_id,
    )
    await db.flush()
    return result


async def complete_review(
    db: AsyncSession, *, case: Case, ev: CaseEvaluation, actor_id: uuid.UUID
) -> CaseEvaluation:
    await recompute(db, ev, case)
    ev.status = "completed"
    ev.finished_at = ev.finished_at or utcnow()
    from app.services.cases import add_event, set_status

    target = "ready" if ev.readiness == "ready" else "needs_review"
    await set_status(db, case, target, actor_id=actor_id, reason="review completed", force=True)
    await add_event(
        db, case, "review_completed", {"evaluationId": str(ev.id), "readiness": ev.readiness}, actor_id
    )
    await db.flush()
    return ev


async def evaluation_payload(db: AsyncSession, ev: CaseEvaluation) -> dict:
    rows = await results_for(db, ev)
    users = await _users(db, [r.overridden_by for r in rows if r.overridden_by])
    return evaluation_api(ev, [criterion_result_api(r, users.get(r.overridden_by)) for r in rows])


async def _users(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    if not ids:
        return {}
    from app.db.models.platform import User

    rows = (await db.execute(select(User).where(User.id.in_(set(ids))))).scalars().all()
    return {u.id: {"id": str(u.id), "fullName": u.full_name} for u in rows}


# ── assistive next-best-actions ────────────────────────────────────────────────────────────────


async def next_actions(db: AsyncSession, case: Case) -> list[dict]:
    """Deterministic, explainable suggestions (no LLM): what should the coordinator do next?"""
    actions: list[dict] = []
    now = datetime.now(UTC)
    docs = (await db.execute(select(CaseDocument).where(CaseDocument.case_id == case.id))).scalars().all()
    ev = await db.get(CaseEvaluation, case.latest_evaluation_id) if case.latest_evaluation_id else None

    if not docs:
        actions.append(
            _a(
                "upload_documents",
                "Add clinical documentation",
                "No chart documents are attached yet. Upload the most recent notes, imaging and therapy records.",  # noqa: E501
                "high",
            )
        )
    if any(d.quarantined for d in docs):
        actions.append(
            _a(
                "review_quarantine",
                "Review the document that was set aside",
                "A document looked unsafe and was set aside, so it is not part of the check. "
                "Please review it.",
                "high",
            )
        )
    if docs and ev is None:
        actions.append(
            _a(
                "run_evaluation",
                "Run documentation check",
                "Check the chart against the requirements of the applicable payer policy.",
                "high",
            )
        )
    if ev is not None:
        newer = [d for d in docs if d.created_at and ev.started_at and d.created_at > ev.started_at]
        if newer:
            actions.append(
                _a(
                    "rerun_evaluation",
                    "Check the case again",
                    f"{len(newer)} document(s) were added after the last check.",
                    "high",
                )
            )
        for g in (ev.gaps or [])[:5]:
            actions.append(
                _a(
                    "resolve_gap",
                    f"Fix: {g.get('title', '')[:90]}",
                    g.get("suggestedFix", ""),
                    "high" if g.get("severity") == "blocker" else "medium",
                    criterion_id=g.get("criterionId"),
                )
            )
        rows = await results_for(db, ev)
        low = [
            r
            for r in rows
            if r.override_verdict is None
            and (r.confidence or 0) < 0.6
            and r.verdict != Verdict.INSUFFICIENT.value
        ]
        for r in low[:3]:
            actions.append(
                _a(
                    "review_low_confidence",
                    f"Double-check: {r.criterion_text[:80]}",
                    f"Necessa is only {r.confidence:.0%} sure. Please confirm or change this result.",
                    "medium",
                    criterion_id=r.criterion_id,
                )
            )
        flagged = [r for r in rows if "hallucinated_quote" in (r.verification or {}).get("flags", [])]
        if flagged:
            actions.append(
                _a(
                    "verify_citations",
                    "Some quotes could not be confirmed",
                    f"{len(flagged)} result(s) were marked as needing documentation because the quoted text "
                    "could not be found in the chart.",
                    "low",
                )
            )
        if ev.status == "awaiting_review":
            actions.append(
                _a(
                    "complete_review",
                    "Complete clinical review",
                    "Confirm the results so the case can move to ready.",
                    "medium",
                )
            )
        if ev.readiness == "ready" and case.status in {"ready", "needs_review"}:
            actions.append(
                _a(
                    "draft_letter",
                    "Draft the letter of medical necessity",
                    "Every requirement is documented. Prepare the letter of medical necessity for signature.",
                    "medium",
                )
            )
    if case.due_at:
        due = case.due_at if case.due_at.tzinfo else case.due_at.replace(tzinfo=UTC)
        if due - now < timedelta(hours=24) and case.status not in {
            "submitted",
            "pending_payer",
            "approved",
            "closed",
        }:
            actions.insert(
                0,
                _a(
                    "sla_risk",
                    "SLA at risk",
                    f"Due {due.strftime('%b %d %H:%M UTC')} — prioritize this case.",
                    "high",
                ),
            )
    if case.status == "denied":
        actions.insert(
            0,
            _a(
                "start_appeal",
                "Start an appeal",
                "Record the denial letter to map the reason to policy criteria and draft the appeal.",
                "high",
            ),
        )
    order = {"high": 0, "medium": 1, "low": 2}
    actions.sort(key=lambda a: order[a["priority"]])
    return actions


def _a(type_: str, title: str, detail: str, priority: str, criterion_id: str | None = None) -> dict:
    return {
        "type": type_,
        "title": title,
        "detail": detail,
        "priority": priority,
        "criterionId": criterion_id,
    }
