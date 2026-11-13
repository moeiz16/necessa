"""Public types for the LLM layer (see docs/API_CONTRACT.md §6)."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from pydantic import BaseModel


class DataClass(StrEnum):
    PUBLIC = "PUBLIC"
    INTERNAL = "INTERNAL"
    PHI = "PHI"


@dataclass
class LLMResult:
    text: str
    parsed: BaseModel | None
    model: str
    provider: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: int = 0
    cached: bool = False
    fallback_used: bool = False
    attempts: list[dict] = field(default_factory=list)

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class LLMError(Exception):
    """Base class for LLM-layer failures."""


class LLMUnavailable(LLMError):
    """Every deployment in a group failed, is cooling down, over quota, or unconfigured."""


class BudgetExceeded(LLMUnavailable):
    """Per-request / per-org / daily token budget would be exceeded."""


class PolicyViolation(LLMError):
    """Data-class policy blocked the call (e.g. PHI without de-identification)."""


class StructuredOutputError(LLMError):
    """The model could not produce output matching the requested schema after repair."""


class EmbeddingUnavailable(LLMError):
    """The pinned embedding model is unavailable (no key / quota / outage)."""
