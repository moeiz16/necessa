"""Serialization helpers shared by the case agent, review flow, routers and demo seed."""

from __future__ import annotations

from typing import Any


def _iso(v: Any) -> Any:
    return v.isoformat() if hasattr(v, "isoformat") else v


def effective_verdict(row: Any) -> str:
    ov = _get(row, "override_verdict")
    return ov or _get(row, "verdict")


def _get(row: Any, key: str) -> Any:
    if isinstance(row, dict):
        return row.get(key)
    return getattr(row, key, None)


def criterion_result_api(row: Any, overrider: dict | None = None) -> dict:
    """CriterionResult (DB row or snake_case dict) → API shape (contract §4.3)."""
    override = None
    if _get(row, "override_verdict"):
        override = {
            "verdict": _get(row, "override_verdict"),
            "reason": _get(row, "override_reason"),
            "by": overrider
            or ({"id": str(_get(row, "overridden_by"))} if _get(row, "overridden_by") else None),
            "at": _iso(_get(row, "overridden_at")),
        }
    rid = _get(row, "id")
    return {
        "id": str(rid) if rid else None,
        "criterionId": _get(row, "criterion_id"),
        "text": _get(row, "criterion_text"),
        "kind": _get(row, "kind"),
        "treePath": _get(row, "tree_path"),
        "verdict": _get(row, "verdict"),
        "effectiveVerdict": effective_verdict(row),
        "confidence": _get(row, "confidence"),
        "rationale": _get(row, "rationale"),
        "evidence": _get(row, "evidence") or [],
        "policyCitation": _get(row, "policy_citation"),
        "verification": _get(row, "verification") or {},
        "override": override,
    }


def evaluation_api(ev: Any, results: list[dict], policies: list[dict] | None = None) -> dict:
    return {
        "id": str(_get(ev, "id")),
        "caseId": str(_get(ev, "case_id")),
        "status": _get(ev, "status"),
        "readiness": _get(ev, "readiness"),
        "readinessScore": _get(ev, "readiness_score"),
        "degraded": bool(_get(ev, "degraded")),
        "policies": policies if policies is not None else (_get(ev, "model_info") or {}).get("policies", []),
        "tree": _get(ev, "tree_result"),
        "criteria": results,
        "gaps": _get(ev, "gaps") or [],
        "tokenUsage": _get(ev, "token_usage") or {},
        "modelInfo": _get(ev, "model_info") or {},
        "error": _get(ev, "error"),
        "startedAt": _iso(_get(ev, "started_at")),
        "finishedAt": _iso(_get(ev, "finished_at")),
    }


def evaluation_summary_api(ev: Any) -> dict:
    gaps = _get(ev, "gaps") or []
    return {
        "id": str(_get(ev, "id")),
        "caseId": str(_get(ev, "case_id")),
        "status": _get(ev, "status"),
        "readiness": _get(ev, "readiness"),
        "readinessScore": _get(ev, "readiness_score"),
        "degraded": bool(_get(ev, "degraded")),
        "gapsCount": len(gaps),
        "blockers": sum(1 for g in gaps if g.get("severity") == "blocker"),
        "startedAt": _iso(_get(ev, "started_at")),
        "finishedAt": _iso(_get(ev, "finished_at")),
    }
