---
version: 1
description: Self-correction after a validation or database error.
---
The previous SQL was rejected:
<sql>{{sql}}</sql>
<error>{{error}}</error>
Fix it for {{dialect}} using only the allowed views and columns. Return JSON: {"sql": "...", "explanation": "..."}
