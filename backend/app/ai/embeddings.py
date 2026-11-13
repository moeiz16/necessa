"""Dense embedding helpers. Degrade (return None) instead of failing when the pinned model is down."""

from __future__ import annotations

import structlog

from app.ai.llm.router import get_llm_router
from app.ai.llm.types import EmbeddingUnavailable

log = structlog.get_logger(__name__)


def embedding_model_id() -> str:
    router = get_llm_router()
    if getattr(router, "fake", False):
        return "fake/hash-embedding"
    return router.catalog.embedding.model


def embedding_dims() -> int:
    from app.core.config import get_settings

    return int(get_settings().embedding_dims)


def embeddings_available() -> bool:
    return bool(get_llm_router().embedding_available())


async def embed_documents(texts: list[str], purpose: str = "index") -> list[list[float]] | None:
    if not texts:
        return []
    try:
        return await get_llm_router().embed(texts, task="document", purpose=purpose)
    except EmbeddingUnavailable as exc:
        log.warning("embeddings.unavailable", error=str(exc))
        return None


async def embed_query(text: str, purpose: str = "query") -> list[float] | None:
    try:
        vecs = await get_llm_router().embed([text], task="query", purpose=purpose)
        return vecs[0] if vecs else None
    except EmbeddingUnavailable as exc:
        log.info("embeddings.query_degraded", error=str(exc))
        return None
