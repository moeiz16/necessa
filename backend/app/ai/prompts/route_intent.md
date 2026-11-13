---
version: 1
description: Fallback intent classification for the retrieval router.
---
Classify the user's question for a Medicare / payer coverage-policy assistant into exactly one intent.
Intents: {{intents}}
- exact_lookup: asks about a specific identifier (LCD/Article/NCD id, a single code).
- structured_fact: relational facts (which policies list a code, covered diagnoses, contractors, states).
- analytics: aggregates over the organization's own cases/denials/letters.
- conceptual: what a policy requires / when something is covered.
- lay_language: informal wording without clinical/policy vocabulary.
- keyword_heavy: rare codes, modifiers, brand names inside a question.
- multi_hop: needs both a structured fact and policy text (e.g. "is X covered in Y and what documentation").
- version_compare: what changed between versions / revision history.
- denial_mapping: denial letters, reason codes, appeals.
- out_of_scope: clinical advice, diagnosis, dosing, or unrelated topics.
<question>{{question}}</question>
Return JSON: {"intent": "<one intent>", "confidence": 0..1}
