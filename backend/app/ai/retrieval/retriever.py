"""HybridRetriever — the core of Necessa's hybrid RAG.

Pipeline per query (every stage timed and traced):
  understand → route (intent → strategy S1-S11) → self-query filters →
  candidate generation [Qdrant dense + Qdrant BM25 in ONE batch round-trip, DB full-text, SQL exact] →
  weighted fusion (RRF / normalized) → hydrate + post-filter → rerank (cross-encoder API → LLM
  listwise on low margin → lexical) → trust weighting (authority · recency · exact-code/key boosts) →
  dedup + MMR diversity → corrective loop (CRAG-style, ≤2 iterations, calibrated thresholds) →
  parent expansion → RetrievalResult(+RouteTrace).
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import structlog
from qdrant_client import models
from sqlalchemy import select

from app.ai import sparse
from app.ai.embeddings import embed_query
from app.ai.rerank import rerank, thresholds_for
from app.ai.retrieval.fusion import fuse
from app.ai.retrieval.intents import IntentResult, classify
from app.ai.retrieval.lexical import search_fts
from app.ai.retrieval.strategies import AUTHORITY, STRATEGIES, StrategyConfig, get_strategy
from app.ai.retrieval.types import PolicyFilters, RetrievalQuery, RetrievalResult, RetrievedChunk, RouteTrace
from app.ai.retrieval.understanding import QueryAnalysis, expand_with_synonyms, understand
from app.ai.textutil import jaccard, shingles, word_tokens
from app.ai.vectorstore import PUBLIC_TENANT, Hit, VectorStore, date_to_int, get_vectorstore, tenant_condition

log = structlog.get_logger(__name__)

try:  # pragma: no cover - optional
    from prometheus_client import Histogram

    RETRIEVAL_LATENCY = Histogram(
        "necessa_retrieval_latency_ms",
        "Retrieval latency",
        ["strategy"],
        buckets=(25, 50, 100, 250, 500, 1000, 2000, 4000, 8000),
    )
except Exception:  # pragma: no cover
    RETRIEVAL_LATENCY = None  # type: ignore[assignment]

SCOPE_ALIAS = {"policy": "policy_chunks", "criteria": "criteria", "chart": "chart_chunks"}
SECTION_PRIORITY = [
    "indication",
    "doc_reqs",
    "description",
    "limitations",
    "util_guide",
    "cms_cov_policy",
    "item_service",
    "coding_guidelines",
    "code_groups",
    "dx_support",
    "associated_info",
]
MMR_LAMBDA = 0.7
LOW_MARGIN = 0.05


@dataclass
class Candidate:
    id: str
    payload: dict
    scores: dict[str, float] = field(default_factory=dict)
    final: float = 0.0


def _qdrant_filter(q: RetrievalQuery, f: PolicyFilters) -> models.Filter:
    must: list[Any] = []
    must_not: list[Any] = []
    if q.scope == "chart":
        must.append(tenant_condition(q.org_id, include_public=False))
        if q.case_id:
            must.append(models.FieldCondition(key="case_id", match=models.MatchValue(value=str(q.case_id))))
        if q.lookback_days and f.as_of:
            start = date_to_int(f.as_of - timedelta(days=q.lookback_days))
            must.append(models.FieldCondition(key="note_date_n", range=models.Range(gte=start)))
        return models.Filter(must=must)
    must.append(tenant_condition(q.org_id, include_public=True))
    if f.policy_version_ids:
        must.append(
            models.FieldCondition(key="policy_version_id", match=models.MatchAny(any=f.policy_version_ids))
        )
    elif f.as_of:
        n = date_to_int(f.as_of)
        must.append(models.FieldCondition(key="effective_from_n", range=models.Range(lte=n)))
        must.append(models.FieldCondition(key="effective_to_n", range=models.Range(gte=n)))
    elif not f.include_history:
        must.append(models.FieldCondition(key="is_current", match=models.MatchValue(value=True)))
    if f.states:
        must.append(
            models.Filter(
                should=[
                    models.FieldCondition(
                        key="states", match=models.MatchAny(any=[s.upper() for s in f.states])
                    ),
                    models.FieldCondition(key="national", match=models.MatchValue(value=True)),
                ]
            )
        )
    if f.doc_types:
        must.append(models.FieldCondition(key="doc_type", match=models.MatchAny(any=f.doc_types)))
    if f.section_keys:
        must.append(models.FieldCondition(key="section_key", match=models.MatchAny(any=f.section_keys)))
    if f.source_keys:
        must.append(models.FieldCondition(key="source_key", match=models.MatchAny(any=f.source_keys)))
    if f.contractor_ids:
        must.append(models.FieldCondition(key="contractor_ids", match=models.MatchAny(any=f.contractor_ids)))
    if f.payer_type in {"medicare_ffs", "medicare_advantage"}:
        must_not.append(models.FieldCondition(key="source", match=models.MatchValue(value="payer")))
    return models.Filter(must=must, must_not=must_not or None)


def payload_matches(p: dict, q: RetrievalQuery, f: PolicyFilters) -> bool:
    """Python mirror of `_qdrant_filter` for candidates that arrive via the DB full-text channel."""
    tenant = p.get("tenant")
    if q.scope == "chart":
        return tenant == str(q.org_id) and (not q.case_id or p.get("case_id") == str(q.case_id))
    if tenant not in {PUBLIC_TENANT, str(q.org_id) if q.org_id else PUBLIC_TENANT}:
        return False
    if f.policy_version_ids:
        if p.get("policy_version_id") not in f.policy_version_ids:
            return False
    elif f.as_of:
        n = date_to_int(f.as_of) or 0
        if not (p.get("effective_from_n", 0) <= n <= p.get("effective_to_n", 99991231)):
            return False
    elif not f.include_history and not p.get("is_current", True):
        return False
    if f.states and not (p.get("national") or set(p.get("states", [])) & {s.upper() for s in f.states}):
        return False
    if f.doc_types and p.get("doc_type") not in f.doc_types:
        return False
    if f.section_keys and p.get("section_key") not in f.section_keys:
        return False
    if f.source_keys and p.get("source_key") not in f.source_keys:
        return False
    if f.contractor_ids and not set(p.get("contractor_ids", [])) & set(f.contractor_ids):
        return False
    return not (f.payer_type in {"medicare_ffs", "medicare_advantage"} and p.get("source") == "payer")


def _merge_filters(q: RetrievalQuery, a: QueryAnalysis, strat: StrategyConfig) -> PolicyFilters:
    f = q.filters
    out = PolicyFilters(**{k: getattr(f, k) for k in f.__dataclass_fields__})
    if out.states is None and a.states:
        out.states = a.states
    if out.as_of is None and a.as_of:
        out.as_of = a.as_of
    if out.payer_type is None and a.payer_type:
        out.payer_type = a.payer_type
    if out.doc_types is None and a.doc_types and strat.code in {"S1", "S2", "S8"}:
        out.doc_types = a.doc_types
    if strat.code == "S9":
        out.include_history = True
        if out.source_keys is None and a.source_keys:
            out.source_keys = a.source_keys
    return out


def _source_dict(p: dict) -> dict:
    if p.get("kind") == "chart":
        return {
            "kind": "chart",
            "case_id": p.get("case_id"),
            "document_id": p.get("document_id"),
            "note_date": p.get("note_date"),
            "section": p.get("section"),
        }
    if p.get("kind") == "criterion":
        return {
            "kind": "criterion",
            "criterion_id": p.get("criterion_id"),
            "policy_version_id": p.get("policy_version_id"),
            "source_key": p.get("source_key"),
            "title": p.get("title"),
            "quote": p.get("quote"),
        }
    return {
        k: p.get(k)
        for k in (
            "policy_id",
            "policy_version_id",
            "source_key",
            "source",
            "title",
            "doc_type",
            "section_key",
            "section_title",
            "version",
            "effective_from",
            "effective_to",
            "url",
            "is_current",
            "status",
            "parent_id",
        )
    } | {"kind": "policy"}


class HybridRetriever:
    def __init__(self, store: VectorStore | None = None) -> None:
        self._store = store

    async def store(self) -> VectorStore:
        return self._store or await get_vectorstore()

    # ── public API ──────────────────────────────────────────────────────────
    async def search(self, q: RetrievalQuery, *, collection: str | None = None) -> RetrievalResult:
        t_all = time.perf_counter()
        timings: dict[str, float] = {}
        t = time.perf_counter()
        a = understand(q.text)
        timings["understandMs"] = _ms(t)

        t = time.perf_counter()
        intent = await self._route(q, a)
        strat = STRATEGIES[intent.intent]
        timings["routeMs"] = _ms(t)
        trace = RouteTrace(
            intent=intent.intent,
            confidence=round(intent.confidence, 3),
            strategy=f"{strat.code} · {strat.label}",
            reason=f"{intent.method}: {intent.reason}",
            entities=a.entities(),
        )
        if strat.abstain:
            trace.abstained = True
            trace.reason += " — outside the scope of a coverage-documentation assistant"
            return RetrievalResult([], trace, timings | {"totalMs": _ms(t_all)})
        if strat.text_to_sql:
            trace.retrievers = ["text_to_sql"]
            return RetrievalResult([], trace, timings | {"totalMs": _ms(t_all)})

        f = _merge_filters(q, a, strat)
        trace.filters_applied = {
            k: (v.isoformat() if isinstance(v, date) else v)
            for k, v in f.__dict__.items()
            if v not in (None, False, [])
        }
        store = await self.store()
        coll = collection
        if coll is None:
            scope = q.scope
            alias = SCOPE_ALIAS[scope]
            if await store.current_physical(alias) is None:
                if scope == "criteria":  # fall back to policy documentation sections
                    q.scope = "policy"
                    alias = SCOPE_ALIAS["policy"]
                    trace.transforms.append("criteria_index_missing→policy_sections")
                if await store.current_physical(alias) is None:
                    trace.degraded.append("no_index")
                    trace.abstained = True
                    trace.reason += " — no active index (run ingestion)"
                    return RetrievalResult([], trace, timings | {"totalMs": _ms(t_all)})
            coll = store.alias_name(alias)

        query_text = expand_with_synonyms(a) if strat.expand_synonyms else a.expanded
        if strat.expand_synonyms and a.synonym_expansion:
            trace.transforms.append("synonym_expansion")
        if a.abbreviations:
            trace.transforms.append("abbreviation_expansion")

        t = time.perf_counter()
        if strat.decompose:
            cands = await self._decomposed(q, a, f, strat, coll, trace)
        else:
            cands = await self._candidates(q, a, f, strat, coll, query_text, trace)
        timings["retrieveMs"] = _ms(t)

        t = time.perf_counter()
        ranked, provider = await self._rank(q, a, strat, cands, trace)
        timings["rerankMs"] = _ms(t)

        # corrective loop (CRAG-style), bounded
        if q.allow_corrective and strat.rerank and ranked:
            ranked = await self._corrective(q, a, f, strat, coll, ranked, provider, trace, timings)
        elif not ranked:
            trace.abstained = True
            trace.reason += " — no candidates passed filters"

        final = self._diversify(ranked, q.top_k)
        chunks = [self._to_chunk(c) for c in final]
        if q.scope == "policy":
            await self._expand_parents(chunks)
        timings["totalMs"] = _ms(t_all)
        if RETRIEVAL_LATENCY is not None:
            RETRIEVAL_LATENCY.labels(strat.code).observe(timings["totalMs"])
        return RetrievalResult(chunks, trace, timings)

    # ── routing ─────────────────────────────────────────────────────────────
    async def _route(self, q: RetrievalQuery, a: QueryAnalysis) -> IntentResult:
        if q.strategy:
            s = get_strategy(q.strategy)
            return IntentResult(s.intent, 1.0, "strategy forced by caller", "forced")
        if q.scope == "chart":
            return IntentResult("chart_evidence", 1.0, "chart evidence scope", "scope")
        if q.scope == "criteria":
            return IntentResult("denial_mapping", 1.0, "criteria scope", "scope")
        return await classify(a)

    # ── candidate generation ───────────────────────────────────────────────
    async def _candidates(
        self,
        q: RetrievalQuery,
        a: QueryAnalysis,
        f: PolicyFilters,
        strat: StrategyConfig,
        coll: str,
        query_text: str,
        trace: RouteTrace,
        *,
        dense_override: list[float] | None = None,
    ) -> dict[str, Candidate]:
        store = await self.store()
        flt = _qdrant_filter(q, f)
        w = dict(strat.weights)
        limit = max(strat.candidates, q.top_k * 3)
        dense_vec = dense_override
        if dense_vec is None and w.get("dense", 0) > 0:
            dense_vec = await embed_query(query_text, purpose="retrieval.query")
            if dense_vec is None and "dense" not in trace.degraded:
                trace.degraded.append("dense")
        sparse_vec = sparse.encode_query(query_text) if w.get("sparse", 0) > 0 else None

        async def _fts() -> list[tuple[str, float]]:
            if w.get("fts", 0) <= 0 or q.scope != "policy":
                return []
            from app.db.session import session_scope

            try:
                async with session_scope() as s:
                    return await search_fts(s, query_text, limit)
            except Exception as exc:
                log.debug("retrieval.fts_failed", error=str(exc))
                return []

        async def _sql_exact() -> list[tuple[str, float]]:
            if not strat.sql_exact or not (a.source_keys or a.service_codes):
                return []
            return await self._sql_exact(a, f, coll, q)

        channels_task = store.search_channels(coll, dense=dense_vec, sparse=sparse_vec, flt=flt, limit=limit)
        channels, fts_hits, sql_hits = await asyncio.gather(channels_task, _fts(), _sql_exact())
        rankings: dict[str, list[tuple[str, float]]] = {}
        payloads: dict[str, dict] = {}
        for name, hits in channels.items():
            rankings[name] = [(h.id, h.score) for h in hits]
            for h in hits:
                payloads.setdefault(h.id, h.payload)
        if fts_hits:
            rankings["fts"] = fts_hits
        if sql_hits:
            rankings["sql"] = sql_hits
            w["sql"] = 1.0
        for ch in rankings:
            if ch not in trace.retrievers:
                trace.retrievers.append(ch)
        fused = fuse(rankings, w, strat.fusion)
        trace.fusion = f"{strat.fusion}(k=60)" if strat.fusion == "rrf" else strat.fusion
        top = fused[: max(strat.candidates, q.top_k * 3)]
        missing = [i for i, _ in top if i not in payloads]
        if missing:
            for h in await store.retrieve(coll, missing):
                payloads[h.id] = h.payload
        raw_scores = {ch: dict(hits) for ch, hits in rankings.items()}
        out: dict[str, Candidate] = {}
        for doc_id, fscore in top:
            p = payloads.get(doc_id)
            if p is None or not payload_matches(p, q, f):
                continue
            sc = {ch: round(raw_scores[ch][doc_id], 5) for ch in raw_scores if doc_id in raw_scores[ch]}
            sc["fused"] = round(fscore, 6)
            out[doc_id] = Candidate(id=doc_id, payload=p, scores=sc)
        trace.candidates = max(trace.candidates, len(out))
        return out

    async def _sql_exact(
        self, a: QueryAnalysis, f: PolicyFilters, coll: str, q: RetrievalQuery
    ) -> list[tuple[str, float]]:
        from app.db.models.knowledge import Policy, PolicyCode
        from app.db.session import session_scope

        version_ids: list[str] = []
        try:
            async with session_scope() as s:
                if a.source_keys:
                    rows = (
                        (
                            await s.execute(
                                select(Policy.current_version_id).where(Policy.source_key.in_(a.source_keys))
                            )
                        )
                        .scalars()
                        .all()
                    )
                    version_ids += [str(r) for r in rows if r]
                if a.service_codes:
                    rows = (
                        (
                            await s.execute(
                                select(PolicyCode.policy_version_id)
                                .where(
                                    PolicyCode.code_system == "HCPCS", PolicyCode.code.in_(a.service_codes)
                                )
                                .distinct()
                                .limit(20)
                            )
                        )
                        .scalars()
                        .all()
                    )
                    version_ids += [str(r) for r in rows]
        except Exception as exc:
            log.debug("retrieval.sql_exact_failed", error=str(exc))
            return []
        if not version_ids:
            return []
        store = await self.store()
        flt = models.Filter(
            must=[
                tenant_condition(q.org_id),
                models.FieldCondition(
                    key="policy_version_id", match=models.MatchAny(any=list(dict.fromkeys(version_ids)))
                ),
            ]
        )
        hits = await store.scroll_filter(coll, flt, limit=64)
        prio = {k: i for i, k in enumerate(SECTION_PRIORITY)}
        hits.sort(
            key=lambda h: (
                0 if h.payload.get("source_key") in a.source_keys else 1,
                prio.get(h.payload.get("section_key", ""), 99),
                h.payload.get("ordinal", 0),
            )
        )
        return [(h.id, 1.0 / (i + 1)) for i, h in enumerate(hits[:30])]

    async def _decomposed(
        self,
        q: RetrievalQuery,
        a: QueryAnalysis,
        f: PolicyFilters,
        strat: StrategyConfig,
        coll: str,
        trace: RouteTrace,
    ) -> dict[str, Candidate]:
        subs = await decompose(a)
        trace.transforms.append(f"decomposition({len(subs)})")
        merged: dict[str, Candidate] = {}
        for sq in subs:
            sub_a = understand(sq)
            cands = await self._candidates(q, sub_a, f, STRATEGIES["conceptual"], coll, sub_a.expanded, trace)
            for cid, c in cands.items():
                if cid not in merged or c.scores.get("fused", 0) > merged[cid].scores.get("fused", 0):
                    merged[cid] = c
        return merged

    # ── ranking ─────────────────────────────────────────────────────────────
    async def _rank(
        self,
        q: RetrievalQuery,
        a: QueryAnalysis,
        strat: StrategyConfig,
        cands: dict[str, Candidate],
        trace: RouteTrace,
    ) -> tuple[list[Candidate], str]:
        if not cands:
            return [], "none"
        items = sorted(cands.values(), key=lambda c: -c.scores.get("fused", 0))
        provider = "fused"
        fmax = max(c.scores.get("fused", 0) for c in items) or 1.0
        for c in items:
            c.scores["base"] = c.scores.get("fused", 0) / fmax
        if strat.rerank and len(items) > 1:
            docs = [f"{c.payload.get('header', '')}\n{c.payload.get('text', '')}"[:2000] for c in items]
            pairs, provider, _ms = await rerank(
                a.normalized, docs, top_n=min(len(items), max(q.top_k * 2, 10))
            )
            trace.rerank = provider
            if provider == "lexical" and "rerank" not in trace.degraded:
                trace.degraded.append("rerank")
            reranked_ids = set()
            for idx, score in pairs:
                items[idx].scores["rerank"] = round(score, 5)
                items[idx].scores["base"] = score
                reranked_ids.add(idx)
            # candidates the reranker did not return keep a damped fused score
            for i, c in enumerate(items):
                if i not in reranked_ids:
                    c.scores["base"] = 0.25 * c.scores["base"] * (min(s for _, s in pairs) if pairs else 0.1)
            items.sort(key=lambda c: -c.scores["base"])
            if (
                provider in {"cohere", "jina"}
                and len(items) >= 3
                and (items[0].scores["base"] - items[1].scores["base"] < LOW_MARGIN or strat.decompose)
            ):
                await self._llm_listwise(a, items, trace)
        # trust weighting + exact-entity boosts
        for c in items:
            p = c.payload
            authority = AUTHORITY.get(p.get("doc_type", ""), 0.8)
            recency = 1.0 if p.get("is_current", True) else 0.8
            if p.get("status") == "retired":
                recency *= 0.85
            boost = 0.0
            if p.get("source_key") and p.get("source_key") in a.source_keys:
                boost += 0.25
            if a.service_codes and set(a.service_codes) & set(p.get("codes", [])):
                boost += 0.1
            if p.get("section_key") in strat.section_boost or p.get("section_key") in a.section_hints:
                boost += 0.05
            if q.filters.payer_type == "commercial" and p.get("source") == "payer":
                boost += 0.05
            c.final = round(c.scores["base"] * (0.85 + 0.15 * authority * recency) + boost, 6)
            c.scores["final"] = c.final
        items.sort(key=lambda c: -c.final)
        return items, provider

    async def _llm_listwise(self, a: QueryAnalysis, items: list[Candidate], trace: RouteTrace) -> None:
        from app.ai.llm.router import get_llm_router

        router = get_llm_router()
        if (
            getattr(router, "fake", False)
            or not hasattr(router, "_llm_listwise")
            or not router.is_available("router-small")
        ):
            return
        head = items[:8]
        try:
            pairs = await router._llm_listwise(
                a.normalized,
                [f"{c.payload.get('title')}: {c.payload.get('text')}" for c in head],
                len(head),
                "router-small",
                "retrieval.listwise",
            )
        except Exception as exc:
            log.debug("retrieval.listwise_failed", error=str(exc))
            return
        llm_scores = dict(pairs)
        for i, c in enumerate(head):
            c.scores["llm"] = llm_scores.get(i, 0.0)
            c.scores["base"] = 0.5 * c.scores["base"] + 0.5 * c.scores["llm"]
        head.sort(key=lambda c: -c.scores["base"])
        items[:8] = head
        trace.rerank = f"{trace.rerank}+llm-listwise"

    async def _corrective(
        self,
        q: RetrievalQuery,
        a: QueryAnalysis,
        f: PolicyFilters,
        strat: StrategyConfig,
        coll: str,
        ranked: list[Candidate],
        provider: str,
        trace: RouteTrace,
        timings: dict[str, float],
    ) -> list[Candidate]:
        th = thresholds_for(provider)
        best = ranked[0].scores.get("rerank", ranked[0].scores.get("base", 0)) if ranked else 0.0
        if best >= th["high"]:
            return ranked
        t = time.perf_counter()
        current = ranked
        for iteration in (1, 2):
            if best >= th["high"]:
                break
            trace.corrective_iterations = iteration
            f2 = PolicyFilters(**{k: getattr(f, k) for k in f.__dataclass_fields__})
            dense_override = None
            if iteration == 1:
                text = expand_with_synonyms(a)
                rewritten = await rewrite_query(a)
                if rewritten:
                    text = f"{text} {rewritten}"
                    trace.transforms.append("llm_rewrite")
                trace.transforms.append("corrective:expand")
            else:
                text = expand_with_synonyms(a)
                if f2.section_keys:
                    f2.section_keys = None
                    trace.transforms.append("corrective:relax_sections")
                elif f2.states:
                    f2.states = None
                    trace.transforms.append("corrective:relax_states")
                hyde_vec = await hyde_vector(a)
                if hyde_vec is not None:
                    dense_override = hyde_vec
                    trace.transforms.append("hyde")
            cands = await self._candidates(q, a, f2, strat, coll, text, trace, dense_override=dense_override)
            # keep previous candidates in the pool so a refinement can only help
            for c in current:
                cands.setdefault(c.id, c)
            new_ranked, provider = await self._rank(q, a, strat, cands, trace)
            new_best = (
                new_ranked[0].scores.get("rerank", new_ranked[0].scores.get("base", 0)) if new_ranked else 0
            )
            if new_best >= best:
                current, best = new_ranked, new_best
            th = thresholds_for(provider)
        timings["correctiveMs"] = _ms(t)
        if best < th["low"] and not (
            a.source_keys and any(c.payload.get("source_key") in a.source_keys for c in current[:3])
        ):
            trace.abstained = True
            trace.reason += (
                f" — low retrieval confidence ({best:.2f} < {th['low']}) after corrective retrieval"
            )
        return current

    # ── post-processing ─────────────────────────────────────────────────────
    def _diversify(self, ranked: list[Candidate], k: int) -> list[Candidate]:
        """Near-duplicate removal (5-shingle Jaccard > 0.85) then MMR (λ=0.7) over token sets."""
        pool: list[tuple[Candidate, set, set]] = []
        for c in ranked[: max(k * 4, 20)]:
            sh = shingles(c.payload.get("text", ""))
            if any(jaccard(sh, other_sh) > 0.85 for _, other_sh, _ in pool):
                continue
            pool.append((c, sh, set(word_tokens(c.payload.get("text", "")))))
        if not pool:
            return []
        top = max(c.final for c, _, _ in pool) or 1.0
        selected: list[tuple[Candidate, set, set]] = []
        remaining = list(pool)
        while remaining and len(selected) < k:

            def mmr(item: tuple[Candidate, set, set]) -> float:
                rel = item[0].final / top
                sim = max((jaccard(item[2], s[2]) for s in selected), default=0.0)
                return MMR_LAMBDA * rel - (1 - MMR_LAMBDA) * sim

            best = max(remaining, key=mmr)
            selected.append(best)
            remaining.remove(best)
        return [c for c, _, _ in selected]

    def _to_chunk(self, c: Candidate) -> RetrievedChunk:
        p = c.payload
        return RetrievedChunk(
            chunk_id=c.id,
            text=p.get("text", ""),
            header=p.get("header", ""),
            score=c.final,
            scores=c.scores,
            source=_source_dict(p),
            char_start=p.get("char_start"),
            char_end=p.get("char_end"),
        )

    async def _expand_parents(self, chunks: list[RetrievedChunk]) -> None:
        parent_ids = {c.source.get("parent_id") for c in chunks if c.source.get("parent_id")}
        if not parent_ids:
            return
        from app.db.models.knowledge import PolicyChunk
        from app.db.session import session_scope

        try:
            async with session_scope() as s:
                rows = (
                    await s.execute(
                        select(PolicyChunk.id, PolicyChunk.text).where(
                            PolicyChunk.id.in_([uuid.UUID(p) for p in parent_ids])
                        )
                    )
                ).all()
        except Exception as exc:
            log.debug("retrieval.parent_expand_failed", error=str(exc))
            return
        texts = {str(r[0]): r[1] for r in rows}
        for c in chunks:
            pid = c.source.get("parent_id")
            if pid and pid in texts:
                c.source["parent_text"] = texts[pid]


# ── query transforms (LLM when available, rules otherwise) ─────────────────
async def decompose(a: QueryAnalysis) -> list[str]:
    from app.ai.llm.router import get_llm_router

    router = get_llm_router()
    if not getattr(router, "fake", False) and router.is_available("router-small"):
        try:
            from pydantic import BaseModel

            from app.ai.prompts.loader import render

            class _Subs(BaseModel):
                questions: list[str]

            prompt, _ = render("route_decompose", question=a.normalized)
            res = await router.complete(
                group="router-small",
                purpose="route.decompose",
                messages=[{"role": "user", "content": prompt}],
                response_model=_Subs,
                max_tokens=200,
            )
            subs = [s for s in res.parsed.questions if s.strip()][:3]  # type: ignore[union-attr]
            if subs:
                return subs
        except Exception as exc:
            log.debug("decompose.llm_failed", error=str(exc))
    parts = [p.strip(" ?.") for p in a.normalized.replace("?", " ? ").split(" and ") if len(p.split()) >= 3]
    return parts[:3] or [a.normalized]


async def rewrite_query(a: QueryAnalysis) -> str | None:
    from app.ai.llm.router import get_llm_router

    router = get_llm_router()
    if getattr(router, "fake", False) or not router.is_available("router-small"):
        return None
    try:
        from app.ai.prompts.loader import render

        prompt, _ = render("route_rewrite", question=a.normalized)
        res = await router.complete(
            group="router-small",
            purpose="route.rewrite",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=120,
        )
        return res.text.strip().splitlines()[0][:300] if res.text.strip() else None
    except Exception:
        return None


async def hyde_vector(a: QueryAnalysis) -> list[float] | None:
    """Hypothetical Document Embedding: embed a model-written policy-style passage."""
    from app.ai.llm.router import get_llm_router

    router = get_llm_router()
    if getattr(router, "fake", False) or not router.is_available("router-small"):
        return None
    try:
        from app.ai.prompts.loader import render

        prompt, _ = render("route_hyde", question=a.normalized)
        res = await router.complete(
            group="router-small",
            purpose="route.hyde",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=220,
        )
        return await embed_query(res.text, purpose="retrieval.hyde")
    except Exception:
        return None


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 1)


_retriever: HybridRetriever | None = None


def get_retriever() -> HybridRetriever:
    global _retriever
    if _retriever is None:
        _retriever = HybridRetriever()
    return _retriever


__all__ = [
    "Hit",
    "HybridRetriever",
    "PolicyFilters",
    "RetrievalQuery",
    "RetrievalResult",
    "RetrievedChunk",
    "RouteTrace",
    "get_retriever",
]
