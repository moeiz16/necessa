# ADR-008: DB-backed job runner inside the API process

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
Free hosting tiers rarely allow a separate always-on worker plus a broker.

## Decision
Jobs are rows in `jobs`. An asyncio worker in the API process claims and executes them with bounded concurrency, publishes progress over SSE, and resumes queued work on restart.

## Consequences
No extra infrastructure; the same handler interface can move to Arq/Celery workers when scaling out.

## Alternatives considered
Celery + Redis broker (extra service), FastAPI BackgroundTasks (not durable).
