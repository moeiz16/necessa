"""Case-AI request schemas (responses are contract-shaped dicts built in app/ai/agents/case_results.py)."""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import Field

from app.schemas.base import APIModel


class EvaluateIn(APIModel):
    policy_version_ids: list[str] | None = Field(default=None, max_length=10)


class EvaluateOut(APIModel):
    evaluation_id: str
    job_id: str


class OverrideIn(APIModel):
    override_verdict: Literal["MET", "NOT_MET", "INSUFFICIENT"] | None = None
    override_reason: str | None = Field(default=None, max_length=1000)


class DenialIn(APIModel):
    document_id: str | None = None
    text: str | None = Field(default=None, max_length=20_000)
    received_at: date | None = None
    carc_codes: list[str] = Field(default_factory=list, max_length=20)
    draft_appeal: bool = True


class DenialPatch(APIModel):
    status: Literal["new", "analyzing", "appeal_drafted", "appealed", "overturned", "upheld"] | None = None
    appeal_deadline: date | None = None
    category: (
        Literal[
            "medical_necessity",
            "documentation",
            "coding",
            "eligibility",
            "timely_filing",
            "prior_authorization",
            "other",
        ]
        | None
    ) = None
    reason_text: str | None = Field(default=None, max_length=20_000)
