# ADR-007: Parameterized tools first, validated text-to-SQL for the long tail

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
Free-form SQL generation is powerful but risky (wrong joins, data exposure, injection).

## Decision
Common structured questions use typed, tested tool functions. The long tail uses text-to-SQL over allowlisted views with sqlglot AST validation, tenant predicates, LIMIT, timeouts, a read-only session and self-correction.

## Consequences
High accuracy on frequent questions, defense in depth on generated SQL, and the SQL is always shown to the user.

## Alternatives considered
Text-to-SQL for everything; no NL analytics at all.
