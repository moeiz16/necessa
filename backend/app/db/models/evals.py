"""Evaluation runs (offline quality gates) — workstream C."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, UTCDateTime, UUIDPkMixin, UUIDType, utcnow


class EvalRun(UUIDPkMixin, Base):
    __tablename__ = "eval_runs"

    suite: Mapped[str] = mapped_column(
        String(32), index=True
    )  # retrieval|verdicts|sql|faithfulness|safety|e2e
    status: Mapped[str] = mapped_column(
        String(16), default="running", index=True
    )  # running|passed|failed|error
    metrics: Mapped[dict] = mapped_column(default=dict)
    gates: Mapped[dict] = mapped_column(default=dict)  # {metric: {threshold, op, value, passed}}
    config: Mapped[dict] = mapped_column(default=dict)
    git_sha: Mapped[str | None] = mapped_column(String(64), nullable=True)
    items_total: Mapped[int] = mapped_column(Integer, default=0)
    items_passed: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)


class EvalResult(Base):
    __tablename__ = "eval_results"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    run_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("eval_runs.id", ondelete="CASCADE"), index=True
    )
    item_id: Mapped[str] = mapped_column(String(200))
    passed: Mapped[bool] = mapped_column(Boolean, default=False)
    metrics: Mapped[dict] = mapped_column(default=dict)
    details: Mapped[dict] = mapped_column(default=dict)
