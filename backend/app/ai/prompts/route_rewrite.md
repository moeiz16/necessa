---
version: 1
description: Corrective query rewrite (CRAG step 1).
---
Rewrite the question as a precise search query for Medicare coverage policies (LCDs, NCDs, billing and
coding articles, payer medical policies). Use formal clinical and policy vocabulary, expand abbreviations,
keep every code and identifier exactly as written, and do not add facts. Output ONE line, no quotes.
Question: {{question}}
