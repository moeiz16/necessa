"""Calibration for the corrective/abstain thresholds used by the retriever's CRAG-style loop.

Thresholds are *calibrated per reranker* on labeled (query, chunk, relevant?) pairs from the eval set,
not guessed: τ_high is the lowest score at which precision ≥ target, τ_low the score below which
relevant hits are rare (recall loss ≤ max_miss). Results are written back to models.yaml thresholds.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Calibration:
    high: float
    low: float
    precision_at_high: float
    miss_rate_below_low: float
    n_pos: int
    n_neg: int


def calibrate(
    pos_scores: list[float], neg_scores: list[float], *, target_precision: float = 0.9, max_miss: float = 0.05
) -> Calibration:
    if not pos_scores:
        return Calibration(
            high=1.0, low=0.0, precision_at_high=0.0, miss_rate_below_low=0.0, n_pos=0, n_neg=len(neg_scores)
        )
    candidates = sorted(set(pos_scores + neg_scores))
    high = candidates[-1]
    prec_high = 1.0
    for t in candidates:
        tp = sum(1 for s in pos_scores if s >= t)
        fp = sum(1 for s in neg_scores if s >= t)
        if tp and tp / (tp + fp) >= target_precision:
            high, prec_high = t, tp / (tp + fp)
            break
    low = 0.0
    miss = 0.0
    for t in candidates:
        m = sum(1 for s in pos_scores if s < t) / len(pos_scores)
        if m > max_miss:
            break
        low, miss = t, m
    return Calibration(
        high=round(high, 4),
        low=round(min(low, high), 4),
        precision_at_high=round(prec_high, 4),
        miss_rate_below_low=round(miss, 4),
        n_pos=len(pos_scores),
        n_neg=len(neg_scores),
    )


def reliability_bins(scores: list[float], labels: list[bool], bins: int = 10) -> list[dict]:
    """Reliability diagram data (mean predicted score vs. empirical relevance per bin)."""
    out = []
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        idx = [i for i, s in enumerate(scores) if lo <= s < hi or (b == bins - 1 and s == 1.0)]
        if not idx:
            continue
        out.append(
            {
                "bin": f"{lo:.1f}-{hi:.1f}",
                "meanScore": round(sum(scores[i] for i in idx) / len(idx), 4),
                "relevantRate": round(sum(1 for i in idx if labels[i]) / len(idx), 4),
                "n": len(idx),
            }
        )
    return out
