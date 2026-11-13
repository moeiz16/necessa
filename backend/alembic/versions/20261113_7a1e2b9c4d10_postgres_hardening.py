"""postgres hardening: tenant row-level security, search indexes and analytics views

Revision ID: 7a1e2b9c4d10
Revises: 3c16df00954f
Create Date: 2026-11-13 15:10:00+00:00

PostgreSQL only (no-op on SQLite, where tests and offline dev create views lazily).

Row-level security is defense in depth: the application already filters every tenant query on
`org_id`. Policies activate when a transaction sets `app.org_id` (the text-to-SQL executor always
does), so model-generated SQL stays tenant-isolated even if the AST validator were bypassed.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "7a1e2b9c4d10"
down_revision: str | None = "3c16df00954f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TENANT_TABLES = (
    "api_keys",
    "case_chunks",
    "case_documents",
    "case_evaluations",
    "case_events",
    "cases",
    "conversations",
    "criterion_results",
    "denials",
    "feedback",
    "invitations",
    "letters",
    "memberships",
    "messages",
    "notifications",
    "patients",
)

_TENANT_PREDICATE = (
    "coalesce(current_setting('app.org_id', true), '') = '' "
    "OR org_id::text = current_setting('app.org_id', true)"
)


def _is_postgres() -> bool:
    return op.get_context().dialect.name == "postgresql"


def upgrade() -> None:
    if not _is_postgres():
        return

    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    # Lexical retrieval channel (websearch_to_tsquery over header + text).
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_policy_chunks_fts ON policy_chunks USING GIN "
        "(to_tsvector('english', coalesce(header,'') || ' ' || coalesce(text,'')))"
    )
    # Fast substring / fuzzy code search in the code explorer.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_codes_short_desc_trgm ON codes USING GIN (short_desc gin_trgm_ops)"
    )
    op.execute("CREATE INDEX IF NOT EXISTS ix_policies_title_trgm ON policies USING GIN (title gin_trgm_ops)")

    for table in TENANT_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {table}")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table} "
            f"USING ({_TENANT_PREDICATE}) WITH CHECK ({_TENANT_PREDICATE})"
        )

    # Allowlisted analytics/knowledge views for text-to-SQL (snapshot of app.ai.sql.views at this revision).
    from app.ai.sql.views import VIEWS

    for view in VIEWS.values():
        op.execute(f"CREATE OR REPLACE VIEW {view.name} AS {view.sql}")


def downgrade() -> None:
    if not _is_postgres():
        return
    from app.ai.sql.views import VIEWS

    for view in VIEWS.values():
        op.execute(f"DROP VIEW IF EXISTS {view.name}")
    for table in TENANT_TABLES:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.execute("DROP INDEX IF EXISTS ix_policies_title_trgm")
    op.execute("DROP INDEX IF EXISTS ix_codes_short_desc_trgm")
    op.execute("DROP INDEX IF EXISTS ix_policy_chunks_fts")
