"""Platform API schemas (auth, users, orgs, members, invitations, API keys, notifications, audit, jobs)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import EmailStr, Field, field_validator

from app.core.permissions import ROLES
from app.schemas.base import APIModel

Role = Literal["owner", "admin", "coordinator", "clinician", "reviewer", "rcm_manager", "auditor"]
PracticeType = Literal["clinic", "hospital", "asc", "dme", "other"]
US_STATES = {
    "AL",
    "AK",
    "AZ",
    "AR",
    "CA",
    "CO",
    "CT",
    "DE",
    "DC",
    "FL",
    "GA",
    "HI",
    "ID",
    "IL",
    "IN",
    "IA",
    "KS",
    "KY",
    "LA",
    "ME",
    "MD",
    "MA",
    "MI",
    "MN",
    "MS",
    "MO",
    "MT",
    "NE",
    "NV",
    "NH",
    "NJ",
    "NM",
    "NY",
    "NC",
    "ND",
    "OH",
    "OK",
    "OR",
    "PA",
    "RI",
    "SC",
    "SD",
    "TN",
    "TX",
    "UT",
    "VT",
    "VA",
    "WA",
    "WV",
    "WI",
    "WY",
    "PR",
    "VI",
    "GU",
    "AS",
    "MP",
}
assert set(ROLES) == set(Role.__args__)  # type: ignore[attr-defined]


def _check_states(v: list[str]) -> list[str]:
    out = sorted({s.strip().upper() for s in v if s and s.strip()})
    bad = [s for s in out if s not in US_STATES]
    if bad:
        raise ValueError(f"Unknown state code(s): {', '.join(bad)}")
    return out


# ── Users & auth ────────────────────────────────────────────────────────────
class UserOut(APIModel):
    id: uuid.UUID
    email: str
    full_name: str
    title: str | None = None
    avatar_color: str
    mfa_enabled: bool
    is_superuser: bool = False
    preferences: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class OrgSummary(APIModel):
    id: uuid.UUID
    name: str
    slug: str
    role: str


class SignupIn(APIModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
    full_name: str = Field(min_length=1, max_length=200)


class SignupOut(APIModel):
    user: UserOut
    needs_onboarding: bool = True


class LoginIn(APIModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
    mfa_code: str | None = Field(default=None, max_length=32)


class LoginOut(APIModel):
    user: UserOut | None
    orgs: list[OrgSummary] = Field(default_factory=list)
    active_org_id: uuid.UUID | None = None
    mfa_required: bool = False


class MembershipInfo(APIModel):
    role: str
    permissions: list[str]


class OrgOut(APIModel):
    id: uuid.UUID
    name: str
    slug: str
    npi: str | None = None
    specialty: str | None = None
    practice_type: str
    states: list[str]
    payers: list[dict[str, Any]]
    timezone: str
    settings: dict[str, Any]
    onboarding_completed_at: datetime | None = None
    created_at: datetime
    counts: dict[str, int] | None = None


class MeOut(APIModel):
    user: UserOut
    active_org: OrgOut | None
    membership: MembershipInfo | None
    orgs: list[OrgSummary]


class SwitchOrgIn(APIModel):
    org_id: uuid.UUID


class ForgotPasswordIn(APIModel):
    email: EmailStr


class ResetPasswordIn(APIModel):
    token: str = Field(min_length=10, max_length=2000)
    password: str = Field(min_length=1, max_length=256)


class ChangePasswordIn(APIModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


class MfaSetupOut(APIModel):
    secret: str
    otpauth_url: str


class MfaCodeIn(APIModel):
    code: str = Field(min_length=6, max_length=32)


class MfaVerifyOut(APIModel):
    enabled: bool
    recovery_codes: list[str]


class SessionOut(APIModel):
    id: uuid.UUID
    user_agent: str | None
    ip: str | None
    created_at: datetime
    last_used_at: datetime
    current: bool


class UserUpdateIn(APIModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=200)
    title: str | None = Field(default=None, max_length=120)
    avatar_color: str | None = Field(default=None, pattern=r"^#[0-9A-Fa-f]{6}$")
    preferences: dict[str, Any] | None = None


# ── Orgs ─────────────────────────────────────────────────────────────────────
class PayerIn(APIModel):
    type: Literal["medicare_ffs", "medicare_advantage", "commercial", "medicaid"]
    name: str = Field(min_length=1, max_length=120)


class OrgCreateIn(APIModel):
    name: str = Field(min_length=2, max_length=200)
    npi: str | None = Field(default=None, pattern=r"^\d{10}$")
    specialty: str | None = Field(default=None, max_length=120)
    practice_type: PracticeType = "clinic"
    states: list[str] = Field(default_factory=list)
    payers: list[PayerIn] = Field(default_factory=list)
    timezone: str = "America/New_York"

    _states = field_validator("states")(_check_states)


class OrgUpdateIn(APIModel):
    name: str | None = Field(default=None, min_length=2, max_length=200)
    npi: str | None = Field(default=None, pattern=r"^\d{10}$")
    specialty: str | None = Field(default=None, max_length=120)
    practice_type: PracticeType | None = None
    states: list[str] | None = None
    payers: list[PayerIn] | None = None
    timezone: str | None = None
    settings: dict[str, Any] | None = None

    @field_validator("states")
    @classmethod
    def _v_states(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else _check_states(v)


class MemberOut(APIModel):
    id: uuid.UUID  # user id
    full_name: str
    email: str
    role: str
    status: str
    last_login_at: datetime | None
    mfa_enabled: bool
    avatar_color: str
    joined_at: datetime


class MemberUpdateIn(APIModel):
    role: Role | None = None
    status: Literal["active", "suspended"] | None = None


class InvitationCreateIn(APIModel):
    email: EmailStr
    role: Role = "coordinator"


class InvitationOut(APIModel):
    id: uuid.UUID
    email: str
    role: str
    invited_by: uuid.UUID | None
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime
    status: str


class InvitationCreatedOut(APIModel):
    invitation: InvitationOut
    dev_link: str | None = None


class InvitationPublicOut(APIModel):
    org_name: str
    email: str
    role: str
    expires_at: datetime
    account_exists: bool


class InvitationAcceptIn(APIModel):
    full_name: str | None = Field(default=None, max_length=200)
    password: str | None = Field(default=None, max_length=256)


class ApiKeyCreateIn(APIModel):
    name: str = Field(min_length=1, max_length=120)
    scopes: list[str] = Field(default_factory=lambda: ["cases:read", "policies:read"])
    expires_in_days: int | None = Field(default=None, ge=1, le=730)


class ApiKeyOut(APIModel):
    id: uuid.UUID
    name: str
    prefix: str
    scopes: list[str]
    created_by: uuid.UUID | None
    last_used_at: datetime | None
    expires_at: datetime | None
    revoked_at: datetime | None
    created_at: datetime


class ApiKeyCreatedOut(APIModel):
    api_key: ApiKeyOut
    secret: str


# ── Notifications / audit / jobs / feedback ─────────────────────────────────
class NotificationOut(APIModel):
    id: uuid.UUID
    type: str
    title: str
    body: str | None
    link: str | None
    read_at: datetime | None
    created_at: datetime


class AuditEntryOut(APIModel):
    id: int
    actor_id: uuid.UUID | None
    actor_name: str | None = None
    actor_type: str
    action: str
    resource_type: str | None
    resource_id: str | None
    ip: str | None
    user_agent: str | None
    metadata: dict[str, Any] = Field(default_factory=dict)
    hash: str
    prev_hash: str | None
    created_at: datetime


class AuditVerifyOut(APIModel):
    valid: bool
    checked: int
    broken_at: int | None = None


class JobOut(APIModel):
    id: uuid.UUID
    type: str
    status: str
    progress: float
    message: str | None
    params: dict[str, Any]
    result: dict[str, Any] | None
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class FeedbackIn(APIModel):
    target_type: Literal["answer", "verdict", "letter", "retrieval"]
    target_id: str = Field(min_length=1, max_length=64)
    rating: Literal[1, -1]
    reason: str | None = Field(default=None, max_length=120)
    comment: str | None = Field(default=None, max_length=4000)


class FeedbackOut(APIModel):
    id: uuid.UUID
    target_type: str
    target_id: str
    rating: int
    reason: str | None
    comment: str | None
    created_at: datetime
