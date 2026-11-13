import math

from app.ai.evaluation import metrics as M
from app.ai.evaluation.gates import evaluate_gates


def test_retrieval_metrics():
    ret = ["A", "B", "C", "D"]
    assert M.recall_at_k(ret, ["B", "Z"], 2) == 0.5
    assert M.precision_at_k(ret, ["B", "Z"], 2) == 0.5
    assert M.hit_rate_at_k(ret, ["D"], 3) == 0.0 and M.hit_rate_at_k(ret, ["D"], 4) == 1.0
    assert M.reciprocal_rank(ret, ["C"]) == 1 / 3
    assert math.isclose(M.ndcg_at_k(["A", "B"], ["A", "B"], 2), 1.0)
    assert M.ndcg_at_k(["B", "A"], {"A": 1.0, "B": 0.5}, 2) < 1.0
    assert M.recall_at_k(["A", "A", "B"], ["A", "B"], 2) == 1.0  # duplicates collapse


def test_verdict_metrics():
    preds = ["MET", "INSUFFICIENT", "NOT_MET", "MET"]
    prims = ["MET", "INSUFFICIENT", "INSUFFICIENT", "INSUFFICIENT"]
    accs = [{"MET"}, {"INSUFFICIENT"}, {"NOT_MET", "INSUFFICIENT"}, {"INSUFFICIENT"}]
    assert M.false_met_rate(preds, accs) == 1 / 3
    assert M.insufficient_recall(preds, accs) == 0.5  # items whose only correct label is INSUFFICIENT
    assert 0 < M.macro_f1(preds, prims, accs) < 1
    assert M.macro_f1(["MET", "NOT_MET"], ["MET", "NOT_MET"], [{"MET"}, {"NOT_MET"}]) == 1.0


def test_ece():
    assert M.expected_calibration_error([0.9, 0.9], [True, True]) < 0.11
    assert M.expected_calibration_error([0.9, 0.9], [False, False]) > 0.8


def test_result_sets_and_percentiles():
    assert M.result_sets_equal([(1, "a"), (2, "b")], [[2, "b"], [1, "a"]])
    assert not M.result_sets_equal([(1, "a"), (2, "b")], [[2, "b"], [1, "a"]], ordered=True)
    assert M.result_sets_equal([(0.33333,)], [(0.333331,)])
    assert M.percentile([1, 2, 3, 4], 0.5) == 2.5


def test_gates():
    gates, ok = evaluate_gates(
        "verdicts",
        {"false_met_rate": 0.0, "macro_f1": 0.9, "insufficient_recall": 0.95, "citation_validity": 1.0},
    )
    assert ok and all(g["passed"] for g in gates.values())
    _, ok = evaluate_gates("verdicts", {"false_met_rate": 0.05})
    assert not ok
