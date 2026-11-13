"""Reranking facade (cross-encoder APIs → LLM listwise → lexical), with calibrated thresholds."""

from __future__ import annotations

import time

from app.ai.llm.config import get_catalog
from app.ai.llm.router import get_llm_router

_DEFAULT_THRESHOLDS = {"high": 0.35, "low": 0.08}


def thresholds_for(provider: str) -> dict[str, float]:
    return get_catalog().rerank_thresholds.get(provider, _DEFAULT_THRESHOLDS)


async def rerank(query: str, documents: list[str], top_n: int) -> tuple[list[tuple[int, float]], str, float]:
    """Returns ([(doc_index, score)], provider_name, latency_ms)."""
    t0 = time.perf_counter()
    pairs, provider = await get_llm_router().rerank_with_info(query, documents, top_n=top_n)
    return pairs, provider, (time.perf_counter() - t0) * 1000
