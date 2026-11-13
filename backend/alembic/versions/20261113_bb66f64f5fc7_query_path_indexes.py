"""query-path indexes: audit chain head, activity feed, inbox, analytics date ranges, code lookup

Revision ID: bb66f64f5fc7
Revises: 7a1e2b9c4d10
Create Date: 2026-11-13 22:30:00+00:00

Every index backs a hot query that previously had to filter or sort a whole tenant's rows:

* audit_log (org_id, id)                     - chain head lookup on every audited request, verify, browse
* case_events (org_id, created_at)           - org activity feed (dashboard)
* notifications (org_id, user_id, created_at) - notification bell / inbox
* cases / case_evaluations / criterion_results / letters / denials (org_id, <time>) - analytics ranges
* case_evaluations (case_id, started_at)     - a case's evaluation history
* codes (code)                               - code explorer exact/prefix lookups without a system

On PostgreSQL the indexes are built CONCURRENTLY (outside a transaction) so the migration doesn't
block writes on large tables; IF [NOT] EXISTS keeps re-runs after a partial failure safe.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "bb66f64f5fc7"
down_revision: str | None = "7a1e2b9c4d10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (name, table, columns, postgresql_ops)
INDEXES: tuple[tuple[str, str, list[str], dict[str, str] | None], ...] = (
    ("ix_audit_org_id", "audit_log", ["org_id", "id"], None),
    ("ix_case_events_org_created", "case_events", ["org_id", "created_at"], None),
    ("ix_notifications_org_user_created", "notifications", ["org_id", "user_id", "created_at"], None),
    ("ix_cases_org_created", "cases", ["org_id", "created_at"], None),
    ("ix_case_evaluations_case_started", "case_evaluations", ["case_id", "started_at"], None),
    ("ix_case_evaluations_org_started", "case_evaluations", ["org_id", "started_at"], None),
    ("ix_criterion_results_org_created", "criterion_results", ["org_id", "created_at"], None),
    ("ix_letters_org_created", "letters", ["org_id", "created_at"], None),
    ("ix_denials_org_created", "denials", ["org_id", "created_at"], None),
    ("ix_codes_code", "codes", ["code"], {"code": "varchar_pattern_ops"}),
)


def _is_postgres() -> bool:
    return op.get_context().dialect.name == "postgresql"


def upgrade() -> None:
    if _is_postgres():
        with op.get_context().autocommit_block():
            for name, table, cols, ops in INDEXES:
                op.create_index(
                    name,
                    table,
                    cols,
                    unique=False,
                    postgresql_concurrently=True,
                    postgresql_ops=ops or {},
                    if_not_exists=True,
                )
        return
    for name, table, cols, _ops in INDEXES:
        op.create_index(name, table, cols, unique=False)


def downgrade() -> None:
    if _is_postgres():
        with op.get_context().autocommit_block():
            for name, table, _cols, _ops in reversed(INDEXES):
                op.drop_index(name, table_name=table, postgresql_concurrently=True, if_exists=True)
        return
    for name, table, _cols, _ops in reversed(INDEXES):
        op.drop_index(name, table_name=table)
