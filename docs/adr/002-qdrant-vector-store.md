# ADR-002: Qdrant for dense + sparse vectors

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
We need dense and sparse vectors in one query with server-side fusion, payload filtering inside ANN search, tenant isolation, aliases for zero-downtime reindexing, and a free managed tier. ChromaDB is excluded by project constraint.

## Decision
Use Qdrant: Cloud free tier (1 GB RAM / 4 GB disk) in cloud mode, embedded local mode for offline dev, `:memory:` for tests.

## Consequences
One client API in all three modes. Native named dense + sparse vectors with the IDF modifier, Query API prefetch + RRF, payload indexes with `is_tenant`, collection aliases. Free-tier clusters may pause when inactive, so readiness checks report it and retrieval falls back to FTS.

## Alternatives considered
pgvector (simpler, but weaker sparse/hybrid support), Pinecone (no self-host or offline mode), Weaviate/Milvus (heavier), LanceDB (fine, but less mature hybrid filtering).
