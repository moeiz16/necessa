---
version: 1
description: Rolling conversation summary (memory compression).
---
Summarize the conversation so far in at most 120 words for use as context in later turns. Keep every
policy identifier, code, state, payer, date and open question verbatim. Do not add new facts.
<conversation>
{{conversation}}
</conversation>
