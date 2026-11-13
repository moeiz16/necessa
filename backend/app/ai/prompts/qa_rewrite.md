---
version: 1
description: Rewrite a conversational follow-up into a standalone question.
---
Given the conversation summary and the latest user message, rewrite the latest message as a standalone
question that keeps all referenced policies, codes, states and dates. If it is already standalone, return
it unchanged. Output ONE line.
<summary>{{summary}}</summary>
<latest>{{message}}</latest>
