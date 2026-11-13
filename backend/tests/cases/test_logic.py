"""Kleene three-valued aggregation, guards and gap computation."""

from __future__ import annotations

import itertools

import pytest

from app.ai.compiler.logic import (
    completeness_score,
    compute_gaps,
    evaluate_tree,
    guard_leaf_verdict,
    kleene_and,
    kleene_or,
    n_of_m,
    readiness_of,
    summarize,
)
from app.ai.compiler.schema import CriteriaNode, CriteriaTree, CriterionLeaf, Readiness, SourceSpan, Verdict

M, N, U = Verdict.MET, Verdict.NOT_MET, Verdict.INSUFFICIENT
ALL = [M, N, U]


def leaf(i: str, kind: str = "positive") -> CriterionLeaf:
    return CriterionLeaf(
        id=i,
        text=f"criterion {i} text",
        kind=kind,
        source_span=SourceSpan(section_key="indication", quote=f"quote for criterion {i}"),
    )


@pytest.mark.parametrize("a,b", list(itertools.product(ALL, ALL)))
def test_kleene_and_truth_table(a, b):
    expected = N if N in (a, b) else (U if U in (a, b) else M)
    assert kleene_and([a, b]) == expected


@pytest.mark.parametrize("a,b", list(itertools.product(ALL, ALL)))
def test_kleene_or_truth_table(a, b):
    expected = M if M in (a, b) else (U if U in (a, b) else N)
    assert kleene_or([a, b]) == expected


def test_kleene_laws_hold_for_all_triples():
    for a, b, c in itertools.product(ALL, repeat=3):
        assert kleene_and([a, b, c]) == kleene_and([kleene_and([a, b]), c])
        assert kleene_or([a, b, c]) == kleene_or([a, kleene_or([b, c])])
        assert kleene_and([a, b]) == kleene_and([b, a])


@pytest.mark.parametrize(
    "vals,n,expected",
    [
        ([M, M, N], 2, M),
        ([M, N, N], 2, N),
        ([M, U, N], 2, U),
        ([U, U, U], 1, U),
        ([N, N, N], 1, N),
        ([M, U, U], 3, U),
        ([M, M, M], 3, M),
    ],
)
def test_n_of_m(vals, n, expected):
    assert n_of_m(n, vals) == expected


def test_empty_is_insufficient():
    assert kleene_and([]) == U and kleene_or([]) == U


def test_negative_attestation_never_met_without_evidence():
    neg = leaf("C9", "negative_attestation")
    assert guard_leaf_verdict(neg, M, has_valid_evidence=False) == U
    assert guard_leaf_verdict(neg, M, has_valid_evidence=True) == M
    # any MET/NOT_MET without verified evidence is downgraded
    assert guard_leaf_verdict(leaf("C1"), M, has_valid_evidence=False) == U
    assert guard_leaf_verdict(leaf("C1"), N, has_valid_evidence=False) == U
    assert guard_leaf_verdict(leaf("C1"), U, has_valid_evidence=False) == U


def _tree() -> CriteriaTree:
    return CriteriaTree(
        policy_key="LTEST",
        title="Test",
        root=CriteriaNode(
            op="AND",
            children=[
                leaf("C1"),
                CriteriaNode(
                    op="OR", children=[leaf("C2"), CriteriaNode(op="AND", children=[leaf("C3"), leaf("C4")])]
                ),
                leaf("C5", "negative_attestation"),
            ],
        ),
    )


def test_evaluate_tree_and_readiness():
    t = _tree()
    assert evaluate_tree(t.root, {"C1": M, "C2": M, "C5": M}).verdict == M
    assert evaluate_tree(t.root, {"C1": M, "C3": M, "C4": M, "C5": M}).verdict == M
    assert evaluate_tree(t.root, {"C1": M, "C2": N, "C3": M, "C5": M}).verdict == U  # C4 unknown
    assert evaluate_tree(t.root, {"C1": N, "C2": M, "C5": M}).verdict == N
    assert readiness_of(evaluate_tree(t.root, {"C1": N})) == Readiness.NOT_SUPPORTED
    assert readiness_of(evaluate_tree(t.root, {})) == Readiness.GAPS


def test_completeness_score_bounds():
    t = _tree()
    assert completeness_score(t.root, {}) == 0.0
    assert completeness_score(t.root, {"C1": M, "C2": M, "C5": M}) == 1.0
    assert 0 < completeness_score(t.root, {"C1": M}) < 1


def test_gaps_prioritized_and_satisfied_branches_skipped():
    t = _tree()
    gaps = compute_gaps(t, {"C1": N, "C2": M})
    ids = [g.criterion_id for g in gaps]
    assert "C2" not in ids and "C3" not in ids and "C4" not in ids  # OR satisfied by C2
    assert gaps[0].criterion_id == "C1" and gaps[0].severity == "blocker"
    assert any(g.criterion_id == "C5" and "explicit" in g.suggested_fix.lower() for g in gaps)


def test_summarize_qualifies_ids_across_policies():
    a, b = _tree(), _tree().model_copy(update={"policy_key": "LOTHER"})
    verdicts = {"LTEST:C1": M, "LTEST:C2": M, "LTEST:C5": M, "LOTHER:C1": M}
    root, readiness, score = summarize([a, b], verdicts)
    assert root.op == "AND" and readiness == Readiness.GAPS
    assert root.children[0].verdict == M and root.children[1].verdict == U
    assert 0 < score < 1


def test_tree_validation_rejects_duplicates_and_bad_n():
    with pytest.raises(ValueError):
        CriteriaTree(
            policy_key="X", title="x", root=CriteriaNode(op="AND", children=[leaf("C1"), leaf("C1")])
        )
    with pytest.raises(ValueError):
        CriteriaNode(op="N_OF_M", n=3, children=[leaf("C1"), leaf("C2")])
