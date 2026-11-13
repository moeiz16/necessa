"""Rank / score fusion methods (chosen per strategy, compared in benchmarks).

* `rrf`: Σ w_i / (k + rank_i)  — robust when score scales differ (dense cosine vs BM25 vs ts_rank).
* `normalized`: convex combination of min-max or z-score normalized scores.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

RRF_K = 60


def rrf(
    rankings: Mapping[str, Sequence[str]], weights: Mapping[str, float] | None = None, k: int = RRF_K
) -> dict[str, float]:
    """rankings: channel -> ordered ids (best first)."""
    out: dict[str, float] = {}
    for channel, ids in rankings.items():
        w = 1.0 if weights is None else float(weights.get(channel, 0.0))
        if w <= 0:
            continue
        seen: set[str] = set()
        for rank, doc_id in enumerate(ids, start=1):
            if doc_id in seen:
                continue
            seen.add(doc_id)
            out[doc_id] = out.get(doc_id, 0.0) + w / (k + rank)
    return out


def _minmax(scores: Mapping[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    lo, hi = min(scores.values()), max(scores.values())
    if math.isclose(hi, lo):
        return dict.fromkeys(scores, 1.0)
    return {k: (v - lo) / (hi - lo) for k, v in scores.items()}


def _zscore(scores: Mapping[str, float]) -> dict[str, float]:
    if not scores:
        return {}
    vals = list(scores.values())
    mu = sum(vals) / len(vals)
    sd = math.sqrt(sum((v - mu) ** 2 for v in vals) / len(vals)) or 1.0
    # squash to (0,1) so channels combine on a comparable scale
    return {k: 1 / (1 + math.exp(-(v - mu) / sd)) for k, v in scores.items()}


def normalized(
    channel_scores: Mapping[str, Mapping[str, float]], weights: Mapping[str, float], method: str = "minmax"
) -> dict[str, float]:
    norm = _minmax if method == "minmax" else _zscore
    out: dict[str, float] = {}
    total_w = sum(w for w in weights.values() if w > 0) or 1.0
    for channel, scores in channel_scores.items():
        w = float(weights.get(channel, 0.0))
        if w <= 0:
            continue
        for doc_id, s in norm(scores).items():
            out[doc_id] = out.get(doc_id, 0.0) + (w / total_w) * s
    return out


def fuse(
    channel_hits: Mapping[str, Sequence[tuple[str, float]]], weights: Mapping[str, float], method: str = "rrf"
) -> list[tuple[str, float]]:
    """channel_hits: channel -> [(id, raw_score)] best first. Returns [(id, fused)] best first."""
    if method == "rrf":
        fused = rrf({c: [i for i, _ in hits] for c, hits in channel_hits.items()}, weights)
    elif method in {"minmax", "zscore"}:
        fused = normalized({c: dict(hits) for c, hits in channel_hits.items()}, weights, method)
    else:
        raise ValueError(f"unknown fusion method {method}")
    return sorted(fused.items(), key=lambda kv: -kv[1])
