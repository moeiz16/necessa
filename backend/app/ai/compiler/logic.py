"""Deterministic aggregation of criterion verdicts — Kleene strong three-valued logic.

MET = true, NOT_MET = false, INSUFFICIENT = unknown.

    AND: any NOT_MET → NOT_MET; else any INSUFFICIENT → INSUFFICIENT; else MET
    OR : any MET → MET; else any INSUFFICIENT → INSUFFICIENT; else NOT_MET
    N_OF_M(n): #MET ≥ n → MET; #MET + #INSUFFICIENT < n → NOT_MET; else INSUFFICIENT

The LLM never decides the overall result. It only judges atomic criteria; this module (pure code,
exhaustively unit-tested) combines them. Missing evidence therefore can never silently become MET.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from app.ai.compiler.schema import (
    CriteriaNode,
    CriteriaTree,
    CriterionKind,
    CriterionLeaf,
    Gap,
    Readiness,
    TreeResult,
    Verdict,
)

M, N, U = Verdict.MET, Verdict.NOT_MET, Verdict.INSUFFICIENT


def kleene_and(values: Iterable[Verdict]) -> Verdict:
    vals = list(values)
    if not vals:
        return U
    if any(v == N for v in vals):
        return N
    if any(v == U for v in vals):
        return U
    return M


def kleene_or(values: Iterable[Verdict]) -> Verdict:
    vals = list(values)
    if not vals:
        return U
    if any(v == M for v in vals):
        return M
    if any(v == U for v in vals):
        return U
    return N


def n_of_m(n: int, values: Iterable[Verdict]) -> Verdict:
    vals = list(values)
    met = sum(1 for v in vals if v == M)
    unknown = sum(1 for v in vals if v == U)
    if met >= n:
        return M
    if met + unknown < n:
        return N
    return U


def guard_leaf_verdict(leaf: CriterionLeaf, verdict: Verdict, has_valid_evidence: bool) -> Verdict:
    """Policy-level invariants applied to every judged leaf before aggregation.

    * MET and NOT_MET both require at least one verified evidence quote — otherwise INSUFFICIENT.
    * A negative attestation ("no active infection") can only be MET by an explicit documented
      statement; absence of evidence is never evidence of absence.
    """
    if verdict in (M, N) and not has_valid_evidence:
        return U
    if leaf.kind == CriterionKind.NEGATIVE_ATTESTATION and verdict == M and not has_valid_evidence:
        return U
    return verdict


def evaluate_tree(node: CriteriaNode | CriterionLeaf, verdicts: Mapping[str, Verdict]) -> TreeResult:
    if isinstance(node, CriterionLeaf):
        return TreeResult(criterion_id=node.id, text=node.text, verdict=verdicts.get(node.id, U))
    children = [evaluate_tree(c, verdicts) for c in node.children]
    vals = [c.verdict for c in children]
    if node.op == "AND":
        v = kleene_and(vals)
    elif node.op == "OR":
        v = kleene_or(vals)
    else:
        v = n_of_m(node.n or 1, vals)
    return TreeResult(op=node.op, n=node.n, label=node.label, verdict=v, children=children)


def combine_policies(results: list[TreeResult]) -> TreeResult:
    """Multiple applicable policies (e.g. an LCD plus an NCD) must all be satisfied."""
    if len(results) == 1:
        return results[0]
    return TreeResult(
        op="AND",
        label="All applicable policies",
        verdict=kleene_and(r.verdict for r in results),
        children=results,
    )


def readiness_of(root: TreeResult) -> Readiness:
    return {M: Readiness.READY, N: Readiness.NOT_SUPPORTED, U: Readiness.GAPS}[root.verdict]


def completeness_score(node: CriteriaNode | CriterionLeaf, verdicts: Mapping[str, Verdict]) -> float:
    """Documentation completeness in [0,1]: AND=mean, OR=max, N_OF_M=mean of the best n children."""
    if isinstance(node, CriterionLeaf):
        return 1.0 if verdicts.get(node.id) == M else 0.0
    scores = [completeness_score(c, verdicts) for c in node.children]
    if node.op == "AND":
        return sum(scores) / len(scores)
    if node.op == "OR":
        return max(scores)
    n = node.n or 1
    return sum(sorted(scores, reverse=True)[:n]) / n


def compute_gaps(tree: CriteriaTree, verdicts: Mapping[str, Verdict]) -> list[Gap]:
    """Turn unresolved leaves into actionable, prioritized documentation gaps."""
    gaps: list[Gap] = []

    def walk(node: CriteriaNode | CriterionLeaf, required: bool, alternatives: int) -> None:
        if isinstance(node, CriterionLeaf):
            v = verdicts.get(node.id, U)
            if v == M:
                return
            if v == N:
                severity = "blocker" if required and alternatives <= 1 else "minor"
                detail = (
                    "The chart contradicts this requirement."
                    if alternatives <= 1
                    else f"This alternative is contradicted by the chart; {alternatives - 1} other path(s) remain."  # noqa: E501
                )
            else:
                severity = "major" if required else "minor"
                detail = (
                    "No verifiable documentation was found for this requirement."
                    if alternatives <= 1
                    else f"Documenting this would satisfy one of {alternatives} alternative paths."
                )
            gaps.append(
                Gap(
                    criterion_id=node.id,
                    title=node.text if len(node.text) <= 140 else node.text[:137] + "…",
                    detail=detail,
                    severity=severity,  # type: ignore[arg-type]
                    suggested_fix=node.suggested_fix or default_fix(node),
                    policy_quote=node.source_span.quote,
                    policy_key=tree.policy_key,
                )
            )
            return
        result = evaluate_tree(node, verdicts).verdict
        if result == M:
            return  # satisfied subtree — nothing to fix here
        if node.op == "AND":
            for c in node.children:
                walk(c, required, 1)
        else:
            for c in node.children:
                walk(c, required, len(node.children))

    walk(tree.root, True, 1)
    order = {"blocker": 0, "major": 1, "minor": 2}
    gaps.sort(key=lambda g: order[g.severity])
    return gaps


def default_fix(leaf: CriterionLeaf) -> str:
    if leaf.kind == CriterionKind.NEGATIVE_ATTESTATION:
        return (
            "Add an explicit clinician statement addressing this item (absence of mention is not sufficient)."
        )
    if leaf.kind == CriterionKind.NUMERIC:
        return "Add the objective measurement with its value, scale/unit and date."
    if leaf.kind == CriterionKind.TEMPORAL:
        return "Document dates (start/end) so the required duration or timing window can be verified."
    if leaf.kind == CriterionKind.DOCUMENTATION:
        return "Attach the required record or report to the case."
    return "Add clinical documentation (dated note) that explicitly addresses this requirement."


def qualified_id(policy_key: str, leaf_id: str) -> str:
    """Criterion ids are unique within a tree; across policies we qualify them (e.g. `L33718:C2`)."""
    return f"{policy_key}:{leaf_id}"


def split_qualified(qid: str) -> tuple[str, str]:
    key, _, leaf = qid.rpartition(":")
    return key, leaf


def summarize(
    trees: list[CriteriaTree], verdicts: Mapping[str, Verdict]
) -> tuple[TreeResult, Readiness, float]:
    """`verdicts` is keyed by qualified id (`policy_key:leaf_id`)."""
    results: list[TreeResult] = []
    scores: list[float] = []
    for t in trees:
        local = {
            split_qualified(k)[1]: v for k, v in verdicts.items() if split_qualified(k)[0] == t.policy_key
        }
        r = evaluate_tree(t.root, local)
        r.label = r.label or f"{t.policy_key} — {t.title}"
        _qualify(r, t.policy_key)
        results.append(r)
        scores.append(completeness_score(t.root, local))
    root = combine_policies(results) if results else TreeResult(verdict=U)
    score = sum(scores) / len(scores) if scores else 0.0
    return root, readiness_of(root), round(score, 4)


def gaps_for(trees: list[CriteriaTree], verdicts: Mapping[str, Verdict]) -> list[Gap]:
    out: list[Gap] = []
    for t in trees:
        local = {
            split_qualified(k)[1]: v for k, v in verdicts.items() if split_qualified(k)[0] == t.policy_key
        }
        for g in compute_gaps(t, local):
            g.criterion_id = qualified_id(t.policy_key, g.criterion_id)
            out.append(g)
    order = {"blocker": 0, "major": 1, "minor": 2}
    out.sort(key=lambda g: order[g.severity])
    return out


def _qualify(node: TreeResult, policy_key: str) -> None:
    if node.criterion_id:
        node.criterion_id = qualified_id(policy_key, node.criterion_id)
    for c in node.children or []:
        _qualify(c, policy_key)
