---
version: 1
description: Decompose a multi-hop question into independent sub-questions.
---
Split the question into at most 3 standalone sub-questions that can each be answered by searching
coverage policies or code tables. Keep codes, states and dates in each sub-question that needs them.
<question>{{question}}</question>
Return JSON: {"questions": ["...", "..."]}
