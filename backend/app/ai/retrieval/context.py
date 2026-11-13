"""Token-budgeted context packing for generation.

* Budget = total - system - instructions - schema - answer reserve.
* Prefers the parent span ("match small, return big") when it fits, else the child.
* Extractive compression (no LLM): keeps the sentences most similar to the query within each chunk.
* Lost-in-the-middle mitigation: the strongest sources go first and last; weaker ones in the middle.
* Numbered `<source n=…>` blocks with metadata attributes; text sanitized against role injection.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from html import escape

from app.ai.guardrails.injection import sanitize_for_prompt
from app.ai.retrieval.types import RetrievedChunk
from app.ai.textutil import estimate_tokens, split_sentences, word_tokens


@dataclass
class PackedSource:
    n: int
    chunk: RetrievedChunk
    text: str
    compressed: bool = False


@dataclass
class PackedContext:
    xml: str
    sources: list[PackedSource] = field(default_factory=list)
    tokens: int = 0
    dropped: int = 0

    def citation_map(self) -> dict[int, RetrievedChunk]:
        return {s.n: s.chunk for s in self.sources}


def _compress(text: str, query: str, max_tokens: int) -> tuple[str, bool]:
    if estimate_tokens(text) <= max_tokens:
        return text, False
    q = set(word_tokens(query))
    sents = split_sentences(text)
    scored = [(len(q & set(word_tokens(s))) / (len(q) or 1), i, s) for i, s in enumerate(sents)]
    keep: list[tuple[int, str]] = []
    used = 0
    for _score, i, s in sorted(scored, key=lambda x: (-x[0], x[1])):
        t = estimate_tokens(s)
        if used + t > max_tokens:
            continue
        keep.append((i, s))
        used += t
    keep.sort()
    out = []
    prev = -2
    for i, s in keep:
        if i != prev + 1 and out:
            out.append("…")
        out.append(s)
        prev = i
    return " ".join(out), True


def lost_in_middle_order(items: list) -> list:
    """[1,2,3,4,5,6] → [1,3,5,6,4,2]: best at both ends."""
    front = items[0::2]
    back = items[1::2][::-1]
    return front + back


class ContextPacker:
    def __init__(
        self, budget_tokens: int = 3500, per_source_max: int = 700, prefer_parent: bool = True
    ) -> None:
        self.budget = budget_tokens
        self.per_source_max = per_source_max
        self.prefer_parent = prefer_parent

    def pack(self, query: str, chunks: list[RetrievedChunk]) -> PackedContext:
        used = 0
        packed: list[PackedSource] = []
        dropped = 0
        for n, ch in enumerate(chunks, start=1):
            base = ch.text
            parent = ch.source.get("parent_text") if self.prefer_parent else None
            if parent and estimate_tokens(parent) <= self.per_source_max:
                base = parent
            text, compressed = _compress(base, query, self.per_source_max)
            t = estimate_tokens(text) + 40
            if used + t > self.budget:
                text, compressed = _compress(base, query, max(80, self.budget - used - 40))
                t = estimate_tokens(text) + 40
                if used + t > self.budget:
                    dropped += 1
                    continue
            packed.append(PackedSource(n=n, chunk=ch, text=text, compressed=compressed))
            used += t
        ordered = lost_in_middle_order(packed)
        parts = []
        for s in ordered:
            src = s.chunk.source
            attrs = {
                "n": s.n,
                "key": src.get("source_key") or src.get("document_id") or "",
                "title": src.get("title") or "",
                "section": src.get("section_title") or src.get("section") or "",
                "version": src.get("version") or "",
                "effective": src.get("effective_from") or src.get("note_date") or "",
            }
            attr_s = " ".join(f'{k}="{escape(str(v), quote=True)}"' for k, v in attrs.items())
            parts.append(f"<source {attr_s}>\n{sanitize_for_prompt(s.text)}\n</source>")
        return PackedContext(
            xml="<sources>\n" + "\n".join(parts) + "\n</sources>",
            sources=packed,
            tokens=used,
            dropped=dropped,
        )
