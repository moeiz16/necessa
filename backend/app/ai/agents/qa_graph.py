"""Ask Necessa — conversational, grounded policy Q&A as a LangGraph workflow.

    guard ──(blocked)──────────────────────────────────────────────┐
      │                                                            ▼
    contextualize (memory: rolling summary + follow-up rewrite)  finalize
      │                                                            ▲
    route+retrieve (HybridRetriever: S1-S11)                       │
      ├── analytics → text-to-SQL ───────────────┐                 │
      └── tools (codes / dx / graph / versions) ─┤                 │
                                                 ▼                 │
                    generate (semantic cache → stream LLM → extractive fallback)
                                                 │
                    validate (citations, policy enforcement) ──────┘

Events (docs/API_CONTRACT.md §5.2) are pushed to a queue as each node runs, so the client sees the
route, the retrieved evidence and then streamed tokens. Persistence uses its own DB sessions because
the SSE generator outlives the request-scoped session.
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import date
from typing import Any, TypedDict

import structlog
from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from app.ai.cache import SemanticCache, entity_signature
from app.ai.guardrails.injection import scan_injection
from app.ai.guardrails.output import validate_citations
from app.ai.guardrails.phi import Deidentifier, detect_high_risk
from app.ai.guardrails.policy import DISCLAIMER, enforce_output_policy, is_out_of_scope_question
from app.ai.llm.budget import RequestBudget
from app.ai.llm.fake import extractive_answer
from app.ai.llm.router import get_llm_router
from app.ai.llm.types import DataClass, LLMError
from app.ai.prompts.loader import render
from app.ai.retrieval.context import ContextPacker
from app.ai.retrieval.retriever import get_retriever
from app.ai.retrieval.types import PolicyFilters, RetrievalQuery, RetrievalResult
from app.ai.retrieval.understanding import understand
from app.ai.textutil import truncate
from app.core.config import get_settings

log = structlog.get_logger(__name__)
Emit = Callable[[str, dict], Awaitable[None]]
_FOLLOWUP = re.compile(
    r"\b(it|its|that|this|those|these|they|them|same|above|previous|the policy|the lcd|"
    r"what about|and for|how about)\b",
    re.I,
)


class QAState(TypedDict, total=False):
    org_id: uuid.UUID
    user_id: uuid.UUID
    conversation_id: uuid.UUID
    content: str
    as_of: date | None
    case_id: uuid.UUID | None
    mode: str
    query: str
    history: list[dict]
    summary: str
    case_context: dict | None
    blocked: bool
    abstain: bool
    abstain_reason: str
    retrieval: Any
    intent: str
    tool_results: list[dict]
    sql: dict | None
    answer: str
    citations: list[dict]
    model: str
    provider: str
    cached: bool
    usage: dict
    degraded: list[str]
    started: float
    sem_key: Any
    prompt_version: int


def _emit(config: RunnableConfig) -> Emit:
    return config["configurable"]["emit"]


def _budget(config: RunnableConfig) -> RequestBudget:
    return config["configurable"]["budget"]


# ── nodes ──────────────────────────────────────────────────────────────────
async def guard(state: QAState, config: RunnableConfig) -> QAState:
    emit = _emit(config)
    text = state["content"]
    verdict = await scan_injection(text, source="user")
    if verdict.label == "malicious":
        await emit(
            "guardrail",
            {
                "kind": "injection",
                "message": "This request looks like an attempt to override the "
                "assistant's instructions, so it was not processed.",
                "reasons": verdict.reasons,
            },
        )
        return {
            "blocked": True,
            "abstain": True,
            "answer": "I can't help with that request. Ask me about coverage "
            "policies, documentation requirements or your organization's case analytics.",
            "query": text,
        }
    if is_out_of_scope_question(text):
        await emit("guardrail", {"kind": "policy", "message": "Clinical advice is outside Necessa's scope."})
        return {
            "blocked": True,
            "abstain": True,
            "query": text,
            "answer": (
                "I can't provide clinical advice (diagnosis, treatment or dosing). "
                "I can explain what coverage policies "
                "require and what documentation supports a prior authorization.\n\n_" + DISCLAIMER + "_"
            ),
        }
    query = text
    if detect_high_risk(text):
        query = Deidentifier(date_policy="keep").deidentify(text).text
        await emit(
            "guardrail",
            {
                "kind": "phi",
                "message": "Personal identifiers were removed from your question "
                "before searching. Avoid pasting patient identifiers into the assistant.",
            },
        )
    return {"blocked": False, "query": query}


async def contextualize(state: QAState, config: RunnableConfig) -> QAState:
    history = state.get("history") or []
    summary = ""
    router = get_llm_router()
    if len(history) > 8:
        older = history[:-6]
        convo = "\n".join(f"{m['role']}: {truncate(m['content'], 400)}" for m in older)
        try:
            prompt, _ = render("qa_summary", conversation=convo)
            res = await router.complete(
                group="router-small",
                purpose="qa.summary",
                data_class=DataClass.INTERNAL,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=220,
                budget=_budget(config),
            )
            summary = res.text.strip()
        except LLMError:
            summary = " | ".join(truncate(m["content"], 120) for m in older if m["role"] == "user")[-800:]
    recent = history[-6:]
    query = state["query"]
    if recent and (len(query.split()) <= 8 or _FOLLOWUP.search(query)):
        last_user = next((m["content"] for m in reversed(recent) if m["role"] == "user"), "")
        rewritten = None
        if not getattr(router, "fake", False) and router.is_available("router-small"):
            try:
                prompt, _ = render("qa_rewrite", summary=summary or truncate(last_user, 600), message=query)
                res = await router.complete(
                    group="router-small",
                    purpose="qa.rewrite",
                    data_class=DataClass.INTERNAL,
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=120,
                    budget=_budget(config),
                )
                rewritten = res.text.strip().splitlines()[0] if res.text.strip() else None
            except LLMError:
                rewritten = None
        if not rewritten:
            prev = understand(last_user)
            carry = " ".join(prev.source_keys + prev.service_codes + prev.icd10 + prev.states)
            rewritten = f"{query} {carry}".strip() if carry else query
        if rewritten != query:
            await _emit(config)("route", {"phase": "rewrite", "standalone": rewritten})
        query = rewritten
    return {"query": query, "summary": summary, "history": recent}


async def route_retrieve(state: QAState, config: RunnableConfig) -> QAState:
    emit = _emit(config)
    mode = state.get("mode") or "auto"
    filters = PolicyFilters(as_of=state.get("as_of"))
    ctx = state.get("case_context")
    if ctx:
        filters.as_of = filters.as_of or ctx.get("dateOfService")
        filters.states = [ctx["state"]] if ctx.get("state") else None
        filters.payer_type = ctx.get("payerType")
    strategy = {"analytics": "S3", "codes": "S2"}.get(mode)
    q = RetrievalQuery(
        text=state["query"], org_id=state["org_id"], filters=filters, top_k=8, strategy=strategy
    )
    res: RetrievalResult = await get_retriever().search(q)
    r = res.route
    await emit(
        "route",
        {
            "intent": r.intent,
            "confidence": r.confidence,
            "strategy": r.strategy,
            "transforms": r.transforms,
            "filters": r.filters_applied,
            "reason": r.reason,
            "retrievers": r.retrievers,
            "fusion": r.fusion,
            "rerank": r.rerank,
            "degraded": r.degraded,
            "entities": r.entities,
        },
    )
    if res.chunks:
        await emit(
            "retrieval",
            {
                "chunks": [
                    {
                        "chunkId": c.chunk_id,
                        "sourceKey": c.source.get("source_key"),
                        "title": c.source.get("title"),
                        "sectionKey": c.source.get("section_key"),
                        "sectionTitle": c.source.get("section_title"),
                        "version": c.source.get("version"),
                        "docType": c.source.get("doc_type"),
                        "score": round(c.score, 4),
                        "scores": c.scores,
                        "snippet": truncate(c.text, 280),
                    }
                    for c in res.chunks
                ],
                "timings": res.timings,
                "correctiveIterations": r.corrective_iterations,
            },
        )
    return {"retrieval": res, "intent": r.intent, "degraded": list(r.degraded)}


async def tools(state: QAState, config: RunnableConfig) -> QAState:
    from app.ai.graph.coverage_graph import coverage_paths
    from app.ai.sql.tools import find_policies_by_code, policy_versions, resolve_policies, section_diff
    from app.db.session import session_scope

    emit = _emit(config)
    a = understand(state["query"])
    ctx = state.get("case_context") or {}
    state_abbrev = (a.states or ([ctx["state"]] if ctx.get("state") else [None]))[0]
    results: list[dict] = []
    intent = state.get("intent")
    async with session_scope() as db:
        if intent in {"structured_fact", "multi_hop", "exact_lookup", "keyword_heavy"}:
            for code in (a.service_codes + a.icd10)[:3]:
                rows = await find_policies_by_code(db, code, state_abbrev, state.get("as_of"), limit=10)
                results.append(
                    {
                        "name": "find_policies_by_code",
                        "args": {"code": code, "state": state_abbrev},
                        "result": rows,
                    }
                )
            if a.service_codes and (a.icd10 or ctx.get("dxCodes")):
                matches = await resolve_policies(
                    db,
                    service_codes=a.service_codes,
                    dx_codes=a.icd10 or ctx.get("dxCodes", []),
                    state=state_abbrev,
                    payer_type=ctx.get("payerType") or a.payer_type or "medicare_ffs",
                    date_of_service=state.get("as_of") or ctx.get("dateOfService") or date.today(),
                )
                results.append(
                    {
                        "name": "resolve_policies",
                        "args": {"serviceCodes": a.service_codes, "dxCodes": a.icd10, "state": state_abbrev},
                        "result": [m.model_dump(by_alias=True, mode="json") for m in matches],
                    }
                )
            if (
                a.service_codes
                and intent == "structured_fact"
                and re.search(r"\b(contractor|mac|state|jurisdiction)", state["query"], re.I)
            ):
                g = await coverage_paths(db, a.service_codes[0], state_abbrev, state.get("as_of"))
                results.append(
                    {
                        "name": "coverage_graph",
                        "args": {"code": a.service_codes[0]},
                        "result": {"stats": g.stats, "nodes": [n.model_dump() for n in g.nodes][:40]},
                    }
                )
        if intent == "version_compare" and a.source_keys:
            vers = await policy_versions(db, a.source_keys[0])
            results.append(
                {"name": "policy_versions", "args": {"sourceKey": a.source_keys[0]}, "result": vers}
            )
            if len(vers) >= 2:
                from sqlalchemy import select

                from app.db.models.knowledge import Policy

                pol = (
                    (await db.execute(select(Policy).where(Policy.source_key == a.source_keys[0])))
                    .scalars()
                    .first()
                )
                if pol:
                    diff = await section_diff(db, pol.id, vers[1]["version"], vers[0]["version"])
                    changed = [d for d in diff if d["status"] != "same"]
                    results.append(
                        {
                            "name": "section_diff",
                            "args": {"from": vers[1]["version"], "to": vers[0]["version"]},
                            "result": [
                                {
                                    "sectionKey": d["sectionKey"],
                                    "status": d["status"],
                                    "inserted": " ".join(
                                        h["text"] for h in d["hunks"] if h["op"] == "insert"
                                    )[:600],
                                    "deleted": " ".join(h["text"] for h in d["hunks"] if h["op"] == "delete")[
                                        :600
                                    ],
                                }
                                for d in changed
                            ][:8],
                        }
                    )
    for r in results:
        await emit(
            "tool",
            {
                "name": r["name"],
                "args": r["args"],
                "result": r["result"] if isinstance(r["result"], dict) else r["result"][:15],
            },
        )
    return {"tool_results": results}


async def analytics(state: QAState, config: RunnableConfig) -> QAState:
    from app.ai.sql.text_to_sql import answer_analytics
    from app.db.session import session_scope

    async with session_scope() as db:
        ans = await answer_analytics(state["query"], state["org_id"], db, budget=_budget(config))
    data = ans.to_dict()
    await _emit(config)(
        "sql",
        {
            "sql": ans.sql,
            "columns": ans.columns,
            "rows": ans.rows[:100],
            "chartHint": ans.chart_hint,
            "warnings": ans.warnings,
            "method": ans.method,
            "rowCount": ans.row_count,
        },
    )
    return {"sql": data}


async def generate(state: QAState, config: RunnableConfig) -> QAState:
    emit = _emit(config)
    router = get_llm_router()
    res: RetrievalResult | None = state.get("retrieval")
    chunks = res.chunks if res else []
    tool_results = state.get("tool_results") or []
    sql = state.get("sql")
    if sql is not None:
        return await _generate_sql_answer(state, config, sql)
    if (res is None or res.route.abstained) and not tool_results:
        reason = res.route.reason if res else "no retrieval"
        answer = (
            "I couldn't find enough evidence in the indexed coverage policies to answer that confidently. "
            "Try naming the service (or HCPCS/CPT code), the payer type and the state, or ask about a "
            "specific LCD/NCD."
        )
        await emit(
            "guardrail",
            {"kind": "abstain", "message": "Low retrieval confidence — abstaining.", "reason": reason},
        )
        await _stream_text(emit, answer)
        return {"answer": answer, "abstain": True, "abstain_reason": reason, "citations": []}

    packed = ContextPacker(budget_tokens=3200).pack(state["query"], chunks)
    # semantic cache (PUBLIC, standalone, no case context)
    sem_key = None
    if get_settings().enable_semantic_cache and not state.get("case_context") and chunks:
        from app.ai.embeddings import embed_query
        from app.ai.vectorstore import get_vectorstore

        a = understand(state["query"])
        sig = entity_signature(
            state["query"],
            codes=a.all_codes + a.source_keys,
            payer_type=a.payer_type,
            states=a.states,
            as_of=a.as_of.isoformat() if a.as_of else None,
        )
        store = await get_vectorstore()
        index_version = await store.current_physical("policy_chunks") or "none"
        qv = await embed_query(state["query"], purpose="semantic_cache")
        if qv is not None:
            sem_key = (qv, sig, index_version)
            hit = await SemanticCache().lookup(qv, sig, index_version)
            if hit and hit.answer.get("text"):
                await _stream_text(emit, hit.answer["text"])
                return {
                    "answer": hit.answer["text"],
                    "citations": hit.answer.get("citations", []),
                    "cached": True,
                    "model": hit.answer.get("model", ""),
                    "provider": "semantic-cache",
                }

    tool_xml = ""
    if tool_results:
        import json

        tool_xml = (
            "<tool_results>\n"
            + "\n".join(
                f'<tool name="{t["name"]}">{truncate(json.dumps(t["result"], default=str), 2500)}</tool>'
                for t in tool_results
            )
            + "\n</tool_results>"
        )
    case_xml = ""
    if state.get("case_context"):
        c = state["case_context"]
        case_xml = (
            f"<case_context>payer={c.get('payerType')} state={c.get('state')} dos={c.get('dateOfService')} "
            f"services={','.join(c.get('serviceCodes', []))} dx={','.join(c.get('dxCodes', []))} "
            f"readiness={c.get('readiness')} open_gaps={'; '.join(c.get('gaps', [])[:5])}</case_context>"
        )
    system, prompt_version = render("qa_answer")
    summary_xml = (
        f"<conversation_summary>{state['summary']}</conversation_summary>" if state.get("summary") else ""
    )
    as_of = state.get("as_of")
    user = (
        f"{summary_xml}"
        f"\n{case_xml}\n<question>{state['query']}</question>\n"
        f"<as_of>{as_of.isoformat() if as_of else 'today'}</as_of>\n{packed.xml}\n{tool_xml}\n"
        "Answer the question using the sources. Cite with [n]."
    )
    messages = [{"role": "system", "content": system}]
    for m in state.get("history") or []:
        messages.append({"role": m["role"], "content": truncate(m["content"], 1200)})
    messages.append({"role": "user", "content": user})
    info: dict = {}
    parts: list[str] = []
    data_class = DataClass.INTERNAL if state.get("case_context") else DataClass.PUBLIC
    try:
        async for delta in router.stream(
            group="qa-public",
            purpose="qa.answer",
            messages=messages,
            data_class=data_class,
            org_id=state["org_id"],
            info=info,
            budget=_budget(config),
        ):
            parts.append(delta)
            await emit("token", {"text": delta})
        answer = "".join(parts).strip()
        model, provider = info.get("model", ""), info.get("provider", "")
        usage = {
            "promptTokens": info.get("prompt_tokens", 0),
            "completionTokens": info.get("completion_tokens", 0),
        }
    except LLMError as exc:
        if parts:
            answer = "".join(parts).strip() + "\n\n_(response interrupted)_"
        else:
            await emit(
                "guardrail",
                {
                    "kind": "degraded",
                    "message": "Language models are unavailable right now — "
                    "showing the most relevant policy excerpts instead.",
                    "reason": str(exc)[:160],
                },
            )
            answer = extractive_answer(state["query"], [(s.n, s.text) for s in packed.sources])
            await _stream_text(emit, answer)
        model, provider, usage = "extractive", "fallback", {}
    citations = [_citation(s.n, s.chunk) for s in packed.sources]
    out: QAState = {
        "answer": answer,
        "citations": citations,
        "model": model,
        "provider": provider,
        "usage": usage,
        "cached": False,
    }
    out["sem_key"] = sem_key
    out["prompt_version"] = prompt_version
    return out


async def _generate_sql_answer(state: QAState, config: RunnableConfig, sql: dict) -> QAState:
    emit = _emit(config)
    if not sql.get("sql"):
        answer = sql.get("summary") or "I couldn't translate that into an analytics query."
        await _stream_text(emit, answer)
        return {"answer": answer, "citations": [], "model": "", "provider": ""}
    rows = sql.get("rows") or []
    cols = sql.get("columns") or []
    preview = "\n".join(", ".join(f"{c}={v}" for c, v in zip(cols, r, strict=False)) for r in rows[:15])
    router = get_llm_router()
    answer = ""
    if not getattr(router, "fake", False) and router.is_available("qa-public"):
        try:
            res = await router.complete(
                group="qa-public",
                purpose="qa.analytics_summary",
                data_class=DataClass.INTERNAL,
                messages=[
                    {
                        "role": "user",
                        "content": (
                            f"Question: {state['query']}\nSQL result (first rows):\n{preview}\n"
                            "Summarize the result in 1-3 sentences with the key numbers. "
                            "Do not speculate beyond the data."
                        ),
                    }
                ],
                max_tokens=200,
                org_id=state["org_id"],
                budget=_budget(config),
            )
            answer = res.text.strip()
        except LLMError:
            answer = ""
    if not answer:
        answer = sql.get("summary") or f"{len(rows)} row(s) returned."
        if rows and len(cols) >= 2:
            answer += "\n\n" + "\n".join(f"- {r[0]}: {r[-1]}" for r in rows[:10])
    await _stream_text(emit, answer)
    return {"answer": answer, "citations": [], "model": "", "provider": "sql"}


async def validate(state: QAState, config: RunnableConfig) -> QAState:
    emit = _emit(config)
    answer = state.get("answer", "")
    citations = state.get("citations") or []
    if citations:
        check = validate_citations(answer, {c["n"] for c in citations})
        answer = check.text
        citations = [c for c in citations if c["n"] in set(check.used)] or citations[:3]
        if check.invalid:
            await emit(
                "guardrail",
                {"kind": "policy", "message": f"Removed {len(check.invalid)} invalid citation(s)."},
            )
    pol = enforce_output_policy(answer)
    if pol.violations:
        await emit(
            "guardrail",
            {
                "kind": "policy",
                "message": "Adjusted wording: Necessa does not predict coverage "
                "decisions or give clinical advice.",
                "violations": pol.violations,
            },
        )
    answer = pol.text
    if citations:
        await emit("citations", {"items": citations})
    sem_key = state.get("sem_key")
    if (
        sem_key
        and not state.get("abstain")
        and state.get("provider") not in {"fallback", "semantic-cache"}
        and citations
        and not pol.violations
    ):
        qv, sig, iv = sem_key
        await SemanticCache().store(
            qv,
            sig,
            iv,
            state["query"],
            {"text": answer, "citations": citations, "model": state.get("model", "")},
        )
    return {"answer": answer, "citations": citations}


async def finalize(state: QAState, config: RunnableConfig) -> QAState:
    return {}


def _citation(n: int, chunk: Any) -> dict:
    src = chunk.source
    return {
        "n": n,
        "chunkId": chunk.chunk_id,
        "sourceKey": src.get("source_key"),
        "title": src.get("title"),
        "sectionKey": src.get("section_key"),
        "sectionTitle": src.get("section_title"),
        "version": src.get("version"),
        "docType": src.get("doc_type"),
        "effectiveFrom": src.get("effective_from"),
        "quote": truncate(chunk.text, 320),
        "url": src.get("url"),
        "policyId": src.get("policy_id"),
    }


async def _stream_text(emit: Emit, text: str) -> None:
    for piece in re.findall(r"\S+\s*", text):
        await emit("token", {"text": piece})


# ── graph wiring ───────────────────────────────────────────────────────────
def _after_guard(state: QAState) -> str:
    return "finalize" if state.get("blocked") else "contextualize"


def _after_route(state: QAState) -> str:
    intent = state.get("intent")
    if intent == "analytics":
        return "analytics"
    if intent in {"structured_fact", "multi_hop", "version_compare", "exact_lookup", "keyword_heavy"}:
        return "tools"
    return "generate"


def build_graph():
    g = StateGraph(QAState)
    g.add_node("guard", guard)
    g.add_node("contextualize", contextualize)
    g.add_node("route_retrieve", route_retrieve)
    g.add_node("tools", tools)
    g.add_node("analytics", analytics)
    g.add_node("generate", generate)
    g.add_node("validate", validate)
    g.add_node("finalize", finalize)
    g.add_edge(START, "guard")
    g.add_conditional_edges("guard", _after_guard, {"finalize": "finalize", "contextualize": "contextualize"})
    g.add_edge("contextualize", "route_retrieve")
    g.add_conditional_edges(
        "route_retrieve", _after_route, {"analytics": "analytics", "tools": "tools", "generate": "generate"}
    )
    g.add_edge("tools", "generate")
    g.add_edge("analytics", "generate")
    g.add_edge("generate", "validate")
    g.add_edge("validate", "finalize")
    g.add_edge("finalize", END)
    return g.compile()


_GRAPH = None


def get_graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_graph()
    return _GRAPH


# ── persistence helpers (A's models) ───────────────────────────────────────
async def _load_history(org_id: uuid.UUID, conversation_id: uuid.UUID, limit: int = 20) -> list[dict]:
    try:
        from sqlalchemy import select

        from app.db.models.platform import Message
        from app.db.session import session_scope

        async with session_scope() as s:
            rows = (
                (
                    await s.execute(
                        select(Message)
                        .where(Message.org_id == org_id, Message.conversation_id == conversation_id)
                        .order_by(Message.created_at.desc())
                        .limit(limit)
                    )
                )
                .scalars()
                .all()
            )
        return [{"role": m.role, "content": m.content} for m in reversed(rows)]
    except Exception as exc:
        log.debug("qa.history_unavailable", error=str(exc))
        return []


async def _save_message(
    org_id: uuid.UUID, conversation_id: uuid.UUID, role: str, content: str, **fields: Any
) -> str | None:
    try:
        from app.db.models.platform import Conversation, Message
        from app.db.session import session_scope

        async with session_scope() as s:
            msg = Message(
                org_id=org_id, conversation_id=conversation_id, role=role, content=content, **fields
            )
            s.add(msg)
            conv = await s.get(Conversation, conversation_id)
            if conv is not None and conv.org_id == org_id:
                if role == "user" and (not conv.title or conv.title == "New conversation"):
                    conv.title = truncate(content, 60)
                from app.db.base import utcnow

                conv.updated_at = utcnow()
            await s.flush()
            return str(msg.id)
    except Exception as exc:
        log.warning("qa.persist_failed", error=str(exc))
        return None


async def _case_context(org_id: uuid.UUID, case_id: uuid.UUID | None) -> dict | None:
    if not case_id:
        return None
    try:
        from sqlalchemy import select

        from app.db.models.cases import Case, CriterionResult
        from app.db.session import session_scope

        async with session_scope() as s:
            c = await s.get(Case, case_id)
            if c is None or c.org_id != org_id:
                return None
            gaps: list[str] = []
            if c.latest_evaluation_id:
                rows = (
                    (
                        await s.execute(
                            select(CriterionResult).where(
                                CriterionResult.evaluation_id == c.latest_evaluation_id
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                gaps = [r.criterion_text for r in rows if (r.override_verdict or r.verdict) != "MET"]
            return {
                "payerType": c.payer_type,
                "state": c.state,
                "dateOfService": c.date_of_service,
                "serviceCodes": list(c.service_codes or []),
                "dxCodes": list(c.dx_codes or []),
                "readiness": c.readiness,
                "gaps": gaps,
            }
    except Exception as exc:
        log.debug("qa.case_context_failed", error=str(exc))
        return None


# ── public entry point ─────────────────────────────────────────────────────
async def run_assistant_turn(
    *,
    db: Any = None,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID,
    content: str,
    as_of: date | None = None,
    case_id: uuid.UUID | None = None,
    mode: str = "auto",
    persist: bool = True,
) -> AsyncIterator[tuple[str, dict]]:
    """Yields (event, data) tuples per docs/API_CONTRACT.md §5.2. `db` is accepted for interface parity;
    persistence uses short-lived sessions because this generator outlives the request session."""
    t0 = time.perf_counter()
    queue: asyncio.Queue[tuple[str, dict] | None] = asyncio.Queue()

    async def emit(event: str, data: dict) -> None:
        await queue.put((event, data))

    history = await _load_history(org_id, conversation_id) if persist else []
    if persist:
        await _save_message(org_id, conversation_id, "user", content)
    budget = RequestBudget(int(get_settings().qa_token_budget), label="qa-turn")
    state: QAState = {
        "org_id": org_id,
        "user_id": user_id,
        "conversation_id": conversation_id,
        "content": content,
        "as_of": as_of,
        "case_id": case_id,
        "mode": mode,
        "history": history,
        "case_context": await _case_context(org_id, case_id),
        "started": t0,
    }
    result: dict = {}

    async def runner() -> None:
        nonlocal result
        try:
            result = await get_graph().ainvoke(
                state, config={"configurable": {"emit": emit, "budget": budget}, "recursion_limit": 16}
            )
        except Exception as exc:
            log.exception("qa.turn_failed")
            await emit(
                "error",
                {
                    "message": "The assistant hit an error while answering.",
                    "detail": str(exc)[:200],
                    "retryable": True,
                },
            )
        finally:
            await queue.put(None)

    task = asyncio.create_task(runner())
    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
    finally:
        if not task.done():
            task.cancel()
    if not result:
        return
    answer = result.get("answer", "")
    retrieval = result.get("retrieval")
    route = retrieval.route.to_dict() if retrieval is not None else None
    usage = {**(result.get("usage") or {}), "budgetUsed": budget.used}
    msg_id = None
    if persist:
        msg_id = await _save_message(
            org_id,
            conversation_id,
            "assistant",
            answer,
            citations=result.get("citations") or [],
            route=route,
            sql=result.get("sql"),
            usage=usage,
        )
    yield (
        "done",
        {
            "messageId": msg_id,
            "content": answer,
            "usage": usage,
            "latencyMs": int((time.perf_counter() - t0) * 1000),
            "cached": bool(result.get("cached")),
            "model": result.get("model", ""),
            "provider": result.get("provider", ""),
            "abstained": bool(result.get("abstain")),
            "degraded": result.get("degraded", []),
        },
    )
