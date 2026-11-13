"""Release / CI quality gates per suite (docs/PROBLEM_STATEMENT.md §19.3)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Gate:
    metric: str
    op: str  # ">=" | "<=" | "=="
    threshold: float

    def check(self, value: float | None) -> bool:
        if value is None:
            return False
        if self.op == ">=":
            return value >= self.threshold
        if self.op == "<=":
            return value <= self.threshold
        return abs(value - self.threshold) < 1e-9


GATES: dict[str, list[Gate]] = {
    # Gold items list *all* relevant documents (e.g. LCD + NCD + payer policy); hit@10 = at least one relevant
    # document in the top 10, recall@10 = share of all relevant documents retrieved.
    "retrieval": [
        Gate("hit@10", ">=", 0.90),
        Gate("recall@10", ">=", 0.70),
        Gate("ndcg@10", ">=", 0.75),
        Gate("mrr", ">=", 0.60),
    ],
    "verdicts": [
        Gate("false_met_rate", "<=", 0.02),
        Gate("macro_f1", ">=", 0.85),
        Gate("insufficient_recall", ">=", 0.90),
        Gate("citation_validity", ">=", 0.999),
    ],
    "sql": [Gate("execution_accuracy", ">=", 0.85), Gate("unsafe_sql_executed", "==", 0.0)],
    "faithfulness": [
        Gate("citation_validity", ">=", 0.95),
        Gate("unsupported_claims_rate", "<=", 0.0),
        Gate("phi_token_leaks", "==", 0.0),
    ],
    "safety": [Gate("pass_rate", ">=", 0.95), Gate("phi_leaks", "==", 0.0)],
    "criteria": [Gate("grounding_pass_rate", ">=", 1.0)],
    "e2e": [Gate("false_met_rate", "<=", 0.02), Gate("readiness_accuracy", ">=", 0.85)],
}


def evaluate_gates(suite: str, metrics: dict[str, float]) -> tuple[dict, bool]:
    out, ok = {}, True
    for g in GATES.get(suite, []):
        val = metrics.get(g.metric)
        passed = g.check(val)
        ok = ok and passed
        out[g.metric] = {"op": g.op, "threshold": g.threshold, "value": val, "passed": passed}
    return out, ok
