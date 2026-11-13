"""SQL safety validator (sqlglot AST) for model-generated SQL.

Rules: exactly one statement · SELECT/UNION/CTE only · no DDL/DML/commands anywhere in the tree ·
only allowlisted views (CTE names allowed) · function blocklist · no cartesian joins · LIMIT ≤ max
(added when missing) · tenant views rewritten to `(SELECT * FROM v WHERE org_id = :org_id) AS v`
so tenancy is enforced by construction. Output is transpiled to the execution dialect.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import sqlglot
from sqlglot import exp

BLOCKED_FUNCTIONS = frozenset(
    {
        "pg_sleep",
        "pg_read_file",
        "pg_read_binary_file",
        "pg_ls_dir",
        "pg_stat_file",
        "lo_import",
        "lo_export",
        "dblink",
        "dblink_exec",
        "set_config",
        "current_setting",
        "pg_terminate_backend",
        "pg_cancel_backend",
        "load_extension",
        "readfile",
        "writefile",
        "edit",
        "fts3_tokenizer",
        "query_to_xml",
        "xpath",
        "sleep",
        "benchmark",
        "version",
        "pg_advisory_lock",
        "txid_current",
        "inet_server_addr",
    }
)
_FORBIDDEN_NODES = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Drop,
    exp.Create,
    exp.Alter,
    exp.Command,
    exp.Merge,
    exp.Grant,
    exp.TruncateTable,
    exp.Copy,
    exp.Set,
    exp.Pragma,
    exp.Use,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
    exp.LoadData,
    exp.Into,
)


@dataclass
class ValidationResult:
    ok: bool
    sql: str = ""
    errors: list[str] = field(default_factory=list)
    views: list[str] = field(default_factory=list)
    limit_applied: bool = False


def validate_sql(
    sql: str,
    *,
    allowed: frozenset[str] | set[str],
    tenant_views: frozenset[str] | set[str],
    read_dialect: str = "postgres",
    write_dialect: str = "postgres",
    max_limit: int = 1000,
) -> ValidationResult:
    sql = (sql or "").strip().rstrip(";").strip()
    if not sql:
        return ValidationResult(False, errors=["empty SQL"])
    try:
        statements = [s for s in sqlglot.parse(sql, read=read_dialect) if s is not None]
    except sqlglot.errors.ParseError as exc:
        return ValidationResult(False, errors=[f"parse error: {str(exc)[:300]}"])
    if len(statements) != 1:
        return ValidationResult(False, errors=["exactly one statement is allowed"])
    tree = statements[0]
    errors: list[str] = []
    if not isinstance(tree, exp.Query):
        errors.append(f"only SELECT queries are allowed (got {type(tree).__name__})")
    for node in tree.walk():
        if isinstance(node, _FORBIDDEN_NODES):
            errors.append(f"forbidden operation: {type(node).__name__}")
            break
    cte_names = {c.alias_or_name.lower() for c in tree.find_all(exp.CTE)}
    views: list[str] = []
    for t in tree.find_all(exp.Table):
        name = t.name.lower()
        if not name:
            continue
        if t.args.get("db") or t.args.get("catalog"):
            errors.append(f"schema-qualified table not allowed: {t.sql()}")
            continue
        if name in cte_names:
            continue
        if name not in allowed:
            errors.append(f"table/view not allowed: {name}")
        elif name not in views:
            views.append(name)
    for fn in tree.find_all(exp.Func):
        fname = (fn.name or fn.sql_name() or "").lower()
        if fname in BLOCKED_FUNCTIONS or fname.startswith("pg_"):
            errors.append(f"function not allowed: {fname}")
    for sel in tree.find_all(exp.Select):
        joins = sel.args.get("joins") or []
        for j in joins:
            if (j.args.get("kind") or "").upper() == "CROSS" or (
                not j.args.get("on") and not j.args.get("using") and not isinstance(j.this, exp.Unnest)
            ):
                errors.append("joins must have an ON/USING condition (no cartesian products)")
        from_ = sel.args.get("from")
        if from_ is not None and len(from_.expressions or []) > 1:
            errors.append("comma joins are not allowed; use JOIN … ON")
    if errors:
        return ValidationResult(False, errors=list(dict.fromkeys(errors)), views=views)

    # LIMIT enforcement on the outermost query
    limit_applied = False
    limit = tree.args.get("limit")
    if limit is None:
        tree = tree.limit(max_limit)
        limit_applied = True
    else:
        try:
            n = int(limit.expression.this) if limit.expression is not None else max_limit + 1
        except (ValueError, AttributeError):
            n = max_limit + 1
        if n > max_limit:
            tree = tree.limit(max_limit)
            limit_applied = True

    # Tenant isolation by construction
    def _rewrite(node: exp.Expression) -> exp.Expression:
        if (
            isinstance(node, exp.Table)
            and node.name.lower() in tenant_views
            and node.name.lower() not in cte_names
        ):
            alias = node.alias or node.name
            sub = (
                exp.select("*")
                .from_(exp.to_table(node.name))
                .where(exp.EQ(this=exp.column("org_id"), expression=exp.Placeholder(this="org_id")))
            )
            return exp.Subquery(this=sub, alias=exp.TableAlias(this=exp.to_identifier(alias)))
        return node

    tree = tree.transform(_rewrite, copy=True)
    try:
        out = tree.sql(dialect=write_dialect)
        # SQLAlchemy text() binds `:name` on every dialect; sqlglot renders psycopg style for postgres.
        out = out.replace("%(org_id)s", ":org_id")
    except Exception as exc:
        return ValidationResult(False, errors=[f"could not render SQL: {exc}"], views=views)
    return ValidationResult(True, sql=out, views=views, limit_applied=limit_applied)
