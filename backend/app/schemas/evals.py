from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from app.schemas.base import APIModel

Suite = Literal["retrieval", "verdicts", "sql", "faithfulness", "safety", "e2e", "criteria"]


class EvalRunIn(APIModel):
    suite: Suite = "verdicts"
    limit: int | None = Field(default=None, ge=1, le=2000)
    live: bool = False  # True = call real LLM providers (spends free-tier quota)


class CriteriaPatch(APIModel):
    tree: dict[str, Any] | None = None
    status: Literal["draft", "needs_review", "approved", "rejected"] | None = None
    notes: str | None = Field(default=None, max_length=4000)
    force: bool = False  # approve even if some quotes fail grounding (recorded in audit)


class CompileIn(APIModel):
    policy_version_ids: list[str] | None = Field(default=None, max_length=200)
    source_keys: list[str] | None = Field(default=None, max_length=200)
    sync_curated: bool = False
