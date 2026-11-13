"""Compiled, versioned criteria trees per policy version (workstream C)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Float, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, UTCDateTime, UUIDPkMixin, UUIDType


class CriteriaSet(UUIDPkMixin, TimestampMixin, Base):
    __tablename__ = "criteria_sets"

    # Stored as a string so curated sets can exist before the knowledge base is ingested
    # (and so this table has no hard FK into another workstream's schema).
    policy_version_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    policy_key: Mapped[str] = mapped_column(String(64), index=True)
    policy_version: Mapped[int | None] = mapped_column(nullable=True)
    title: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(32), default="draft", index=True)
    # draft | needs_review | approved | rejected | superseded
    source: Mapped[str] = mapped_column(String(32), default="llm")  # llm | curated | manual
    tree: Mapped[dict] = mapped_column()
    extractor_model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    verifier_model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    agreement: Mapped[float | None] = mapped_column(Float, nullable=True)
    grounding_pass_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    grounding: Mapped[dict | None] = mapped_column(nullable=True)  # per-leaf grounding report
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)

    __table_args__ = (Index("ix_criteria_sets_key_status", "policy_key", "status"),)


class CriteriaSetRef(Base):
    """Optional FK-style link table kept for referential reporting (policy_version_id → criteria set)."""

    __tablename__ = "criteria_set_links"

    criteria_set_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("criteria_sets.id", ondelete="CASCADE"), primary_key=True
    )
    policy_version_id: Mapped[str] = mapped_column(String(64), primary_key=True)
