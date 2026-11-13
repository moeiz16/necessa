"""Retrieval data contracts (docs/API_CONTRACT.md §6)."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Literal
from uuid import UUID


@dataclass
class PolicyFilters:
    as_of: date | None = None
    states: list[str] | None = None
    payer_type: str | None = None
    contractor_ids: list[int] | None = None
    doc_types: list[str] | None = None
    codes: list[str] | None = None
    policy_version_ids: list[str] | None = None
    section_keys: list[str] | None = None
    source_keys: list[str] | None = None
    include_history: bool = False


@dataclass
class RetrievalQuery:
    text: str
    org_id: UUID | None
    scope: Literal["policy", "criteria", "chart"] = "policy"
    filters: PolicyFilters = field(default_factory=PolicyFilters)
    case_id: UUID | None = None
    top_k: int = 8
    strategy: str | None = None
    lookback_days: int | None = None
    trace: bool = True
    allow_corrective: bool = True


@dataclass
class RetrievedChunk:
    chunk_id: str
    text: str
    header: str
    score: float
    scores: dict[str, float]
    source: dict
    char_start: int | None = None
    char_end: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class RouteTrace:
    intent: str
    confidence: float
    strategy: str
    transforms: list[str] = field(default_factory=list)
    filters_applied: dict = field(default_factory=dict)
    retrievers: list[str] = field(default_factory=list)
    fusion: str = "rrf"
    rerank: str | None = None
    corrective_iterations: int = 0
    abstained: bool = False
    reason: str = ""
    degraded: list[str] = field(default_factory=list)
    candidates: int = 0
    entities: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class RetrievalResult:
    chunks: list[RetrievedChunk]
    route: RouteTrace
    timings: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "chunks": [c.to_dict() for c in self.chunks],
            "route": self.route.to_dict(),
            "timings": self.timings,
        }
