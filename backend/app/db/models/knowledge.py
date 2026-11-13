"""Knowledge-base models (CMS MCD + payer policies + index bookkeeping + LLM telemetry).

Postgres is the source of truth; Qdrant collections are a derived,
rebuildable index (see ADR-005). Columns follow docs/API_CONTRACT.md §3.3.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
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
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, JSONType, TimestampMixin, UTCDateTime, UUIDPkMixin, UUIDType, utcnow

AutoBigInt = BigInteger().with_variant(Integer(), "sqlite")


class State(Base):
    __tablename__ = "states"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    abbrev: Mapped[str] = mapped_column(String(4), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))


class Contractor(Base):
    __tablename__ = "contractors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    type_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    version: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    name: Mapped[str] = mapped_column(String(255))
    number: Mapped[str | None] = mapped_column(String(32))
    type_label: Mapped[str | None] = mapped_column(String(64))
    url: Mapped[str | None] = mapped_column(String(512))
    dmerc_region: Mapped[str | None] = mapped_column(String(32))


class ContractorState(Base):
    __tablename__ = "contractor_states"
    __table_args__ = (Index("ix_contractor_states_lookup", "contractor_id", "contractor_type_id"),)

    id: Mapped[int] = mapped_column(AutoBigInt, primary_key=True, autoincrement=True)
    contractor_id: Mapped[int] = mapped_column(Integer)
    contractor_type_id: Mapped[int] = mapped_column(Integer)
    contractor_version: Mapped[int] = mapped_column(Integer, default=1)
    state_id: Mapped[int] = mapped_column(Integer, index=True)
    active_date: Mapped[date | None] = mapped_column(Date)
    term_date: Mapped[date | None] = mapped_column(Date)


class Policy(UUIDPkMixin, TimestampMixin, Base):
    __tablename__ = "policies"

    source: Mapped[str] = mapped_column(String(16), index=True)  # ncd|lcd|article|payer
    source_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    cms_id: Mapped[int | None] = mapped_column(Integer, index=True)
    title: Mapped[str] = mapped_column(Text)
    doc_type: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType)
    keywords: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(String(512))
    # Tenant-owned payer uploads carry an org; CMS content is public (NULL).
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, index=True)

    versions: Mapped[list[PolicyVersion]] = relationship(
        back_populates="policy", cascade="all, delete-orphan", foreign_keys="PolicyVersion.policy_id"
    )


class PolicyVersion(UUIDPkMixin, Base):
    __tablename__ = "policy_versions"
    __table_args__ = (UniqueConstraint("policy_id", "version", name="uq_policy_versions_policy_version"),)

    policy_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("policies.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    effective_from: Mapped[date | None] = mapped_column(Date, index=True)
    effective_to: Mapped[date | None] = mapped_column(Date)
    retired_at: Mapped[date | None] = mapped_column(Date)
    last_updated: Mapped[datetime | None] = mapped_column(UTCDateTime())
    content_hash: Mapped[str] = mapped_column(String(64))
    summary: Mapped[str | None] = mapped_column(Text)
    raw: Mapped[dict] = mapped_column(JSONType, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    policy: Mapped[Policy] = relationship(back_populates="versions", foreign_keys=[policy_id])
    sections: Mapped[list[PolicySection]] = relationship(
        back_populates="version", cascade="all, delete-orphan", order_by="PolicySection.ordinal"
    )


class PolicySection(UUIDPkMixin, Base):
    __tablename__ = "policy_sections"

    policy_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="CASCADE"), index=True
    )
    section_key: Mapped[str] = mapped_column(String(48), index=True)
    title: Mapped[str] = mapped_column(String(255))
    text: Mapped[str] = mapped_column(Text)
    ordinal: Mapped[int] = mapped_column(Integer, default=0)

    version: Mapped[PolicyVersion] = relationship(back_populates="sections")


class PolicyChunk(Base):
    __tablename__ = "policy_chunks"

    # id == Qdrant point id (UUID)
    id: Mapped[uuid.UUID] = mapped_column(UUIDType, primary_key=True)
    policy_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="CASCADE"), index=True
    )
    section_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("policy_sections.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer, default=0)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, index=True)
    level: Mapped[str] = mapped_column(String(8), default="child")  # child|parent
    text: Mapped[str] = mapped_column(Text)
    header: Mapped[str] = mapped_column(Text)
    token_estimate: Mapped[int] = mapped_column(Integer, default=0)
    char_start: Mapped[int] = mapped_column(Integer, default=0)
    char_end: Mapped[int] = mapped_column(Integer, default=0)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    embed_model: Mapped[str | None] = mapped_column(String(128))
    indexed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class PolicyLink(Base):
    __tablename__ = "policy_links"

    id: Mapped[int] = mapped_column(AutoBigInt, primary_key=True, autoincrement=True)
    from_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="CASCADE"), index=True
    )
    to_policy_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, index=True)
    to_source_key: Mapped[str] = mapped_column(String(64), index=True)
    relation: Mapped[str] = mapped_column(String(32))  # lcd_article|article_lcd|lcd_ncd|article_ncd|related
    meta: Mapped[dict] = mapped_column(JSONType, default=dict)


class PolicyContractor(Base):
    __tablename__ = "policy_contractors"

    id: Mapped[int] = mapped_column(AutoBigInt, primary_key=True, autoincrement=True)
    policy_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="CASCADE"), index=True
    )
    contractor_id: Mapped[int] = mapped_column(Integer, index=True)
    contractor_type_id: Mapped[int] = mapped_column(Integer)


class PolicyState(Base):
    __tablename__ = "policy_states"
    __table_args__ = (Index("ix_policy_states_state", "state_abbrev", "policy_version_id"),)

    id: Mapped[int] = mapped_column(AutoBigInt, primary_key=True, autoincrement=True)
    policy_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="CASCADE"), index=True
    )
    state_abbrev: Mapped[str] = mapped_column(String(4))  # "US" == national (NCD)
    primary: Mapped[bool] = mapped_column(Boolean, default=False)


class PolicyCode(Base):
    __tablename__ = "policy_codes"
    __table_args__ = (Index("ix_policy_codes_system_code", "code_system", "code"),)

    id: Mapped[int] = mapped_column(AutoBigInt, primary_key=True, autoincrement=True)
    policy_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="CASCADE"), index=True
    )
    code_system: Mapped[str] = mapped_column(String(24))
    code: Mapped[str] = mapped_column(String(32))
    group_no: Mapped[int] = mapped_column(Integer, default=0)
    # Descriptions may be AMA CPT content: stored locally only, never exported/committed.
    description: Mapped[str | None] = mapped_column(Text)
    is_range: Mapped[bool] = mapped_column(Boolean, default=False)


class PolicyCodeGroup(Base):
    __tablename__ = "policy_code_groups"

    id: Mapped[int] = mapped_column(AutoBigInt, primary_key=True, autoincrement=True)
    policy_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("policy_versions.id", ondelete="CASCADE"), index=True
    )
    code_system: Mapped[str] = mapped_column(String(24))
    group_no: Mapped[int] = mapped_column(Integer)
    paragraph: Mapped[str] = mapped_column(Text)


class Code(Base):
    __tablename__ = "codes"

    code_system: Mapped[str] = mapped_column(String(16), primary_key=True)  # HCPCS|ICD10CM|ICD10PCS
    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    short_desc: Mapped[str | None] = mapped_column(Text)
    long_desc: Mapped[str | None] = mapped_column(Text)


class IndexVersion(UUIDPkMixin, Base):
    __tablename__ = "index_versions"

    alias: Mapped[str] = mapped_column(String(64), index=True)
    physical_name: Mapped[str] = mapped_column(String(128), unique=True)
    embed_model: Mapped[str | None] = mapped_column(String(128))
    dims: Mapped[int] = mapped_column(Integer, default=0)
    sparse_model: Mapped[str] = mapped_column(String(64), default="bm25-snowball-v1")
    status: Mapped[str] = mapped_column(String(16), default="building", index=True)
    points: Mapped[int] = mapped_column(Integer, default=0)
    stats: Mapped[dict] = mapped_column(JSONType, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    activated_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class IngestionRun(UUIDPkMixin, Base):
    __tablename__ = "ingestion_runs"

    source: Mapped[str] = mapped_column(String(32))
    scope: Mapped[dict] = mapped_column(JSONType, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="running", index=True)
    stats: Mapped[dict] = mapped_column(JSONType, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType)


class LLMCall(Base):
    __tablename__ = "llm_calls"
    __table_args__ = (Index("ix_llm_calls_created", "created_at"),)

    id: Mapped[int] = mapped_column(AutoBigInt, primary_key=True, autoincrement=True)
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, index=True)
    request_id: Mapped[str | None] = mapped_column(String(64))
    group: Mapped[str] = mapped_column(String(48), index=True)
    purpose: Mapped[str] = mapped_column(String(64))
    provider: Mapped[str] = mapped_column(String(32), index=True)
    model: Mapped[str] = mapped_column(String(128))
    data_class: Mapped[str] = mapped_column(String(16), default="PUBLIC")
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    cache_hit: Mapped[bool] = mapped_column(Boolean, default=False)
    fallback_used: Mapped[bool] = mapped_column(Boolean, default=False)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="ok")  # ok|error|rate_limited|blocked
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class ResponseCache(Base):
    __tablename__ = "response_cache"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONType, default=dict)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), index=True)
    hits: Mapped[int] = mapped_column(Integer, default=0)
    score: Mapped[float | None] = mapped_column(Float)


KNOWLEDGE_TABLES = (
    "states",
    "contractors",
    "contractor_states",
    "policies",
    "policy_versions",
    "policy_sections",
    "policy_chunks",
    "policy_links",
    "policy_contractors",
    "policy_states",
    "policy_codes",
    "policy_code_groups",
    "codes",
    "index_versions",
    "ingestion_runs",
    "llm_calls",
    "response_cache",
)
