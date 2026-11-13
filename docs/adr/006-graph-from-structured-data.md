# ADR-006: Coverage graph from structured CMS tables

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
Many coverage questions are multi-hop (code → article → LCD → contractor → state). LLM-extracted knowledge graphs are expensive and noisy.

## Decision
Build graph edges directly from CMS relational exports and traverse them with recursive SQL. No separate graph database in v1.

## Consequences
Exact, free to build, versioned with the data. A graph DB (Neo4j) stays an option if traversal depth or query volume demands it.

## Alternatives considered
Microsoft GraphRAG-style LLM extraction; Neo4j from day one.
