# ADR-001: Evaluate atomic criteria, aggregate deterministically

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
Prior-auth reviewers check policies criterion by criterion. Asking one LLM call for a holistic yes/no hides which requirement failed, and in the open-source projects we reviewed it tends to count absence of evidence as 'met'.

## Decision
Compile each policy into an AND/OR/N-of-M criteria tree whose leaves carry verbatim source spans. Judge each leaf separately against retrieved chart evidence as MET / NOT_MET / INSUFFICIENT, then aggregate with Kleene three-valued logic in code.

## Consequences
Explainable, testable per criterion, cheap to re-run a single criterion, and safe by construction ('unknown' propagates). Costs one LLM call per criterion instead of one per case; bounded concurrency keeps this within free-tier RPM.

## Alternatives considered
Holistic single-prompt judgment; rules-only matching (too brittle for narrative notes).
