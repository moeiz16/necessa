# ADR-009: One LangGraph workflow with specialized nodes, not multi-agent chat

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
Multi-agent conversations multiply tokens and nondeterminism, which hurts badly under free-tier quotas.

## Decision
Case evaluation and the assistant are explicit LangGraph state machines (fan-out, bounded loops, interrupts for human review, checkpoints). A second model family is used only as a verifier node.

## Consequences
Predictable cost and latency, debuggable traces, human-in-the-loop by design.

## Alternatives considered
CrewAI/AutoGen-style agent teams.
