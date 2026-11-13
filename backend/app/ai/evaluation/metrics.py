"""Metric math — pure functions, unit-tested (tests/cases/test_eval_metrics.py)."""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

LABELS = ("MET", "NOT_MET", "INSUFFICIENT")


# ── retrieval ──────────────────────────────────────────────────────────────────────────────────


def _dedup(seq: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    out = []
    for s in seq:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


def recall_at_k(retrieved: Sequence[str], relevant: Iterable[str], k: int) -> float:
    rel = set(relevant)
    if not rel:
        return 0.0
    return len(set(_dedup(retrieved)[:k]) & rel) / len(rel)


def precision_at_k(retrieved: Sequence[str], relevant: Iterable[str], k: int) -> float:
    rel = set(relevant)
    top = _dedup(retrieved)[:k]
    if not top:
        return 0.0
    return sum(1 for r in top if r in rel) / len(top)


def hit_rate_at_k(retrieved: Sequence[str], relevant: Iterable[str], k: int) -> float:
    return 1.0 if set(_dedup(retrieved)[:k]) & set(relevant) else 0.0


def reciprocal_rank(retrieved: Sequence[str], relevant: Iterable[str]) -> float:
    rel = set(relevant)
    for i, r in enumerate(_dedup(retrieved), start=1):
        if r in rel:
            return 1.0 / i
    return 0.0


def ndcg_at_k(retrieved: Sequence[str], relevance: dict[str, float] | Iterable[str], k: int) -> float:
    """Graded nDCG (pass a {key: gain} dict) or binary nDCG (pass an iterable of relevant keys)."""
    gains = relevance if isinstance(relevance, dict) else {r: 1.0 for r in relevance}
    top = _dedup(retrieved)[:k]
    dcg = sum(gains.get(r, 0.0) / math.log2(i + 2) for i, r in enumerate(top))
    ideal = sorted(gains.values(), reverse=True)[:k]
    idcg = sum(g / math.log2(i + 2) for i, g in enumerate(ideal))
    return dcg / idcg if idcg > 0 else 0.0


# ── verdict classification ─────────────────────────────────────────────────────────────────────


def is_correct(pred: str, acceptable: Iterable[str]) -> bool:
    return pred in set(acceptable)


def confusion(preds: Sequence[str], truths: Sequence[str]) -> dict[str, dict[str, int]]:
    m = {t: {p: 0 for p in LABELS} for t in LABELS}
    for p, t in zip(preds, truths, strict=True):
        m[t][p] += 1
    return m


def macro_f1(preds: Sequence[str], primaries: Sequence[str], acceptables: Sequence[Iterable[str]]) -> float:
    """Macro-F1 where a prediction inside the item's acceptable set counts as the correct label."""
    truths = [
        p if is_correct(p, acc) else prim for p, prim, acc in zip(preds, primaries, acceptables, strict=True)
    ]
    f1s = []
    for label in LABELS:
        tp = sum(1 for p, t in zip(preds, truths, strict=True) if p == label and t == label)
        fp = sum(1 for p, t in zip(preds, truths, strict=True) if p == label and t != label)
        fn = sum(1 for p, t in zip(preds, truths, strict=True) if p != label and t == label)
        if tp + fp + fn == 0:
            continue
        prec = tp / (tp + fp) if tp + fp else 0.0
        rec = tp / (tp + fn) if tp + fn else 0.0
        f1s.append(2 * prec * rec / (prec + rec) if prec + rec else 0.0)
    return sum(f1s) / len(f1s) if f1s else 0.0


def false_met_rate(preds: Sequence[str], acceptables: Sequence[Iterable[str]]) -> float:
    """Share of items whose truth is NOT MET-compatible that the system called MET — the north-star safety metric."""  # noqa: E501
    negatives = [(p, set(a)) for p, a in zip(preds, acceptables, strict=True) if "MET" not in set(a)]
    if not negatives:
        return 0.0
    return sum(1 for p, _ in negatives if p == "MET") / len(negatives)


def insufficient_recall(preds: Sequence[str], acceptables: Sequence[Iterable[str]]) -> float:
    """Among items whose ONLY correct answer is INSUFFICIENT (nothing documented / out of window), the share
    the system also called INSUFFICIENT — i.e. it abstains instead of guessing."""
    idx = [i for i, a in enumerate(acceptables) if set(a) == {"INSUFFICIENT"}]
    if not idx:
        return 1.0
    return sum(1 for i in idx if preds[i] == "INSUFFICIENT") / len(idx)


def expected_calibration_error(
    confidences: Sequence[float], correct: Sequence[bool], bins: int = 10
) -> float:
    if not confidences:
        return 0.0
    total, ece = len(confidences), 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        idx = [i for i, c in enumerate(confidences) if (lo < c <= hi) or (b == 0 and c == 0.0)]
        if not idx:
            continue
        acc = sum(1 for i in idx if correct[i]) / len(idx)
        conf = sum(confidences[i] for i in idx) / len(idx)
        ece += len(idx) / total * abs(acc - conf)
    return ece


# ── SQL ────────────────────────────────────────────────────────────────────────────────────────


def _norm_cell(v) -> object:
    if isinstance(v, float):
        return round(v, 4)
    if v is None:
        return None
    return str(v) if not isinstance(v, int | bool) else v


def result_sets_equal(a: Sequence[Sequence], b: Sequence[Sequence], *, ordered: bool = False) -> bool:
    ra = [tuple(_norm_cell(x) for x in row) for row in a]
    rb = [tuple(_norm_cell(x) for x in row) for row in b]
    if ordered:
        return ra == rb
    return sorted(ra, key=repr) == sorted(rb, key=repr)


# ── misc ───────────────────────────────────────────────────────────────────────────────────────


def percentile(values: Sequence[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * p
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return float(s[int(k)])
    return float(s[f] + (s[c] - s[f]) * (k - f))


def mean(values: Iterable[float]) -> float:
    vals = list(values)
    return sum(vals) / len(vals) if vals else 0.0
