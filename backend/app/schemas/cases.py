"""Case-domain API schemas (contract §4.3) + analytics/activity shapes (§4.6)."""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import Field, field_validator

from app.schemas.base import APIModel
from app.schemas.platform import US_STATES

CaseStatus = Literal[
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
]
Priority = Literal["standard", "expedited"]
PayerType = Literal["medicare_ffs", "medicare_advantage", "commercial", "medicaid"]
DocumentKind = Literal[
    "clinical_note", "fhir_bundle", "pdf", "imaging_report", "therapy_note", "denial_letter", "other"
]

_HCPCS = re.compile(r"^[A-Z0-9]\d{3}[A-Z0-9]$")
_ICD10 = re.compile(r"^([A-TV-Z][0-9][0-9A-Z])\.?([0-9A-Z]{1,4})?$")


def normalize_service_codes(v: list[str]) -> list[str]:
    out: list[str] = []
    for raw in v:
        code = raw.strip().upper()
        if not _HCPCS.match(code):
            raise ValueError(f"'{raw}' is not a valid CPT/HCPCS code (5 characters, e.g. 29881 or E0601).")
        if code not in out:
            out.append(code)
    return out


def normalize_dx_codes(v: list[str]) -> list[str]:
    out: list[str] = []
    for raw in v:
        m = _ICD10.match(raw.strip().upper())
        if not m:
            raise ValueError(f"'{raw}' is not a valid ICD-10-CM code (e.g. M17.11).")
        code = m.group(1) + (f".{m.group(2)}" if m.group(2) else "")
        if code not in out:
            out.append(code)
    return out


def _state(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip().upper()
    if v not in US_STATES:
        raise ValueError(f"Unknown state code '{v}'.")
    return v


class PatientIn(APIModel):
    full_name: str = Field(min_length=1, max_length=200)
    dob: date
    sex: Literal["female", "male", "other", "unknown"] = "unknown"
    state: str | None = None
    member_id: str | None = Field(default=None, max_length=64)
    phone: str | None = Field(default=None, max_length=32)
    address: str | None = Field(default=None, max_length=300)

    _st = field_validator("state")(classmethod(lambda cls, v: _state(v)))


class PatientMini(APIModel):
    id: uuid.UUID
    display_name: str
    birth_year: int | None
    sex: str | None


class PatientOut(PatientMini):
    external_ref: str
    state: str | None
    source: str
    created_at: datetime
    demographics: dict[str, Any] | None = None  # only when revealed (audited)


class UserMini(APIModel):
    id: uuid.UUID
    full_name: str
    avatar_color: str


class CaseCreateIn(APIModel):
    patient_id: uuid.UUID | None = None
    patient: PatientIn | None = None
    title: str | None = Field(default=None, max_length=240)
    priority: Priority = "standard"
    payer_type: PayerType = "medicare_ffs"
    payer_name: str | None = Field(default=None, max_length=120)
    state: str | None = None
    service_codes: list[str] = Field(default_factory=list, max_length=20)
    dx_codes: list[str] = Field(default_factory=list, max_length=25)
    date_of_service: date | None = None
    place_of_service: str | None = Field(default=None, max_length=40)
    assignee_id: uuid.UUID | None = None
    tags: list[str] = Field(default_factory=list, max_length=20)

    _svc = field_validator("service_codes")(classmethod(lambda cls, v: normalize_service_codes(v)))
    _dx = field_validator("dx_codes")(classmethod(lambda cls, v: normalize_dx_codes(v)))
    _st = field_validator("state")(classmethod(lambda cls, v: _state(v)))


class CaseUpdateIn(APIModel):
    title: str | None = Field(default=None, max_length=240)
    status: CaseStatus | None = None
    status_reason: str | None = Field(default=None, max_length=500)
    priority: Priority | None = None
    payer_type: PayerType | None = None
    payer_name: str | None = Field(default=None, max_length=120)
    state: str | None = None
    service_codes: list[str] | None = None
    dx_codes: list[str] | None = None
    date_of_service: date | None = None
    place_of_service: str | None = Field(default=None, max_length=40)
    assignee_id: uuid.UUID | None = None
    tags: list[str] | None = None
    policy_refs: list[dict[str, Any]] | None = None

    @field_validator("service_codes")
    @classmethod
    def _svc(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else normalize_service_codes(v)

    @field_validator("dx_codes")
    @classmethod
    def _dx(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else normalize_dx_codes(v)

    _st = field_validator("state")(classmethod(lambda cls, v: _state(v)))


class CaseSummary(APIModel):
    id: uuid.UUID
    number: str
    title: str
    status: str
    priority: str
    payer_type: str
    payer_name: str | None
    state: str | None
    service_codes: list[str]
    dx_codes: list[str]
    date_of_service: date | None
    readiness: str
    readiness_score: float | None
    due_at: datetime | None
    assignee: UserMini | None
    patient: PatientMini
    updated_at: datetime


class CaseOut(CaseSummary):
    place_of_service: str | None
    policy_refs: list[dict[str, Any]]
    latest_evaluation_id: uuid.UUID | None
    outcome: str | None
    outcome_at: datetime | None
    submitted_at: datetime | None
    tags: list[str]
    documents_count: int
    created_by: uuid.UUID | None
    created_at: datetime
    allowed_transitions: list[str] = Field(default_factory=list)


class CaseStatsOut(APIModel):
    total: int
    by_status: dict[str, int]
    by_readiness: dict[str, int]
    by_priority: dict[str, int]
    overdue: int
    due_soon: int
    mine: int


class CaseDocumentOut(APIModel):
    id: uuid.UUID
    case_id: uuid.UUID
    kind: str
    filename: str
    mime: str
    size_bytes: int
    sha256: str
    page_count: int | None
    ocr_used: bool
    injection_score: float
    quarantined: bool
    note_date: date | None
    meta: dict[str, Any] = Field(default_factory=dict)
    uploaded_by: uuid.UUID | None
    created_at: datetime


class CaseDocumentDetailOut(CaseDocumentOut):
    text: str | None = None
    revealed: bool = False


class DocumentTextIn(APIModel):
    kind: DocumentKind = "clinical_note"
    text: str = Field(min_length=1, max_length=400_000)
    note_date: date | None = None
    title: str | None = Field(default=None, max_length=200)


class CaseEventOut(APIModel):
    id: uuid.UUID
    type: str
    payload: dict[str, Any]
    actor: UserMini | None
    created_at: datetime


class CommentIn(APIModel):
    body: str = Field(min_length=1, max_length=8000)


class OutcomeIn(APIModel):
    outcome: Literal["approved", "denied", "partial", "withdrawn"]
    note: str | None = Field(default=None, max_length=4000)


# ── Analytics ────────────────────────────────────────────────────────────────
class AnalyticsKpis(APIModel):
    open_cases: int
    due_soon: int
    ready_rate: float
    avg_readiness_score: float | None
    gaps_caught_pre_submission: int
    denied_cases: int
    appeals_overturned: int
    avg_turnaround_hours: float | None
    estimated_hours_saved: float


class AnalyticsOverviewOut(APIModel):
    range_days: int
    kpis: AnalyticsKpis
    trends: dict[str, list[dict[str, Any]]]
    top_gap_criteria: list[dict[str, Any]]
    denial_reasons: list[dict[str, Any]]
    payer_mix: list[dict[str, Any]]
    methodology: dict[str, str]


class TeamMemberLoad(APIModel):
    user: UserMini
    role: str
    open_cases: int
    due_soon: int
    overdue: int
    completed_30d: int


class ActivityItem(APIModel):
    id: str
    type: str
    message: str
    actor: UserMini | None
    case_id: uuid.UUID | None = None
    case_number: str | None = None
    created_at: datetime
