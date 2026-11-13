"""Case evaluation agent (LangGraph).

    load -> resolve_policies -> load_criteria -> index_chart
        -> fan-out per criterion (Send API, bounded concurrency)
             evaluate_criterion: retrieve -> judge -> verify  (corrective loop <= 2)
        -> results (list reducer)
    -> aggregate (Kleene) -> gaps -> persist -> awaiting_review (human-in-the-loop)

Design notes
* It is a *workflow* graph, not a free-roaming agent: the LLM judges one atomic criterion at a time on a
  handful of de-identified excerpts. Policy resolution and aggregation are deterministic code.
* Human review is modelled as durable DB state (`awaiting_review`), not a suspended graph thread, so a
  restart or a reviewer coming back next week can never strand the run (see `case_review.py`).
* Ports & adapters: the graph only talks to `CaseEvalPorts`. `DbCasePorts` (case_ports.py) binds it to
  Postgres/Qdrant/LiteLLM; tests bind it to in-memory fakes.
* Guards: recursion_limit, bounded fan-out concurrency, per-case token budget, per-call timeouts,
  cancellation checks, ≤ 2 corrective iterations per criterion.
"""

from __future__ import annotations

import asyncio
import operator
import time
from dataclasses import dataclass, field
from datetime import date
from typing import Annotated, Any, Protocol, TypedDict

import structlog
from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from app.ai.agents.case_chart import (
    ChartChunk,
    ChartDoc,
    LexicalIndex,
    chunk_chart,
    criterion_query,
    deterministic_verdict,
    expand_query,
    lookback_window,
)
from app.ai.compiler.logic import gaps_for, guard_leaf_verdict, qualified_id, summarize
from app.ai.compiler.prompting import render_prompt
from app.ai.compiler.schema import (
    CriteriaTree,
    CriterionKind,
    CriterionLeaf,
    CriterionVerdict,
    EntailmentCheck,
    Verdict,
    iter_leaves_with_path,
)
from app.ai.compiler.text import verify_quote

log = structlog.get_logger(__name__)

MAX_CORRECTIVE = 2
DEFAULT_CONCURRENCY = 3
JUDGE_TIMEOUT_S = 60.0
LOW_CONFIDENCE = 0.6


# ── data passed between graph and ports ────────────────────────────────────────────────────────


@dataclass
class CaseSnapshot:
    case_id: str
    org_id: str
    number: str
    title: str
    payer_type: str
    payer_name: str | None
    state: str | None
    service_codes: list[str]
    dx_codes: list[str]
    date_of_service: date | None
    dos_label: str  # date of service as the LLM sees it (shifted consistently with chart dates)
    docs: list[ChartDoc]


@dataclass
class LoadedCriteria:
    tree: CriteriaTree
    match: dict  # PolicyMatch (API shape)
    criteria_set_id: str | None = None
    policy_version_id: str | None = None
    flags: list[str] = field(default_factory=list)


class CaseEvalPorts(Protocol):
    async def load_case(self) -> CaseSnapshot: ...
    async def resolve_policies(self, snap: CaseSnapshot) -> list[dict]: ...
    async def load_criteria(self, snap: CaseSnapshot, matches: list[dict]) -> list[LoadedCriteria]: ...
    async def index_chart(self, snap: CaseSnapshot, chunks: list[ChartChunk]) -> list[str]: ...
    async def retrieve(
        self,
        snap: CaseSnapshot,
        leaf: CriterionLeaf,
        query: str,
        lexical: LexicalIndex,
        window: tuple[date | None, date | None],
        top_k: int,
    ) -> tuple[list[tuple[ChartChunk, float]], list[str]]: ...
    async def persist_result(self, result: dict) -> dict: ...
    async def finish(self, summary: dict) -> dict: ...
    async def fail(self, error: str) -> None: ...
    async def publish(self, event: str, data: dict) -> None: ...
    async def cancelled(self) -> bool: ...


class EvaluationCancelled(Exception):
    pass


@dataclass
class Runtime:
    ports: CaseEvalPorts
    router: Any | None
    budget: Any | None
    evaluation_id: str
    snapshot: CaseSnapshot | None = None
    criteria: list[LoadedCriteria] = field(default_factory=list)
    chunks: list[ChartChunk] = field(default_factory=list)
    lexical: LexicalIndex | None = None
    models: dict[str, str] = field(default_factory=dict)
    tokens: dict[str, int] = field(default_factory=lambda: {"prompt": 0, "completion": 0, "calls": 0})
    llm_down: bool = False
    db_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class CaseState(TypedDict, total=False):
    tasks: list[dict]
    results: Annotated[list[dict], operator.add]
    degraded: Annotated[list[str], operator.add]
    summary: dict


class CriterionState(TypedDict, total=False):
    task: dict
    iteration: int
    query: str
    candidates: list[dict]
    judged: dict
    final: dict
    flags: list[str]


# ── LLM helpers ────────────────────────────────────────────────────────────────────────────────


def _router_ok(rt: Runtime, group: str) -> bool:
    if rt.router is None or rt.llm_down:
        return False
    try:
        return bool(rt.router.is_available(group))
    except Exception:
        return True


async def _llm(rt: Runtime, *, group: str, purpose: str, prompt: str, model: type) -> Any:
    from app.ai.llm.types import DataClass

    res = await asyncio.wait_for(
        rt.router.complete(
            group=group,
            purpose=purpose,
            data_class=DataClass.PHI,
            deidentified=True,
            messages=[{"role": "user", "content": prompt}],
            response_model=model,
            temperature=0.0,
            org_id=_uuid(rt.snapshot.org_id) if rt.snapshot else None,
            budget=rt.budget,
            timeout_s=JUDGE_TIMEOUT_S,
            cache=True,
        ),
        timeout=JUDGE_TIMEOUT_S + 15,
    )
    rt.tokens["prompt"] += int(getattr(res, "prompt_tokens", 0) or 0)
    rt.tokens["completion"] += int(getattr(res, "completion_tokens", 0) or 0)
    rt.tokens["calls"] += 1
    rt.models[group] = f"{getattr(res, 'provider', '?')}/{getattr(res, 'model', '?')}"
    return res.parsed


def _uuid(v: str | None):
    import uuid

    try:
        return uuid.UUID(str(v)) if v else None
    except ValueError:
        return None


def _is_budget_error(exc: Exception) -> bool:
    return type(exc).__name__ in {"BudgetExceeded"}


def _is_unavailable(exc: Exception) -> bool:
    return type(exc).__name__ in {"LLMUnavailable", "BudgetExceeded", "PolicyViolation"}


# ── graph construction ─────────────────────────────────────────────────────────────────────────


def build_criterion_graph(rt: Runtime):
    async def retrieve(state: CriterionState) -> CriterionState:
        task = state["task"]
        leaf = CriterionLeaf.model_validate(task["leaf"])
        it = state.get("iteration", 0)
        query = criterion_query(leaf) if it == 0 else expand_query(leaf, it)
        snap = rt.snapshot
        window = lookback_window(snap.date_of_service if snap else None, leaf.lookback_days)
        hits, flags = await rt.ports.retrieve(snap, leaf, query, rt.lexical, window, 6)
        if it == 0:
            await rt.ports.publish(
                "criterion.started",
                {
                    "criterionId": task["qid"],
                    "text": leaf.text,
                    "treePath": task["tree_path"],
                },
            )
        cands = [
            {
                "chunkId": c.chunk_id,
                "documentId": c.document_id,
                "text": c.text,
                "score": round(float(s), 4),
                "noteDate": c.note_date.isoformat() if c.note_date else None,
                "section": c.section,
            }
            for c, s in hits
        ]
        await rt.ports.publish(
            "criterion.evidence",
            {
                "criterionId": task["qid"],
                "evidence": [
                    {
                        "chunkId": c["chunkId"],
                        "quote": c["text"][:280],
                        "score": c["score"],
                        "noteDate": c["noteDate"],
                    }
                    for c in cands
                ],
            },
        )
        return {"query": query, "candidates": cands, "flags": list(set(state.get("flags", []) + flags))}

    async def judge(state: CriterionState) -> CriterionState:
        task = state["task"]
        leaf = CriterionLeaf.model_validate(task["leaf"])
        cands = state.get("candidates", [])
        flags = list(state.get("flags", []))
        det_verdict, findings = deterministic_verdict(leaf, [_chunk_from(c) for c in cands])
        judged: dict[str, Any] = {
            "verdict": Verdict.INSUFFICIENT.value,
            "evidence": [],
            "rationale": "",
            "confidence": 0.3,
            "source": "none",
        }
        if await rt.ports.cancelled():
            raise EvaluationCancelled()
        if not cands:
            judged["rationale"] = "No chart excerpt addresses this criterion."
            judged["source"] = "no_evidence"
        elif _router_ok(rt, "judge"):
            prompt = render_prompt(
                "judge_criterion",
                criterion_id=task["qid"],
                kind=leaf.kind.value,
                criterion_text=leaf.text,
                policy_quote=leaf.source_span.quote,
                date_of_service=rt.snapshot.dos_label if rt.snapshot else "unknown",
                lookback=f"{leaf.lookback_days} days before the date of service"
                if leaf.lookback_days
                else "none",
                evidence=_format_excerpts(cands),
            )
            try:
                parsed: CriterionVerdict = await _llm(
                    rt, group="judge", purpose="case.judge", prompt=prompt, model=CriterionVerdict
                )
                judged = {
                    "verdict": parsed.verdict.value,
                    "evidence": [e.model_dump(by_alias=True) for e in parsed.evidence],
                    "rationale": parsed.rationale,
                    "confidence": parsed.confidence,
                    "source": "llm",
                }
            except Exception as exc:
                if _is_budget_error(exc):
                    rt.llm_down = True
                    flags.append("budget_exhausted")
                elif _is_unavailable(exc):
                    rt.llm_down = True
                    flags.append("llm_unavailable")
                else:
                    flags.append(f"judge_error:{type(exc).__name__}")
                log.warning("case.judge_failed", criterion=task["qid"], error=str(exc)[:200])
        else:
            flags.append("llm_unavailable")

        # Deterministic rules: degraded-mode verdict and cross-check of the LLM.
        if judged["source"] != "llm" and det_verdict != Verdict.INSUFFICIENT and findings:
            judged = {
                "verdict": det_verdict.value,
                "evidence": [{"chunkId": f.chunk_id, "quote": f.quote} for f in findings[:2]],
                "rationale": f"Deterministic rule: documented {leaf.numeric.measure.replace('_', ' ')} = "
                f"{findings[0].value:g} vs required {leaf.numeric.op} {leaf.numeric.value:g}.",
                "confidence": 0.7,
                "source": "rule",
            }
            flags.append("deterministic_rule")
        elif judged["source"] == "llm" and det_verdict != Verdict.INSUFFICIENT and findings:
            if det_verdict.value != judged["verdict"] and judged["verdict"] != Verdict.INSUFFICIENT.value:
                flags.append("numeric_conflict")
                judged["confidence"] = min(float(judged["confidence"]), 0.45)
        return {"judged": judged, "flags": flags}

    async def verify(state: CriterionState) -> CriterionState:
        task = state["task"]
        leaf = CriterionLeaf.model_validate(task["leaf"])
        judged = state["judged"]
        cands = {c["chunkId"]: c for c in state.get("candidates", [])}
        flags = list(state.get("flags", []))
        valid: list[dict] = []
        hallucinated = 0
        for ev in judged.get("evidence", []):
            quote = (ev.get("quote") or "").strip()
            target = cands.get(ev.get("chunkId", ""))
            search = [target] if target else []
            search += [c for c in cands.values() if c is not target]
            hit = None
            for c in search:
                ok, s, e = verify_quote(quote, c["text"])
                if ok:
                    hit = (c, s, e)
                    break
            if hit is None:
                hallucinated += 1
                continue
            c, s, e = hit
            valid.append(
                {
                    "chunkId": c["chunkId"],
                    "documentId": c["documentId"],
                    "quote": c["text"][s:e],
                    "charStart": s,
                    "charEnd": e,
                    "noteDate": c.get("noteDate"),
                }
            )
        if hallucinated:
            flags.append("hallucinated_quote")
        verdict = Verdict(judged["verdict"])
        entailment = None
        if (
            verdict in (Verdict.MET, Verdict.NOT_MET)
            and valid
            and judged.get("source") == "llm"
            and _router_ok(rt, "verifier")
        ):
            prompt = render_prompt(
                "judge_verify",
                criterion_text=leaf.text,
                verdict=verdict.value,
                quotes="\n".join(f'- "{v["quote"]}"' for v in valid),
            )
            try:
                check: EntailmentCheck = await _llm(
                    rt, group="verifier", purpose="case.verify", prompt=prompt, model=EntailmentCheck
                )
                entailment = check.label
                if check.label != "entails":
                    flags.append(f"entailment_{check.label}")
                    verdict = Verdict.INSUFFICIENT
            except Exception as exc:
                flags.append("verifier_unavailable")
                if _is_unavailable(exc):
                    rt.llm_down = rt.llm_down or _is_budget_error(exc)
        guarded = guard_leaf_verdict(leaf, verdict, has_valid_evidence=bool(valid))
        if guarded != verdict:
            flags.append("guard_downgrade")
        if leaf.kind == CriterionKind.NEGATIVE_ATTESTATION and guarded == Verdict.INSUFFICIENT:
            flags.append("attestation_required")
        final = {
            "verdict": guarded.value,
            "evidence": valid if guarded != Verdict.INSUFFICIENT else valid[:3],
            "rationale": judged.get("rationale", ""),
            "confidence": float(judged.get("confidence", 0.3)) if guarded == verdict else 0.35,
            "entailment": entailment,
            "source": judged.get("source"),
        }
        return {"final": final, "flags": flags}

    def route(state: CriterionState) -> str:
        final = state["final"]
        it = state.get("iteration", 0)
        weak = final["verdict"] == Verdict.INSUFFICIENT.value and (
            not state.get("candidates")
            or final["confidence"] < LOW_CONFIDENCE
            or "hallucinated_quote" in state.get("flags", [])
        )
        if weak and it < MAX_CORRECTIVE and not rt.llm_down:
            return "corrective"
        return "done"

    async def corrective(state: CriterionState) -> CriterionState:
        it = state.get("iteration", 0) + 1
        await rt.ports.publish(
            "criterion.corrective",
            {
                "criterionId": state["task"]["qid"],
                "iteration": it,
                "reason": "low-confidence or missing evidence — rewriting retrieval query",
            },
        )
        return {"iteration": it}

    g = StateGraph(CriterionState)
    g.add_node("retrieve", retrieve)
    g.add_node("judge", judge)
    g.add_node("verify", verify)
    g.add_node("corrective", corrective)
    g.add_edge(START, "retrieve")
    g.add_edge("retrieve", "judge")
    g.add_edge("judge", "verify")
    g.add_conditional_edges("verify", route, {"corrective": "corrective", "done": END})
    g.add_edge("corrective", "retrieve")
    return g.compile()


def build_case_graph(rt: Runtime):
    criterion_graph = build_criterion_graph(rt)

    async def load(state: CaseState) -> CaseState:
        await rt.ports.publish(
            "evaluation.phase", {"phase": "resolving", "message": "Loading case and chart"}
        )
        rt.snapshot = await rt.ports.load_case()
        return {}

    async def resolve(state: CaseState) -> CaseState:
        matches = await rt.ports.resolve_policies(rt.snapshot)
        await rt.ports.publish(
            "evaluation.phase",
            {"phase": "loading_criteria", "message": f"{len(matches)} applicable polic(ies)"},
        )
        rt.criteria = await rt.ports.load_criteria(rt.snapshot, matches)
        tasks: list[dict] = []
        for lc in rt.criteria:
            for path, leaf in iter_leaves_with_path(lc.tree.root):
                tasks.append(
                    {
                        "qid": qualified_id(lc.tree.policy_key, leaf.id),
                        "tree_path": path,
                        "policy_key": lc.tree.policy_key,
                        "policy_version_id": lc.policy_version_id,
                        "leaf": leaf.model_dump(by_alias=True),
                    }
                )
        degraded = [f for lc in rt.criteria for f in lc.flags]
        if not rt.criteria:
            degraded.append("no_applicable_criteria")
        await rt.ports.publish(
            "evaluation.started",
            {
                "evaluationId": rt.evaluation_id,
                "policies": [lc.match for lc in rt.criteria],
                "criteriaCount": len(tasks),
            },
        )
        return {"tasks": tasks, "degraded": degraded}

    async def index(state: CaseState) -> CaseState:
        await rt.ports.publish("evaluation.phase", {"phase": "indexing_chart", "message": "Indexing chart"})
        rt.chunks = chunk_chart(rt.snapshot.docs)
        rt.lexical = LexicalIndex(rt.chunks)
        flags = await rt.ports.index_chart(rt.snapshot, rt.chunks)
        await rt.ports.publish(
            "evaluation.phase",
            {
                "phase": "evaluating",
                "message": f"Evaluating {len(state.get('tasks', []))} criteria "
                f"against {len(rt.chunks)} chart excerpts",
            },
        )
        return {"degraded": flags}

    def fan_out(state: CaseState):
        tasks = state.get("tasks", [])
        if not tasks:
            return "aggregate"
        return [Send("evaluate_criterion", {"task": t}) for t in tasks]

    async def evaluate_criterion(payload: dict) -> CaseState:
        task = payload["task"]
        out = await criterion_graph.ainvoke(
            {"task": task, "iteration": 0, "flags": []}, {"recursion_limit": 4 * (MAX_CORRECTIVE + 2)}
        )
        final, flags = out["final"], sorted(set(out.get("flags", [])))
        leaf = CriterionLeaf.model_validate(task["leaf"])
        result = {
            "criterion_id": task["qid"],
            "criterion_text": leaf.text,
            "kind": leaf.kind.value,
            "tree_path": task["tree_path"],
            "verdict": final["verdict"],
            "confidence": round(float(final["confidence"]), 3),
            "rationale": final.get("rationale") or None,
            "evidence": final["evidence"],
            "policy_citation": {
                "policyVersionId": task.get("policy_version_id"),
                "policyKey": task["policy_key"],
                "sectionKey": leaf.source_span.section_key,
                "quote": leaf.source_span.quote,
            },
            "verification": {
                "quoteValid": "hallucinated_quote" not in flags,
                "entailment": final.get("entailment"),
                "judgeModel": rt.models.get("judge"),
                "verifierModel": rt.models.get("verifier"),
                "iterations": out.get("iteration", 0),
                "flags": flags,
                "source": final.get("source"),
                "degraded": final.get("source") != "llm",
            },
        }
        async with rt.db_lock:
            stored = await rt.ports.persist_result(result)
        await rt.ports.publish("criterion.verdict", {"result": stored})
        deg = ["llm_unavailable"] if "llm_unavailable" in flags else []
        if "budget_exhausted" in flags:
            deg.append("budget_exhausted")
        return {"results": [stored], "degraded": deg}

    async def aggregate(state: CaseState) -> CaseState:
        await rt.ports.publish("evaluation.phase", {"phase": "aggregating", "message": "Combining verdicts"})
        verdicts = {r["criterionId"]: Verdict(r["effectiveVerdict"]) for r in state.get("results", [])}
        trees = [lc.tree for lc in rt.criteria]
        root, readiness, score = summarize(trees, verdicts)
        tree_json = root.model_dump(by_alias=True, exclude_none=True)
        await rt.ports.publish(
            "evaluation.aggregate", {"readiness": readiness.value, "readinessScore": score, "tree": tree_json}
        )
        await rt.ports.publish("evaluation.phase", {"phase": "drafting_gaps", "message": "Computing gaps"})
        gaps = [g.model_dump(by_alias=True) for g in gaps_for(trees, verdicts)]
        await rt.ports.publish("evaluation.gaps", {"gaps": gaps})
        degraded = sorted(set(state.get("degraded", [])))
        summary = {
            "readiness": readiness.value,
            "readiness_score": score,
            "tree_result": tree_json,
            "gaps": gaps,
            "policy_version_ids": [lc.policy_version_id for lc in rt.criteria if lc.policy_version_id],
            "criteria_set_ids": [lc.criteria_set_id for lc in rt.criteria if lc.criteria_set_id],
            "policies": [lc.match for lc in rt.criteria],
            "model_info": {
                "models": rt.models,
                "degradedReasons": degraded,
                "chunks": len(rt.chunks),
                "concurrency": DEFAULT_CONCURRENCY,
            },
            "token_usage": {
                "promptTokens": rt.tokens["prompt"],
                "completionTokens": rt.tokens["completion"],
                "calls": rt.tokens["calls"],
                "budget": getattr(rt.budget, "limit", None),
            },
            "degraded": bool(degraded)
            or any(r.get("verification", {}).get("degraded") for r in state.get("results", [])),
        }
        await rt.ports.publish("evaluation.phase", {"phase": "review", "message": "Awaiting human review"})
        stored = await rt.ports.finish(summary)
        await rt.ports.publish("evaluation.awaiting_review", {"evaluationId": rt.evaluation_id})
        await rt.ports.publish("evaluation.completed", {"evaluation": stored})
        return {"summary": summary}

    g = StateGraph(CaseState)
    g.add_node("load", load)
    g.add_node("resolve", resolve)
    g.add_node("index_chart", index)
    g.add_node("evaluate_criterion", evaluate_criterion)
    g.add_node("aggregate", aggregate)
    g.add_edge(START, "load")
    g.add_edge("load", "resolve")
    g.add_edge("resolve", "index_chart")
    g.add_conditional_edges("index_chart", fan_out, ["evaluate_criterion", "aggregate"])
    g.add_edge("evaluate_criterion", "aggregate")
    g.add_edge("aggregate", END)
    return g.compile()


def _format_excerpts(cands: list[dict]) -> str:
    parts = []
    for c in cands:
        attrs = f'chunkId="{c["chunkId"]}"'
        if c.get("section"):
            attrs += f' section="{c["section"]}"'
        parts.append(f"<excerpt {attrs}>\n{c['text']}\n</excerpt>")
    return "\n".join(parts) or "(none)"


def _chunk_from(c: dict) -> ChartChunk:
    return ChartChunk(
        chunk_id=c["chunkId"],
        document_id=c["documentId"],
        ordinal=0,
        text=c["text"],
        section=c.get("section"),
        note_date=None,
        char_start=0,
        char_end=len(c["text"]),
    )


async def evaluate(
    ports: CaseEvalPorts,
    *,
    evaluation_id: str,
    router: Any | None,
    token_budget: int | None = None,
    concurrency: int = DEFAULT_CONCURRENCY,
    timeout_s: float = 900.0,
) -> dict:
    """Run one evaluation end to end. Returns the summary dict."""
    budget = None
    if token_budget:
        try:
            from app.ai.llm.budget import RequestBudget

            budget = RequestBudget(token_budget, label=f"case-eval:{evaluation_id}")
        except Exception:
            budget = None
    rt = Runtime(ports=ports, router=router, budget=budget, evaluation_id=evaluation_id)
    graph = build_case_graph(rt)
    started = time.monotonic()
    try:
        out = await asyncio.wait_for(
            graph.ainvoke(
                {"results": [], "degraded": []},
                {"recursion_limit": 64, "max_concurrency": max(1, concurrency)},
            ),
            timeout=timeout_s,
        )
    except EvaluationCancelled:
        await ports.fail("cancelled")
        await ports.publish("evaluation.failed", {"error": "Evaluation was cancelled.", "retryable": True})
        raise
    except TimeoutError:
        await ports.fail("timeout")
        await ports.publish("evaluation.failed", {"error": "Evaluation timed out.", "retryable": True})
        raise
    except Exception as exc:
        log.exception("case.evaluation_failed", evaluation_id=evaluation_id)
        await ports.fail(f"{type(exc).__name__}: {str(exc)[:300]}")
        await ports.publish(
            "evaluation.failed", {"error": "Evaluation failed unexpectedly.", "retryable": True}
        )
        raise
    summary = out.get("summary", {})
    summary["elapsed_s"] = round(time.monotonic() - started, 2)
    return summary
