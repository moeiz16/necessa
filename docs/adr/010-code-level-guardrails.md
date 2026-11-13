# ADR-010: Guardrails as tested code + small model checks

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
Guardrail frameworks add dependencies, and several need local models.

## Decision
Implement guardrails in code: Pydantic schemas, verbatim citation checks, regex/known-identifier de-identification, injection heuristics plus a `guard` model, and a policy-language filter.

## Consequences
Explicit, unit-tested and dependency-light. Frameworks can wrap these later.

## Alternatives considered
NeMo Guardrails / Guardrails AI as the core.
