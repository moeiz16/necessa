"""Import every model module so Base.metadata is complete (Alembic, create_all). SHARED FILE."""

from app.db.models import cases, criteria, evals, knowledge, platform  # noqa: F401
