"""Case domain models: patients, cases, documents, chart chunks, evaluations, letters, denials.

Written by the case-evaluation agent during runs. See docs/API_CONTRACT.md §3.2.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    Base,
    JSONType,
    OrgScopedMixin,
    TimestampMixin,
    UTCDateTime,
    UUIDPkMixin,
    UUIDType,
    utcnow,
)

CASE_STATUSES = (
    "draft",
    "evaluating",
    "needs_review",
    "ready",
    "submitted",
    "pending_payer",
    "approved",
    "denied",
    "appealing",
    "closed",
)
OPEN_STATUSES = ("draft", "evaluating", "needs_review", "ready", "submitted", "pending_payer", "appealing")


class Patient(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "patients"

    external_ref: Mapped[str] = mapped_column(String(64), index=True)
    # Fernet-encrypted JSON: {fullName, dob, address, phone, memberId, mrn}
    demographics_enc: Mapped[str] = mapped_column(Text)
    masked_name: Mapped[str] = mapped_column(String(32), default="Patient")
    sex: Mapped[str | None] = mapped_column(String(16), nullable=True)
    birth_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    state: Mapped[str | None] = mapped_column(String(2), nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="manual")
    fhir_bundle_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Case(UUIDPkMixin, OrgScopedMixin, TimestampMixin, Base):
    __tablename__ = "cases"
    __table_args__ = (
        UniqueConstraint("org_id", "number", name="uq_cases_org_number"),
        Index("ix_cases_org_status", "org_id", "status"),
        Index("ix_cases_org_due", "org_id", "due_at"),
        Index("ix_cases_org_updated", "org_id", "updated_at"),
    )

    number: Mapped[str] = mapped_column(String(24))
    patient_id: Mapped[uuid.UUID] = mapped_column(UUIDType, ForeignKey("patients.id"), index=True)
    title: Mapped[str] = mapped_column(String(240))
    status: Mapped[str] = mapped_column(String(20), default="draft")
    priority: Mapped[str] = mapped_column(String(12), default="standard")
    payer_type: Mapped[str] = mapped_column(String(24), default="medicare_ffs")
    payer_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    state: Mapped[str | None] = mapped_column(String(2), nullable=True)
    service_codes: Mapped[list] = mapped_column(JSONType, default=list)
    dx_codes: Mapped[list] = mapped_column(JSONType, default=list)
    date_of_service: Mapped[date | None] = mapped_column(Date, nullable=True)
    place_of_service: Mapped[str | None] = mapped_column(String(40), nullable=True)
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, ForeignKey("users.id"), nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    readiness: Mapped[str] = mapped_column(String(16), default="unknown")
    readiness_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    policy_refs: Mapped[list] = mapped_column(JSONType, default=list)
    latest_evaluation_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    outcome: Mapped[str | None] = mapped_column(String(16), nullable=True)
    outcome_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    tags: Mapped[list] = mapped_column(JSONType, default=list)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)


class CaseDocument(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "case_documents"

    case_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("cases.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(24))
    filename: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64))
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    text_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    text_deid: Mapped[str | None] = mapped_column(Text, nullable=True)
    ocr_used: Mapped[bool] = mapped_column(Boolean, default=False)
    injection_score: Mapped[float] = mapped_column(Float, default=0.0)
    quarantined: Mapped[bool] = mapped_column(Boolean, default=False)
    note_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    meta: Mapped[dict] = mapped_column(JSONType, default=dict)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class CaseChunk(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "case_chunks"

    case_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("cases.id", ondelete="CASCADE"), index=True
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("case_documents.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    text_deid: Mapped[str] = mapped_column(Text)
    section: Mapped[str | None] = mapped_column(String(120), nullable=True)
    note_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    char_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    char_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    meta: Mapped[dict] = mapped_column(JSONType, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class CaseEvent(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "case_events"
    __table_args__ = (Index("ix_case_events_case_created", "case_id", "created_at"),)

    case_id: Mapped[uuid.UUID] = mapped_column(UUIDType, ForeignKey("cases.id", ondelete="CASCADE"))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    type: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSONType, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class CaseEvaluation(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "case_evaluations"

    case_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("cases.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[str] = mapped_column(String(20), default="running")
    readiness: Mapped[str] = mapped_column(String(16), default="unknown")
    readiness_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    policy_version_ids: Mapped[list] = mapped_column(JSONType, default=list)
    criteria_set_ids: Mapped[list] = mapped_column(JSONType, default=list)
    tree_result: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    gaps: Mapped[list] = mapped_column(JSONType, default=list)
    model_info: Mapped[dict] = mapped_column(JSONType, default=dict)
    token_usage: Mapped[dict] = mapped_column(JSONType, default=dict)
    degraded: Mapped[bool] = mapped_column(Boolean, default=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_by: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class CriterionResult(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "criterion_results"

    evaluation_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("case_evaluations.id", ondelete="CASCADE"), index=True
    )
    case_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("cases.id", ondelete="CASCADE"), index=True
    )
    criterion_id: Mapped[str] = mapped_column(String(40))
    criterion_text: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(String(24), default="positive")
    tree_path: Mapped[str | None] = mapped_column(String(200), nullable=True)
    verdict: Mapped[str] = mapped_column(String(16))
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence: Mapped[list] = mapped_column(JSONType, default=list)
    policy_citation: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    verification: Mapped[dict] = mapped_column(JSONType, default=dict)
    override_verdict: Mapped[str | None] = mapped_column(String(16), nullable=True)
    override_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    overridden_by: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    overridden_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Letter(UUIDPkMixin, OrgScopedMixin, TimestampMixin, Base):
    __tablename__ = "letters"

    case_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("cases.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(24))
    status: Mapped[str] = mapped_column(String(16), default="draft")
    title: Mapped[str] = mapped_column(String(240), default="")
    content_md: Mapped[str] = mapped_column(Text, default="")
    version: Mapped[int] = mapped_column(Integer, default=1)
    citations: Mapped[list] = mapped_column(JSONType, default=list)
    model_info: Mapped[dict] = mapped_column(JSONType, default=dict)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Denial(UUIDPkMixin, OrgScopedMixin, TimestampMixin, Base):
    __tablename__ = "denials"

    case_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("cases.id", ondelete="CASCADE"), index=True
    )
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    received_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    reason_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    carc_codes: Mapped[list] = mapped_column(JSONType, default=list)
    rarc_codes: Mapped[list] = mapped_column(JSONType, default=list)
    category: Mapped[str] = mapped_column(String(24), default="other")
    mapped_criteria: Mapped[list] = mapped_column(JSONType, default=list)
    appeal_deadline: Mapped[date | None] = mapped_column(Date, nullable=True)
    appeal_letter_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="new")
    analysis: Mapped[dict] = mapped_column(JSONType, default=dict)
