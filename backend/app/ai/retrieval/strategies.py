"""Retrieval strategy matrix (docs/PROBLEM_STATEMENT.md §9.2): which channels, weights and
transforms each intent uses. Weights are starting points tuned by the eval harness (grid search
over the gold set), not guesses carved in stone — see eval/ for the sweep.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class StrategyConfig:
    code: str
    intent: str
    label: str
    weights: dict[str, float] = field(default_factory=dict)  # dense / sparse / fts
    fusion: str = "rrf"
    rerank: bool = True
    expand_synonyms: bool = False
    hyde: bool = False
    decompose: bool = False
    sql_exact: bool = False
    tools: tuple[str, ...] = ()
    text_to_sql: bool = False
    abstain: bool = False
    candidates: int = 40
    section_boost: tuple[str, ...] = ()


STRATEGIES: dict[str, StrategyConfig] = {
    "exact_lookup": StrategyConfig(
        "S1",
        "exact_lookup",
        "Exact identifier lookup (SQL → sparse)",
        weights={"sparse": 0.6, "fts": 0.4, "dense": 0.0},
        sql_exact=True,
        rerank=False,
        candidates=30,
    ),
    "structured_fact": StrategyConfig(
        "S2",
        "structured_fact",
        "Structured fact via tools/graph (+ sparse context)",
        weights={"sparse": 0.5, "fts": 0.3, "dense": 0.2},
        tools=("find_policies_by_code", "covered_dx_for_policy", "coverage_graph"),
        candidates=30,
    ),
    "analytics": StrategyConfig(
        "S3",
        "analytics",
        "Text-to-SQL over allowlisted views",
        weights={},
        rerank=False,
        text_to_sql=True,
        candidates=0,
    ),
    "conceptual": StrategyConfig(
        "S4",
        "conceptual",
        "Hybrid dense + sparse + FTS → RRF → rerank",
        weights={"dense": 0.5, "sparse": 0.35, "fts": 0.15},
    ),
    "lay_language": StrategyConfig(
        "S5",
        "lay_language",
        "Dense-weighted hybrid + synonym expansion (+HyDE)",
        weights={"dense": 0.7, "sparse": 0.2, "fts": 0.1},
        expand_synonyms=True,
        hyde=True,
    ),
    "keyword_heavy": StrategyConfig(
        "S6",
        "keyword_heavy",
        "Sparse-weighted hybrid (rare tokens / codes)",
        weights={"sparse": 0.6, "fts": 0.25, "dense": 0.15},
    ),
    "chart_evidence": StrategyConfig(
        "S7",
        "chart_evidence",
        "Per-case chart hybrid (dense + sparse, temporal)",
        weights={"dense": 0.5, "sparse": 0.5},
        candidates=30,
    ),
    "multi_hop": StrategyConfig(
        "S8",
        "multi_hop",
        "Decompose → structured + hybrid sub-queries → merge",
        weights={"dense": 0.45, "sparse": 0.4, "fts": 0.15},
        decompose=True,
        tools=("find_policies_by_code", "covered_dx_for_policy"),
    ),
    "version_compare": StrategyConfig(
        "S9",
        "version_compare",
        "Version table + section diff + hybrid in versions",
        weights={"sparse": 0.5, "dense": 0.3, "fts": 0.2},
        tools=("policy_versions", "section_diff"),
        section_boost=("revision_history", "synopsis_changes"),
    ),
    "denial_mapping": StrategyConfig(
        "S10",
        "denial_mapping",
        "Denial reason → criteria / documentation sections",
        weights={"dense": 0.5, "sparse": 0.35, "fts": 0.15},
        section_boost=("doc_reqs", "indication", "limitations"),
    ),
    "out_of_scope": StrategyConfig(
        "S11",
        "out_of_scope",
        "Abstain (policy enforcement)",
        weights={},
        rerank=False,
        abstain=True,
        candidates=0,
    ),
}

BY_CODE = {s.code: s for s in STRATEGIES.values()}


def get_strategy(name_or_code: str) -> StrategyConfig:
    if name_or_code in STRATEGIES:
        return STRATEGIES[name_or_code]
    if name_or_code.upper() in BY_CODE:
        return BY_CODE[name_or_code.upper()]
    raise KeyError(f"unknown strategy {name_or_code}")


# Source authority for trust weighting (Medicare questions): NCD > LCD > B&C article > article > payer.
AUTHORITY = {
    "NCD": 1.0,
    "LCD": 0.95,
    "Billing and Coding": 0.9,
    "Article": 0.85,
    "Response to Comments": 0.6,
    "FAQ": 0.7,
    "Payer Policy": 0.9,
}
