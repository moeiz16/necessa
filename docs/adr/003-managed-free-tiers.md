# ADR-003: Cloud free tiers instead of local inference

- **Status:** Accepted
- **Date:** 2026-11-13

## Context
The development machine has 8 GB RAM and no spare capacity for local models. Total footprint must stay under 5 GB, and run cost must be $0.

## Decision
All LLM, embedding, rerank and OCR calls go to free cloud tiers through LiteLLM (Groq, Gemini, OpenRouter, Cohere, Jina, optional Mistral/Cerebras/GitHub Models). Infrastructure uses Neon, Qdrant Cloud and Upstash free tiers. Missing keys disable deployments instead of failing.

## Consequences
Zero local resource use, and provider diversity enables cross-family verification. Trade-offs: rate limits and churn (mitigated by quotas, cooldowns, fallbacks and the degradation ladder), and free tiers carry no BAA (mitigated by synthetic-only data, mandatory de-identification, and data-class routing that production can point at BAA endpoints).

## Alternatives considered
Ollama/vLLM locally (not viable on this hardware); a single paid provider (cost, lock-in).
