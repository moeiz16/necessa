"""Criteria tree schema — the machine-checkable form of a coverage policy.

A policy is compiled into a tree of logical operators (AND / OR / N_OF_M) whose leaves are atomic,
individually-evaluable criteria. Every leaf carries a verbatim `source_span` so a reviewer can find
the rule in the policy text, and so the compiler can *prove* it didn't invent the rule.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class Verdict(StrEnum):
    MET = "MET"
    NOT_MET = "NOT_MET"
    INSUFFICIENT = "INSUFFICIENT"


class CriterionKind(StrEnum):
    POSITIVE = "positive"  # something that must be documented as present/true
    NEGATIVE_ATTESTATION = "negative_attestation"  # "no X" — must be explicitly documented, never inferred
    DOCUMENTATION = "documentation"  # a document/record must exist (e.g. visual field test, photos)
    TEMPORAL = "temporal"  # duration / timing window (e.g. pain >= 3 months, re-eval day 31-91)
    NUMERIC = "numeric"  # threshold on a measurement (e.g. AHI >= 15, >= 50% relief)


class Readiness(StrEnum):
    UNKNOWN = "unknown"
    READY = "ready"
    GAPS = "gaps"
    NOT_SUPPORTED = "not_supported"


class SourceSpan(_Model):
    section_key: str = "indication"
    quote: str = Field(min_length=8)
    start: int | None = None
    end: int | None = None


class NumericRule(_Model):
    """Deterministic rule usable without an LLM (degraded mode) and as a cross-check of the judge."""

    measure: str  # e.g. "ahi", "pain_duration_months", "relief_percent", "visual_field_loss_degrees"
    op: Literal[">=", ">", "<=", "<", "==", "between"]
    value: float
    value_high: float | None = None
    unit: str | None = None
    patterns: list[str] = Field(default_factory=list)  # regexes with one numeric capture group

    @model_validator(mode="after")
    def _between(self) -> NumericRule:
        if self.op == "between" and self.value_high is None:
            raise ValueError("between requires value_high")
        return self


class SyntheticHints(_Model):
    """Text snippets used ONLY by the synthetic data / counterfactual eval generators."""

    present: list[str] = Field(default_factory=list)
    negated: list[str] = Field(default_factory=list)
    contradicted: list[str] = Field(default_factory=list)
    paraphrased: list[str] = Field(default_factory=list)


class CriterionLeaf(_Model):
    type: Literal["criterion"] = "criterion"
    id: str = Field(pattern=r"^[A-Z][A-Za-z0-9_.-]{0,15}$")
    text: str = Field(min_length=5, max_length=600)
    kind: CriterionKind = CriterionKind.POSITIVE
    evidence_type: list[str] = Field(default_factory=lambda: ["note"])
    lookback_days: int | None = Field(default=None, ge=1, le=3650)
    numeric: NumericRule | None = None
    keywords: list[str] = Field(default_factory=list)  # retrieval hints / lexical fallback
    suggested_fix: str | None = None  # what to add to the chart if this is a gap
    source_span: SourceSpan
    synthetic: SyntheticHints | None = None

    @field_validator("text")
    @classmethod
    def _strip(cls, v: str) -> str:
        return " ".join(v.split())


class CriteriaNode(_Model):
    type: Literal["node"] = "node"
    op: Literal["AND", "OR", "N_OF_M"]
    n: int | None = Field(default=None, ge=1)
    label: str | None = None
    children: list[Annotated[CriteriaNode | CriterionLeaf, Field(discriminator="type")]] = Field(min_length=1)

    @model_validator(mode="after")
    def _check_n(self) -> CriteriaNode:
        if self.op == "N_OF_M":
            if self.n is None:
                raise ValueError("N_OF_M requires n")
            if self.n > len(self.children):
                raise ValueError("N_OF_M n cannot exceed number of children")
        return self


TreeChild = Annotated[CriteriaNode | CriterionLeaf, Field(discriminator="type")]


class CriteriaTree(_Model):
    schema_version: int = 1
    policy_key: str  # source_key, e.g. "L33718"
    policy_version: int | None = None
    title: str
    scope: str | None = None  # which service/indication this tree covers (e.g. "Initial E0601 coverage")
    services: list[str] = Field(default_factory=list)  # HCPCS / CPT numbers this tree applies to
    synthetic: bool = False  # True for hand-written demo/fixture policies
    root: CriteriaNode
    notes: str | None = None
    # Optional inline policy text (synthetic fixture policies) — enables offline grounding checks.
    sections: dict[str, str] | None = None

    def leaves(self) -> list[CriterionLeaf]:
        return list(iter_leaves(self.root))

    @model_validator(mode="after")
    def _unique_ids(self) -> CriteriaTree:
        ids = [leaf.id for leaf in iter_leaves(self.root)]
        dupes = {i for i in ids if ids.count(i) > 1}
        if dupes:
            raise ValueError(f"duplicate criterion ids: {sorted(dupes)}")
        return self


CriteriaNode.model_rebuild()


def iter_leaves(node: CriteriaNode | CriterionLeaf):
    if isinstance(node, CriterionLeaf):
        yield node
        return
    for child in node.children:
        yield from iter_leaves(child)


def iter_leaves_with_path(node: CriteriaNode | CriterionLeaf, path: str = "0"):
    if isinstance(node, CriterionLeaf):
        yield path, node
        return
    for i, child in enumerate(node.children):
        yield from iter_leaves_with_path(child, f"{path}.{i}")


# ── Structured LLM outputs ─────────────────────────────────────────────────────────────────────


class EvidenceQuote(_Model):
    chunk_id: str
    quote: str = Field(min_length=3, max_length=800)


class CriterionVerdict(_Model):
    """What the `judge` model must return for ONE criterion."""

    verdict: Verdict
    evidence: list[EvidenceQuote] = Field(default_factory=list, max_length=6)
    rationale: str = Field(default="", max_length=600)
    confidence: float = Field(default=0.5, ge=0.0, le=1.0)


class EntailmentCheck(_Model):
    """What the `verifier` model returns: does the quoted evidence support the verdict?"""

    label: Literal["entails", "neutral", "contradicts"]
    reason: str = Field(default="", max_length=400)


class TreeResult(_Model):
    op: str | None = None
    n: int | None = None
    criterion_id: str | None = None
    text: str | None = None
    label: str | None = None
    verdict: Verdict
    children: list[TreeResult] | None = None


TreeResult.model_rebuild()


class Gap(_Model):
    criterion_id: str
    title: str
    detail: str
    severity: Literal["blocker", "major", "minor"]
    suggested_fix: str
    policy_quote: str | None = None
    policy_key: str | None = None
