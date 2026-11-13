# ADR-011: No fine-tuning in v1

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
Policies change weekly and answers must cite sources; free tiers don't offer fine-tuning anyway.

## Decision
Improve quality through retrieval, reranking, prompts and verification first. Revisit only if evals plateau, using counterfactual synthetic labels.

## Consequences
Knowledge stays fresh and auditable at $0.

## Alternatives considered
LoRA/QLoRA on a judge model.
