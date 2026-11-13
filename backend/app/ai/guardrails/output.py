"""Output guardrails: verbatim-quote verification and citation validation."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.ai.textutil import normalize_unicode


def _normalize_with_map(text: str) -> tuple[str, list[int]]:
    """Lowercase, unify quotes/dashes, collapse whitespace; keep a map back to original offsets."""
    out_chars: list[str] = []
    mapping: list[int] = []
    prev_space = True
    for i, ch in enumerate(text):
        c = normalize_unicode(ch).lower()
        if not c:
            continue
        if c.isspace():
            if prev_space:
                continue
            out_chars.append(" ")
            mapping.append(i)
            prev_space = True
            continue
        for cc in c:
            out_chars.append(cc)
            mapping.append(i)
        prev_space = False
    if out_chars and out_chars[-1] == " ":
        out_chars.pop()
        mapping.pop()
    return "".join(out_chars), mapping


def verify_quote(quote: str, source_text: str) -> tuple[bool, int | None, int | None]:
    """Is `quote` (verbatim, whitespace/case/quote-style insensitive) inside `source_text`?

    Supports ellipsis-joined quotes ("first part ... second part"): every part must occur, in order.
    Returns (ok, start, end) as character offsets into the ORIGINAL source text.
    """
    if not quote or not source_text:
        return False, None, None
    norm_src, mapping = _normalize_with_map(source_text)
    parts = [p.strip(" .,;:") for p in re.split(r"\s*(?:\.\.\.|…)\s*", quote) if p.strip(" .,;:")]
    if not parts:
        return False, None, None
    pos = 0
    first_start: int | None = None
    last_end: int | None = None
    for part in parts:
        norm_part, _ = _normalize_with_map(part)
        if len(norm_part) < 3:
            continue
        idx = norm_src.find(norm_part, pos)
        if idx == -1:
            return False, None, None
        if first_start is None:
            first_start = mapping[idx]
        last_end = mapping[idx + len(norm_part) - 1] + 1
        pos = idx + len(norm_part)
    if first_start is None:
        return False, None, None
    return True, first_start, last_end


_CITE = re.compile(r"\[(\d{1,2})\]")


@dataclass
class CitationCheck:
    text: str
    used: list[int] = field(default_factory=list)
    invalid: list[int] = field(default_factory=list)
    uncited_sentences: int = 0


def validate_citations(answer: str, valid_ids: set[int]) -> CitationCheck:
    """Drop citation markers that don't refer to a provided source; report uncited claims."""
    used: list[int] = []
    invalid: list[int] = []

    def repl(m: re.Match) -> str:
        n = int(m.group(1))
        if n in valid_ids:
            if n not in used:
                used.append(n)
            return m.group(0)
        invalid.append(n)
        return ""

    cleaned = _CITE.sub(repl, answer or "")
    cleaned = re.sub(r"[ \t]+([.,;:])", r"\1", cleaned)
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", cleaned) if len(s.split()) > 6]
    uncited = sum(
        1 for s in sentences if not _CITE.search(s) and not s.strip().startswith(("#", "-", "*", ">"))
    )
    return CitationCheck(text=cleaned.strip(), used=used, invalid=invalid, uncited_sentences=uncited)
