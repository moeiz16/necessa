"""Knowledge-base API schemas (camelCase on the wire)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import Field

from app.schemas.base import APIModel


class MatchReason(APIModel):
    type: Literal["hcpcs", "icd10", "state", "contractor", "link", "national", "payer", "dx_warning"]
    value: str
    detail: str = ""


class ContractorRef(APIModel):
    id: int
    name: str


class PolicyMatchDTO(APIModel):
    policy_id: str
    policy_version_id: str
    source_key: str
    title: str
    doc_type: str
    version: int
    effective_from: date | None = None
    effective_to: date | None = None
    match_reasons: list[MatchReason] = Field(default_factory=list)
    score: float = 0.0
    contractor: ContractorRef | None = None
    criteria_set_status: str | None = None
    url: str | None = None
    dx_status: dict[str, str] = Field(default_factory=dict)


class PolicySummary(APIModel):
    id: str
    source_key: str
    title: str
    doc_type: str
    status: str
    version: int | None = None
    effective_from: date | None = None
    effective_to: date | None = None
    contractors: list[ContractorRef] = Field(default_factory=list)
    states: list[str] = Field(default_factory=list)
    code_count: int = 0
    has_criteria: bool = False
    snippet: str | None = None
    score: float | None = None
    url: str | None = None


class PolicySection(APIModel):
    id: str
    section_key: str
    title: str
    text: str
    ordinal: int


class PolicyVersionSummary(APIModel):
    id: str
    version: int
    effective_from: date | None = None
    effective_to: date | None = None
    retired_at: date | None = None
    last_updated: datetime | None = None
    is_current: bool = False


class LinkedDoc(APIModel):
    source_key: str
    title: str | None = None
    doc_type: str | None = None
    relation: str
    policy_id: str | None = None


class PolicyDetail(PolicySummary):
    url: str | None = None
    keywords: str | None = None
    current_version: PolicyVersionSummary | None = None
    sections: list[PolicySection] = Field(default_factory=list)
    linked: list[LinkedDoc] = Field(default_factory=list)
    versions: list[PolicyVersionSummary] = Field(default_factory=list)
    code_counts: dict[str, int] = Field(default_factory=dict)
    raw: dict[str, Any] = Field(default_factory=dict)
    synthetic: bool = False


class PolicyVersionDetail(PolicyVersionSummary):
    policy_id: str
    sections: list[PolicySection] = Field(default_factory=list)


class DiffHunk(APIModel):
    op: Literal["equal", "insert", "delete"]
    text: str


class SectionDiff(APIModel):
    section_key: str
    title: str
    status: Literal["added", "removed", "changed", "same"]
    hunks: list[DiffHunk] = Field(default_factory=list)


class PolicyDiff(APIModel):
    policy_id: str
    from_version: int
    to_version: int
    sections: list[SectionDiff]


class PolicyCodeOut(APIModel):
    code_system: str
    code: str
    group_no: int
    description: str | None = None
    is_range: bool = False


class CodeOut(APIModel):
    system: str
    code: str
    short_desc: str | None = None
    long_desc: str | None = None


class CodeDetail(CodeOut):
    policies: list[dict] = Field(default_factory=list)


class GraphNode(APIModel):
    id: str
    type: Literal["code", "article", "lcd", "ncd", "payer", "contractor", "state", "version"]
    label: str
    meta: dict = Field(default_factory=dict)


class GraphEdge(APIModel):
    source: str
    target: str
    type: str


class CoverageGraph(APIModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    stats: dict = Field(default_factory=dict)


class KnowledgeStats(APIModel):
    policies: dict[str, int]
    versions: int
    chunks: int
    codes: int
    last_ingestion: dict | None = None
    active_index: dict | None = None
    freshness_days: float | None = None


class RetrieveRequest(APIModel):
    query: str = Field(min_length=1, max_length=2000)
    scope: Literal["policy", "criteria", "chart"] = "policy"
    filters: dict = Field(default_factory=dict)
    strategy: str | None = None
    top_k: int = Field(8, ge=1, le=30)
    case_id: str | None = None


class IngestionRunIn(APIModel):
    source: Literal["mcd", "codesets", "fixtures"] = "fixtures"
    scope: Literal["focus", "full"] = "focus"
    policy_keys: list[str] | None = None
    limit: int | None = Field(None, ge=1, le=5000)


class IngestionRunOut(APIModel):
    id: str
    source: str
    scope: dict
    status: str
    stats: dict
    error: str | None = None
    started_at: datetime
    finished_at: datetime | None = None
    job_id: str | None = None


class IndexVersionOut(APIModel):
    id: str
    alias: str
    physical_name: str
    embed_model: str | None
    dims: int
    sparse_model: str
    status: str
    points: int
    stats: dict
    created_at: datetime
    activated_at: datetime | None = None
