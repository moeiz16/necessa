# ruff: noqa: S608 - template SQL only interpolates allowlisted identifiers and ints
"""Text-to-SQL over allowlisted views (strategy S3), safest path first:

1. **Templates** (parameterized, tested) for the most common analytics questions — no LLM.
2. **LLM generation** (`sql` group) with schema-aware retrieval of view docs (only relevant views go
   in the prompt) + dynamic few-shot (closest verified NL→SQL pairs), generated in the *execution*
   dialect, then validated (AST allowlist + tenant rewrite + LIMIT), executed read-only with a
   statement timeout, self-corrected up to 2x from the database error.
3. Result → columns/rows + chart hint + summary; the SQL is always returned for transparency.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import decimal
import re
import uuid
from dataclasses import dataclass, field
from typing import Any

import structlog
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.sql.validator import validate_sql
from app.ai.sql.views import ALLOWED_VIEWS, FEW_SHOT, TENANT_VIEWS, VIEWS, ensure_views, schema_doc
from app.ai.textutil import word_tokens
from app.core.config import get_settings

log = structlog.get_logger(__name__)
MAX_ROWS = 1000
RETURN_ROWS = 200
STATEMENT_TIMEOUT_S = 4.0


@dataclass
class SQLAnswer:
    question: str
    sql: str = ""
    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    summary: str = ""
    chart_hint: dict = field(default_factory=lambda: {"type": "table"})
    warnings: list[str] = field(default_factory=list)
    method: str = "none"  # template|llm|none
    attempts: int = 0
    views: list[str] = field(default_factory=list)
    row_count: int = 0

    def to_dict(self) -> dict:
        return {
            "question": self.question,
            "sql": self.sql,
            "columns": self.columns,
            "rows": self.rows,
            "summary": self.summary,
            "chartHint": self.chart_hint,
            "warnings": self.warnings,
            "method": self.method,
            "attempts": self.attempts,
            "views": self.views,
            "rowCount": self.row_count,
        }


# ── 1. templates ───────────────────────────────────────────────────────────
def _template(question: str, dialect: str) -> str | None:
    q = question.lower()
    m = re.search(r"\btop\s*(\d{1,2})\b", q)
    n = int(m.group(1)) if m else 10
    week = "strftime('%Y-%W', created_at)" if dialect == "sqlite" else "DATE_TRUNC('week', created_at)"
    if re.search(r"(gap|missing|not met|insufficient|unmet|failed)\b.*\bcriteri", q) or re.search(
        r"criteri\w*\b.*\b(gap|missing|not met|insufficient|unmet|failed)", q
    ):
        return (
            "SELECT criterion_text, COUNT(*) AS n FROM v_criterion_outcomes WHERE verdict IN "
            f"('NOT_MET','INSUFFICIENT') GROUP BY criterion_text ORDER BY n DESC LIMIT {n}"
        )
    if re.search(r"override", q):
        return (
            "SELECT ROUND(AVG(overridden * 1.0), 3) AS override_rate, SUM(overridden) AS overrides, "
            "COUNT(*) AS criteria FROM v_criterion_outcomes"
        )
    if re.search(r"denial", q) and re.search(r"(categor|reason|type|by)", q):
        return "SELECT category, COUNT(*) AS denials FROM v_denials GROUP BY category ORDER BY denials DESC"
    if re.search(r"ready rate|readiness rate|% ready|percent ready", q):
        by = (
            "payer_type"
            if "payer" in q
            else ("state" if "state" in q else "priority" if "priority" in q else None)
        )
        if by:
            return (
                f"SELECT {by}, ROUND(AVG(CASE WHEN readiness = 'ready' THEN 1.0 ELSE 0.0 END), 3) "
                "AS ready_rate, "
                f"COUNT(*) AS cases FROM v_case_overview GROUP BY {by} ORDER BY cases DESC"
            )
        return (
            "SELECT ROUND(AVG(CASE WHEN readiness = 'ready' THEN 1.0 ELSE 0.0 END), 3) AS ready_rate, "
            "COUNT(*) AS cases FROM v_case_overview"
        )
    if re.search(r"cases?\b.*\b(per|by|each) week|weekly", q):
        return f"SELECT {week} AS week, COUNT(*) AS cases FROM v_case_overview GROUP BY 1 ORDER BY 1"
    if re.search(r"(cases?|requests?)\b.*\b(by|per|each|in each) status|status breakdown|how many cases", q):
        return "SELECT status, COUNT(*) AS cases FROM v_case_overview GROUP BY status ORDER BY cases DESC"
    if re.search(r"average readiness|avg readiness|mean readiness", q):
        return (
            "SELECT payer_type, ROUND(AVG(readiness_score), 3) AS avg_readiness, COUNT(*) AS cases "
            "FROM v_case_overview WHERE readiness_score IS NOT NULL GROUP BY payer_type ORDER BY cases DESC"
        )
    if re.search(r"how many (lcds|ncds|policies|articles)|policies (are )?indexed|policy count", q):
        return (
            "SELECT doc_type, COUNT(*) AS policies FROM v_policy_catalog "
            "GROUP BY doc_type ORDER BY policies DESC"
        )
    return None


# ── 2. schema-aware retrieval + few-shot ───────────────────────────────────
def relevant_views(question: str, k: int = 3) -> list[str]:
    q = set(word_tokens(question))
    hints = {
        "v_criterion_outcomes": {
            "criterion",
            "criteria",
            "verdict",
            "met",
            "gap",
            "gaps",
            "override",
            "insufficient",
        },
        "v_denials": {"denial", "denials", "denied", "appeal", "appeals", "category"},
        "v_letters": {"letter", "letters", "lmn", "appeal", "draft", "approved"},
        "v_evaluations": {"evaluation", "evaluations", "run", "runs", "degraded"},
        "v_case_overview": {
            "case",
            "cases",
            "status",
            "payer",
            "due",
            "expedited",
            "readiness",
            "ready",
            "submitted",
        },
        "v_policy_catalog": {
            "policy",
            "policies",
            "lcd",
            "lcds",
            "ncd",
            "ncds",
            "article",
            "articles",
            "effective",
        },
        "v_policy_codes": {"code", "codes", "hcpcs", "cpt", "icd", "icd-10", "diagnosis", "list", "lists"},
        "v_policy_states": {"state", "states", "jurisdiction", "national"},
        "v_policy_contractors": {"contractor", "contractors", "mac", "macs", "publish", "jurisdiction"},
    }
    scored = []
    for name, v in VIEWS.items():
        vocab = set(word_tokens(v.description + " " + " ".join(v.columns))) | hints.get(name, set())
        scored.append((len(q & vocab) + (2 if q & hints.get(name, set()) else 0), name))
    scored.sort(reverse=True)
    picked = [n for s, n in scored[:k] if s > 0]
    return picked or ["v_case_overview", "v_criterion_outcomes"]


def few_shot(question: str, dialect: str, k: int = 3) -> list[tuple[str, str]]:
    q = set(word_tokens(question))
    pool = [
        (nl, sql)
        for nl, sql in FEW_SHOT
        if dialect == "postgresql" or not re.search(r"DATE_TRUNC|INTERVAL|::", sql)
    ]
    if dialect == "sqlite":
        pool.append(
            (
                "Cases created per week",
                "SELECT strftime('%Y-%W', created_at) AS week, COUNT(*) AS cases FROM v_case_overview "
                "GROUP BY 1 ORDER BY 1",
            )
        )
    pool.sort(key=lambda p: -len(q & set(word_tokens(p[0]))))
    return pool[:k]


class _GenSQL(BaseModel):
    sql: str = Field(description="a single read-only SELECT statement")
    explanation: str = ""


def _jsonable(v: Any) -> Any:
    if isinstance(v, dt.datetime | dt.date):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, bytes):
        return v.hex()
    return v


def chart_hint(columns: list[str], rows: list[list[Any]]) -> dict:
    if not rows or len(columns) < 2:
        return {"type": "table"}
    first = [r[0] for r in rows[:50]]
    numeric = [
        i
        for i, _ in enumerate(columns)
        if all(isinstance(r[i], int | float) or r[i] is None for r in rows[:50])
    ]
    if not numeric:
        return {"type": "table"}
    y = columns[numeric[-1]] if numeric[-1] != 0 else columns[numeric[0]]
    if any(k in columns[0].lower() for k in ("week", "day", "month", "date", "created", "_at")) or all(
        isinstance(v, str) and re.match(r"^\d{4}-\d{2}", v) for v in first if v
    ):
        return {"type": "line", "x": columns[0], "y": y}
    if len(rows) <= 6 and len(numeric) == 1:
        return {"type": "pie", "x": columns[0], "y": y}
    return {"type": "bar", "x": columns[0], "y": y}


async def _execute(sql: str, org_id: uuid.UUID, dialect: str) -> tuple[list[str], list[list[Any]]]:
    from app.db.session import get_engine

    engine = get_engine()
    org_param = org_id.hex if dialect == "sqlite" else str(org_id)

    async def run() -> tuple[list[str], list[list[Any]]]:
        async with engine.connect() as conn:
            if dialect == "postgresql":
                await conn.execute(text("SET TRANSACTION READ ONLY"))
                await conn.execute(text(f"SET LOCAL statement_timeout = {int(STATEMENT_TIMEOUT_S * 1000)}"))
                # Row-level security (see the tenant RLS migration) keys off this transaction-local
                # setting, so generated SQL is tenant-isolated even if the validator were bypassed.
                await conn.execute(text("SELECT set_config('app.org_id', :org, true)"), {"org": org_param})
            elif dialect == "sqlite":
                await conn.execute(text("PRAGMA query_only = 1"))
            try:
                params = {"org_id": org_param} if ":org_id" in sql else {}
                res = await conn.execute(text(sql), params)
                cols = list(res.keys())
                rows = [[_jsonable(v) for v in r] for r in res.fetchmany(MAX_ROWS)]
                return cols, rows
            finally:
                if dialect == "sqlite":
                    await conn.execute(text("PRAGMA query_only = 0"))
                await conn.rollback()

    return await asyncio.wait_for(run(), timeout=STATEMENT_TIMEOUT_S + 1)


def suppress_small_cells(
    columns: list[str], rows: list[list[Any]], threshold: int
) -> tuple[list[list[Any]], bool]:
    if threshold <= 0:
        return rows, False
    count_cols = [
        i for i, c in enumerate(columns) if c.lower() in {"n", "count", "cases", "patients", "total"}
    ]
    changed = False
    out = []
    for r in rows:
        r = list(r)
        for i in count_cols:
            if isinstance(r[i], int) and 0 < r[i] < threshold:
                r[i] = f"<{threshold}"
                changed = True
        out.append(r)
    return out, changed


async def answer_analytics(
    question: str, org_id: uuid.UUID, db: AsyncSession, *, budget: Any = None, allow_llm: bool = True
) -> SQLAnswer:
    dialect = db.get_bind().dialect.name
    ans = SQLAnswer(question=question)
    await ensure_views(db)
    await db.commit()

    candidates: list[tuple[str, str]] = []
    tpl = _template(question, dialect)
    if tpl:
        candidates.append(("template", tpl))

    async def try_sql(raw: str, method: str) -> str | None:
        v = validate_sql(
            raw,
            allowed=ALLOWED_VIEWS,
            tenant_views=TENANT_VIEWS,
            read_dialect=_sg(dialect),
            write_dialect=_sg(dialect),
            max_limit=MAX_ROWS,
        )
        if not v.ok:
            return "; ".join(v.errors)
        try:
            cols, rows = await _execute(v.sql, org_id, dialect)
        except Exception as exc:
            return f"database error: {str(exc).splitlines()[0][:300]}"
        threshold = int(getattr(get_settings(), "analytics_small_cell_threshold", 0) or 0)
        rows, suppressed = suppress_small_cells(cols, rows, threshold)
        if suppressed:
            ans.warnings.append(f"small cells (<{threshold}) suppressed")
        if v.limit_applied:
            ans.warnings.append(f"LIMIT {MAX_ROWS} applied")
        ans.sql, ans.columns, ans.rows, ans.method, ans.views = (
            v.sql,
            cols,
            rows[:RETURN_ROWS],
            method,
            v.views,
        )
        ans.row_count = len(rows)
        return None

    for method, sql in candidates:
        ans.attempts += 1
        err = await try_sql(sql, method)
        if err is None:
            return _finish(ans)
        ans.warnings.append(f"template failed: {err}")

    if not allow_llm:
        ans.warnings.append("no template matched and LLM generation is disabled")
        return _finish(ans)
    from app.ai.llm.router import get_llm_router
    from app.ai.llm.types import DataClass, LLMError
    from app.ai.prompts.loader import render

    router = get_llm_router()
    views = relevant_views(question)
    shots = few_shot(question, dialect)
    dialect_name = "SQLite" if dialect == "sqlite" else "PostgreSQL"
    prompt, _ = render(
        "sql_generate",
        dialect=dialect_name,
        schema="\n\n".join(schema_doc(VIEWS[v]) for v in views),
        examples="\n\n".join(f"Q: {nl}\nSQL: {s}" for nl, s in shots),
        question=question,
    )
    messages = [{"role": "user", "content": prompt}]
    last_err = ""
    for attempt in range(3):
        ans.attempts += 1
        try:
            res = await router.complete(
                group="sql",
                purpose="sql.generate" if attempt == 0 else "sql.repair",
                messages=messages,
                data_class=DataClass.INTERNAL,
                response_model=_GenSQL,
                org_id=org_id,
                budget=budget,
                max_tokens=500,
            )
        except LLMError as exc:
            ans.warnings.append(f"LLM unavailable: {str(exc)[:160]}")
            break
        gen: _GenSQL = res.parsed  # type: ignore[assignment]
        err = await try_sql(gen.sql, "llm")
        if err is None:
            if attempt:
                ans.warnings.append(f"self-corrected after {attempt} attempt(s)")
            return _finish(ans)
        last_err = err
        repair, _ = render("sql_repair", sql=gen.sql, error=err, dialect=dialect_name)
        messages = [*messages, {"role": "assistant", "content": gen.sql}, {"role": "user", "content": repair}]
    if last_err:
        ans.warnings.append(f"could not produce a valid query: {last_err}")
    return _finish(ans)


def _sg(dialect: str) -> str:
    return {"postgresql": "postgres", "sqlite": "sqlite"}.get(dialect, "postgres")


def _finish(ans: SQLAnswer) -> SQLAnswer:
    if ans.sql:
        ans.chart_hint = chart_hint(ans.columns, ans.rows)
        if not ans.rows:
            ans.summary = "The query ran successfully but returned no rows."
        elif len(ans.rows) == 1 and len(ans.columns) <= 3:
            ans.summary = ", ".join(f"{c}: {v}" for c, v in zip(ans.columns, ans.rows[0], strict=False))
        else:
            ans.summary = f"{ans.row_count} row(s) across {len(ans.columns)} column(s)."
    else:
        ans.summary = (
            "I couldn't answer that with the analytics views. Try: 'Top 5 gap criteria', "
            "'Cases by status', 'Ready rate by payer', or 'Denials by category'."
        )
    return ans
