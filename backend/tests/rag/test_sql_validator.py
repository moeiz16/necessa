import pytest

from app.ai.sql.validator import validate_sql
from app.ai.sql.views import ALLOWED_VIEWS, TENANT_VIEWS


def v(sql: str, dialect: str = "postgres"):
    return validate_sql(
        sql, allowed=ALLOWED_VIEWS, tenant_views=TENANT_VIEWS, read_dialect="postgres", write_dialect=dialect
    )


def test_allows_select_on_views_and_injects_tenant_and_limit():
    r = v("SELECT status, COUNT(*) AS n FROM v_case_overview GROUP BY status")
    assert r.ok
    assert "org_id = :org_id" in r.sql and "LIMIT 1000" in r.sql and r.limit_applied


@pytest.mark.parametrize(
    "sql,needle",
    [
        ("SELECT * FROM cases", "not allowed: cases"),
        ("SELECT * FROM users", "not allowed: users"),
        ("DELETE FROM v_case_overview", "SELECT"),
        ("UPDATE v_case_overview SET status = 'closed'", "SELECT"),
        ("SELECT 1; DROP TABLE users", "exactly one statement"),
        ("SELECT a.status FROM v_case_overview a, v_denials d", "join"),
        ("SELECT * FROM v_case_overview CROSS JOIN v_denials", "ON/USING"),
        ("SELECT pg_sleep(5)", "pg_sleep"),
        ("SELECT * FROM public.v_case_overview", "schema-qualified"),
        ("SELECT * FROM (SELECT * FROM audit_log) x", "audit_log"),
    ],
)
def test_blocks_dangerous_or_out_of_scope_sql(sql, needle):
    r = v(sql)
    assert not r.ok
    assert any(needle.lower() in e.lower() for e in r.errors), r.errors


def test_caps_excessive_limit_and_keeps_ctes():
    r = v(
        "WITH d AS (SELECT case_id FROM v_denials) SELECT COUNT(*) FROM d "
        "JOIN v_case_overview c ON c.case_id = d.case_id LIMIT 99999"
    )
    assert r.ok and "LIMIT 1000" in r.sql
    assert r.sql.count(":org_id") == 2  # both tenant views rewritten, CTE name untouched


def test_public_knowledge_views_are_not_tenant_rewritten():
    r = v("SELECT doc_type, COUNT(*) FROM v_policy_catalog GROUP BY doc_type", dialect="sqlite")
    assert r.ok and ":org_id" not in r.sql
