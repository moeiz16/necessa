"""Retrieval smoke eval — the gate before a new index version's alias is activated.

Cheap, deterministic, no LLM: for a sample of indexed policies, the title (concept channel) and the
source key (identifier channel) must retrieve the policy in the top 10 of the NEW physical collection.
"""

from __future__ import annotations

import random

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.retrieval.retriever import HybridRetriever
from app.ai.retrieval.types import PolicyFilters, RetrievalQuery
from app.db.models.knowledge import Policy

PASS_THRESHOLD = 0.6


async def run_smoke_eval(session: AsyncSession, *, physical: str, sample: int = 20, seed: int = 7) -> dict:
    policies = list(
        (await session.execute(select(Policy).where(Policy.current_version_id.is_not(None)))).scalars()
    )
    if not policies:
        return {"passed": True, "reason": "empty corpus", "n": 0}
    rng = random.Random(seed)  # noqa: S311 - deterministic sampling, not security
    picks = rng.sample(policies, min(sample, len(policies)))
    retriever = HybridRetriever()
    title_hits = key_hits = 0
    misses: list[str] = []
    for p in picks:
        for kind, text, strategy in (("title", p.title, "S4"), ("key", p.source_key, "S6")):
            res = await retriever.search(
                RetrievalQuery(
                    text=text,
                    org_id=None,
                    top_k=10,
                    strategy=strategy,
                    allow_corrective=False,
                    filters=PolicyFilters(include_history=True),
                ),
                collection=physical,
            )
            ok = any(c.source.get("source_key") == p.source_key for c in res.chunks)
            if kind == "title":
                title_hits += ok
            else:
                key_hits += ok
            if not ok:
                misses.append(f"{kind}:{p.source_key}")
    n = len(picks)
    title_rate = title_hits / n
    key_rate = key_hits / n
    return {
        "passed": title_rate >= PASS_THRESHOLD,
        "n": n,
        "titleHitAt10": round(title_rate, 3),
        "keyHitAt10": round(key_rate, 3),
        "misses": misses[:20],
        "threshold": PASS_THRESHOLD,
    }
