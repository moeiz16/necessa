# ruff: noqa: E501
"""Allowlisted SQL views for analytics / structured knowledge questions.

The text-to-SQL path may ONLY read these views — never base tables. Case-data views expose
aggregates-friendly, non-PHI columns (no patient names, no free-text chart content). Tenant views are
rewritten server-side to `(SELECT * FROM v WHERE org_id = :org_id)` by the validator, so isolation
never depends on the model remembering a WHERE clause.
"""

from __future__ import annotations

from dataclasses import dataclass

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class ViewDef:
    name: str
    sql: str
    tenant: bool
    description: str
    columns: dict[str, str]


VIEWS: dict[str, ViewDef] = {
    v.name: v
    for v in [
        ViewDef(
            "v_case_overview",
            "SELECT c.id AS case_id, c.org_id, c.number, c.status, c.priority, c.payer_type, c.payer_name, c.state, "
            "c.readiness, c.readiness_score, c.date_of_service, c.due_at, c.created_at, c.updated_at, "
            "c.submitted_at, c.outcome, c.outcome_at, c.assignee_id FROM cases c",
            True,
            "One row per prior-authorization case (no patient identifiers).",
            {
                "case_id": "uuid",
                "number": "human case number e.g. NC-2026-00042",
                "status": "draft|evaluating|needs_review|ready|submitted|pending_payer|approved|denied|appealing|closed",
                "priority": "standard|expedited",
                "payer_type": "medicare_ffs|medicare_advantage|commercial|medicaid",
                "payer_name": "text",
                "state": "2-letter state",
                "readiness": "unknown|ready|gaps|not_supported",
                "readiness_score": "0..1",
                "date_of_service": "date",
                "due_at": "timestamp (SLA deadline)",
                "created_at": "timestamp",
                "updated_at": "timestamp",
                "submitted_at": "timestamp",
                "outcome": "approved|denied|partial|withdrawn (payer outcome recorded by staff)",
                "outcome_at": "timestamp",
                "assignee_id": "uuid",
            },
        ),
        ViewDef(
            "v_criterion_outcomes",
            "SELECT r.org_id, r.case_id, r.evaluation_id, r.criterion_id, r.criterion_text, r.kind, "
            "COALESCE(r.override_verdict, r.verdict) AS verdict, r.verdict AS ai_verdict, "
            "CASE WHEN r.override_verdict IS NULL THEN 0 ELSE 1 END AS overridden, r.confidence, r.created_at "
            "FROM criterion_results r",
            True,
            "One row per evaluated coverage criterion per case evaluation (effective verdict after overrides).",
            {
                "case_id": "uuid",
                "evaluation_id": "uuid",
                "criterion_id": "e.g. C1",
                "criterion_text": "text",
                "kind": "positive|negative_attestation|documentation|temporal|numeric",
                "verdict": "MET|NOT_MET|INSUFFICIENT (after human override)",
                "ai_verdict": "MET|NOT_MET|INSUFFICIENT",
                "overridden": "0|1",
                "confidence": "0..1",
                "created_at": "timestamp",
            },
        ),
        ViewDef(
            "v_evaluations",
            "SELECT e.org_id, e.case_id, e.id AS evaluation_id, e.status, e.readiness, e.readiness_score, "
            "e.degraded, e.started_at, e.finished_at FROM case_evaluations e",
            True,
            "One row per case evaluation run.",
            {
                "case_id": "uuid",
                "evaluation_id": "uuid",
                "status": "running|awaiting_review|completed|failed|cancelled",
                "readiness": "unknown|ready|gaps|not_supported",
                "readiness_score": "0..1",
                "degraded": "boolean",
                "started_at": "timestamp",
                "finished_at": "timestamp",
            },
        ),
        ViewDef(
            "v_denials",
            "SELECT d.org_id, d.case_id, d.received_at, d.category, d.status, d.appeal_deadline, d.created_at "
            "FROM denials d",
            True,
            "One row per recorded payer denial.",
            {
                "case_id": "uuid",
                "received_at": "date",
                "category": "medical_necessity|documentation|coding|eligibility|timely_filing|other",
                "status": "new|analyzing|appeal_drafted|appealed|overturned|upheld",
                "appeal_deadline": "date",
                "created_at": "timestamp",
            },
        ),
        ViewDef(
            "v_letters",
            "SELECT l.org_id, l.case_id, l.kind, l.status, l.version, l.created_at, l.approved_at FROM letters l",
            True,
            "One row per drafted letter.",
            {
                "case_id": "uuid",
                "kind": "lmn|pa_cover|appeal|peer_to_peer_prep",
                "status": "draft|in_review|approved|exported",
                "version": "int",
                "created_at": "timestamp",
                "approved_at": "timestamp",
            },
        ),
        ViewDef(
            "v_policy_catalog",
            "SELECT p.source_key, p.title, p.doc_type, p.source, p.status, v.version, v.effective_from, "
            "v.effective_to FROM policies p JOIN policy_versions v ON v.id = p.current_version_id "
            "WHERE p.org_id IS NULL",
            False,
            "Public coverage policies (current version): NCDs, LCDs, Billing & Coding articles, payer policies.",
            {
                "source_key": "e.g. L33718, A52369, NCD-150.9",
                "title": "text",
                "doc_type": "NCD|LCD|Billing and Coding|Article|Payer Policy",
                "source": "ncd|lcd|article|payer",
                "status": "active|future|retired",
                "version": "int",
                "effective_from": "date",
                "effective_to": "date",
            },
        ),
        ViewDef(
            "v_policy_codes",
            "SELECT p.source_key, p.title, p.doc_type, c.code_system, c.code, c.group_no FROM policy_codes c "
            "JOIN policies p ON p.current_version_id = c.policy_version_id WHERE p.org_id IS NULL",
            False,
            "Codes listed by each current policy (HCPCS/CPT numbers, ICD-10 covered/non-covered).",
            {
                "source_key": "text",
                "title": "text",
                "doc_type": "text",
                "code_system": "HCPCS|ICD10_COVERED|ICD10_NONCOVERED|ICD10_PCS|BILL_TYPE|REVENUE",
                "code": "e.g. 29881, E0601, M17.11",
                "group_no": "int",
            },
        ),
        ViewDef(
            "v_policy_states",
            'SELECT DISTINCT p.source_key, p.title, p.doc_type, s.state_abbrev, s."primary" AS is_primary '
            "FROM policy_states s JOIN policies p ON p.current_version_id = s.policy_version_id "
            "WHERE p.org_id IS NULL",
            False,
            "States where each current policy applies ('US' = national).",
            {
                "source_key": "text",
                "title": "text",
                "doc_type": "text",
                "state_abbrev": "2-letter or US",
                "is_primary": "boolean",
            },
        ),
        ViewDef(
            "v_policy_contractors",
            "SELECT DISTINCT p.source_key, p.title, k.name AS contractor_name, k.number AS contractor_number, "
            "k.type_label FROM policy_contractors pc JOIN policies p ON p.current_version_id = pc.policy_version_id "
            "JOIN contractors k ON k.id = pc.contractor_id AND k.type_id = pc.contractor_type_id "
            "WHERE p.org_id IS NULL",
            False,
            "Medicare Administrative Contractors (MACs) that publish each current policy.",
            {
                "source_key": "text",
                "title": "text",
                "contractor_name": "text",
                "contractor_number": "text",
                "type_label": "e.g. A and B MAC, DME MAC",
            },
        ),
    ]
}

TENANT_VIEWS = frozenset(v.name for v in VIEWS.values() if v.tenant)
ALLOWED_VIEWS = frozenset(VIEWS)


def schema_doc(view: ViewDef) -> str:
    cols = "\n".join(f"  {c} -- {d}" for c, d in view.columns.items())
    return f"VIEW {view.name}  -- {view.description}\n{cols}"


async def ensure_views(session: AsyncSession) -> list[str]:
    """(Re)create allowlisted views. Skips views whose base tables don't exist yet."""
    dialect = session.get_bind().dialect.name
    created = []
    for v in VIEWS.values():
        try:
            async with session.begin_nested():
                if dialect == "postgresql":
                    await session.execute(text(f"CREATE OR REPLACE VIEW {v.name} AS {v.sql}"))
                else:
                    await session.execute(text(f"DROP VIEW IF EXISTS {v.name}"))
                    await session.execute(text(f"CREATE VIEW {v.name} AS {v.sql}"))
            created.append(v.name)
        except Exception as exc:
            log.debug("sql.view_skipped", view=v.name, error=str(exc)[:200])
    return created


# Verified NL → SQL pairs (PostgreSQL dialect) used as dynamic few-shot examples and as the gold set
# seed for the execution-accuracy eval. Every fixed bug adds an example here.
FEW_SHOT: list[tuple[str, str]] = [
    (
        "How many cases do we have in each status?",
        "SELECT status, COUNT(*) AS cases FROM v_case_overview GROUP BY status ORDER BY cases DESC",
    ),
    (
        "Top 5 criteria that were not met or lacked evidence",
        "SELECT criterion_text, COUNT(*) AS n FROM v_criterion_outcomes WHERE verdict IN ('NOT_MET','INSUFFICIENT') "
        "GROUP BY criterion_text ORDER BY n DESC LIMIT 5",
    ),
    (
        "What is our ready rate by payer type?",
        "SELECT payer_type, ROUND(AVG(CASE WHEN readiness = 'ready' THEN 1.0 ELSE 0.0 END), 3) AS ready_rate, "
        "COUNT(*) AS cases FROM v_case_overview GROUP BY payer_type ORDER BY cases DESC",
    ),
    (
        "Denials by category",
        "SELECT category, COUNT(*) AS denials FROM v_denials GROUP BY category ORDER BY denials DESC",
    ),
    (
        "How often do reviewers override the AI verdict?",
        "SELECT ROUND(AVG(overridden * 1.0), 3) AS override_rate, COUNT(*) AS criteria FROM v_criterion_outcomes",
    ),
    (
        "Cases created per week",
        "SELECT DATE_TRUNC('week', created_at) AS week, COUNT(*) AS cases FROM v_case_overview GROUP BY 1 ORDER BY 1",
    ),
    (
        "Which expedited cases are due in the next 3 days?",
        "SELECT number, status, readiness, due_at FROM v_case_overview WHERE priority = 'expedited' AND due_at <= "
        "CURRENT_TIMESTAMP + INTERVAL '3 days' AND status NOT IN ('closed','approved','denied') ORDER BY due_at",
    ),
    (
        "How many LCDs, NCDs and articles are indexed?",
        "SELECT doc_type, COUNT(*) AS policies FROM v_policy_catalog GROUP BY doc_type ORDER BY policies DESC",
    ),
    (
        "Which policies list code 29881?",
        "SELECT DISTINCT source_key, title, doc_type FROM v_policy_codes WHERE code = '29881' ORDER BY source_key",
    ),
    (
        "Which contractors publish the knee arthroscopy LCDs?",
        "SELECT DISTINCT contractor_name, source_key, title FROM v_policy_contractors WHERE LOWER(title) LIKE "
        "'%arthroscop%' ORDER BY contractor_name",
    ),
]
