# ADR-005: Postgres as the system of record; vectors are a derived index

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
Indexes must be rebuildable, auditable and versioned, and citations must be verified against canonical text.

## Decision
All policies, versions, sections, chunks, codes, cases and audit live in Postgres (Neon). Qdrant holds only vectors + payload derived from Postgres rows (point id = chunk id).

## Consequences
Reindexing is safe and repeatable (blue/green); verbatim quote checks run against canonical rows; RLS provides tenant defense in depth. SQLite is supported for tests and offline dev through portable column types.

## Alternatives considered
Vector DB as primary store (no transactions or joins, harder audit).
