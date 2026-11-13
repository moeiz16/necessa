"""Platform models: tenancy, identity, sessions, audit, jobs, notifications, assistant history.

Owned by workstream A (see docs/API_CONTRACT.md §3.1).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

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

DEFAULT_ORG_SETTINGS: dict = {
    "slaHoursStandard": 168,
    "slaHoursExpedited": 72,
    "dataRetentionDays": 365,
    "requireMfa": False,
    "defaultAsOf": "dos",
}


class Organization(UUIDPkMixin, TimestampMixin, Base):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    npi: Mapped[str | None] = mapped_column(String(10), nullable=True)
    specialty: Mapped[str | None] = mapped_column(String(120), nullable=True)
    practice_type: Mapped[str] = mapped_column(String(20), default="clinic")
    states: Mapped[list] = mapped_column(JSONType, default=list)
    payers: Mapped[list] = mapped_column(JSONType, default=list)
    timezone: Mapped[str] = mapped_column(String(64), default="America/New_York")
    settings: Mapped[dict] = mapped_column(JSONType, default=lambda: dict(DEFAULT_ORG_SETTINGS))
    onboarding_completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class User(UUIDPkMixin, TimestampMixin, Base):
    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(200))
    title: Mapped[str | None] = mapped_column(String(120), nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)
    email_verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    mfa_secret_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # Hashed one-time recovery codes (consumed codes are removed).
    mfa_recovery_codes: Mapped[list] = mapped_column(JSONType, default=list)
    avatar_color: Mapped[str] = mapped_column(String(16), default="#0F766E")
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    preferences: Mapped[dict] = mapped_column(JSONType, default=dict)

    memberships: Mapped[list[Membership]] = relationship(back_populates="user", lazy="raise")


class Membership(UUIDPkMixin, Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("org_id", "user_id", name="uq_membership_org_user"),)

    org_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("organizations.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(16), default="active")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)

    user: Mapped[User] = relationship(back_populates="memberships", lazy="raise")
    org: Mapped[Organization] = relationship(lazy="raise")


class Invitation(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "invitations"

    email: Mapped[str] = mapped_column(String(320), index=True)
    role: Mapped[str] = mapped_column(String(20))
    token_hash: Mapped[str] = mapped_column(String(128), unique=True)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    accepted_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class UserSession(UUIDPkMixin, Base):
    """A refresh-token family. The refresh token is `<session_id>.<secret>`; only the current
    secret's HMAC is stored, so presenting an older secret of the same family = reuse."""

    __tablename__ = "sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    refresh_token_hash: Mapped[str] = mapped_column(String(128))
    active_org_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(400), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    rotation_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    last_used_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    revoked_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)


class ApiKey(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "api_keys"

    name: Mapped[str] = mapped_column(String(120))
    prefix: Mapped[str] = mapped_column(String(24), index=True)
    key_hash: Mapped[str] = mapped_column(String(128), unique=True)
    scopes: Mapped[list] = mapped_column(JSONType, default=list)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Notification(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "notifications"
    __table_args__ = (Index("ix_notifications_user_unread", "user_id", "read_at"),)

    user_id: Mapped[uuid.UUID] = mapped_column(UUIDType, ForeignKey("users.id", ondelete="CASCADE"))
    type: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    link: Mapped[str | None] = mapped_column(String(500), nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, index=True)


class AuditLog(Base):
    """Append-only, hash-chained (per org) audit trail."""

    __tablename__ = "audit_log"
    __table_args__ = (Index("ix_audit_org_created", "org_id", "created_at"),)

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    org_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    actor_type: Mapped[str] = mapped_column(String(16), default="user")
    action: Mapped[str] = mapped_column(String(80), index=True)
    resource_type: Mapped[str | None] = mapped_column(String(40), nullable=True)
    resource_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(400), nullable=True)
    meta: Mapped[dict] = mapped_column("metadata", JSONType, default=dict)
    prev_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Job(UUIDPkMixin, Base):
    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_status_created", "status", "created_at"),)

    org_id: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True, index=True)
    type: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(16), default="queued")
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    params: Mapped[dict] = mapped_column(JSONType, default=dict)
    result: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUIDType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class Feedback(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "feedback"

    user_id: Mapped[uuid.UUID] = mapped_column(UUIDType)
    target_type: Mapped[str] = mapped_column(String(20))
    target_id: Mapped[str] = mapped_column(String(64), index=True)
    rating: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str | None] = mapped_column(String(120), nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Conversation(UUIDPkMixin, OrgScopedMixin, TimestampMixin, Base):
    __tablename__ = "conversations"

    user_id: Mapped[uuid.UUID] = mapped_column(UUIDType, index=True)
    title: Mapped[str] = mapped_column(String(200), default="New conversation")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)


class Message(UUIDPkMixin, OrgScopedMixin, Base):
    __tablename__ = "messages"

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUIDType, ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text, default="")
    citations: Mapped[list] = mapped_column(JSONType, default=list)
    route: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    sql: Mapped[dict | None] = mapped_column(JSONType, nullable=True)
    usage: Mapped[dict] = mapped_column(JSONType, default=dict)
    feedback: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
