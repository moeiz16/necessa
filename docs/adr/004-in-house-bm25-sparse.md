# ADR-004: Compute BM25 sparse vectors in pure Python

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
Sparse retrieval matters for codes and rare terms, but learned sparse models (SPLADE, bge-m3 lexical) need local inference.

## Decision
Tokenize with a code-preserving tokenizer, snowball stemming and stopwords, hash terms to stable uint32 ids, and compute BM25 term-frequency saturation client-side. Qdrant applies IDF server-side via `Modifier.IDF`.

## Consequences
Deterministic, zero cost, no model, works offline, and handles identifiers such as E0601 or M17.11 exactly. Less semantic than learned sparse models, which dense retrieval covers.

## Alternatives considered
SPLADE / bge-m3 sparse (local inference), Postgres FTS alone (kept as an extra lexical channel).
