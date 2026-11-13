"""Small, dependency-free text helpers shared by the RAG stack."""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections.abc import Iterable

_WS = re.compile(r"\s+")
_SENT = re.compile(r"(?<=[.!?;])\s+(?=[A-Z0-9(\[\"'])")
_FENCE = re.compile(r"^```(?:json|sql)?\s*|\s*```$", re.IGNORECASE | re.MULTILINE)
_QUOTES = str.maketrans(
    {"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"', "\u2013": "-", "\u2014": "-",
     "\u00a0": " ", "\u2212": "-"}
)
_ZERO_WIDTH = re.compile("[\u200b\u200c\u200d\u2060\ufeff]")


def normalize_unicode(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "")
    text = _ZERO_WIDTH.sub("", text)
    return text.translate(_QUOTES)


def normalize_ws(text: str) -> str:
    return _WS.sub(" ", text or "").strip()


def estimate_tokens(text: str) -> int:
    """~4 chars/token heuristic (good enough for budgeting; exact counts come from providers)."""
    return max(1, (len(text or "") + 3) // 4)


def split_sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENT.split(text or "") if p.strip()]
    return parts or ([text.strip()] if text and text.strip() else [])


def sha256_hex(*parts: str | bytes) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p if isinstance(p, bytes) else p.encode("utf-8"))
        h.update(b"\x1f")
    return h.hexdigest()


def extract_json(text: str) -> object:
    """Parse the first JSON object/array in an LLM response (handles code fences & prose)."""
    s = _FENCE.sub("", (text or "").strip())
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    starts = [i for i in (s.find("{"), s.find("[")) if i != -1]
    if not starts:
        raise ValueError("no JSON found in model output")
    start = min(starts)
    opener = s[start]
    closer = "}" if opener == "{" else "]"
    depth, in_str, esc = 0, False, False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return json.loads(s[start : i + 1])
    raise ValueError("unterminated JSON in model output")


_WORD = re.compile(r"[a-z0-9]+(?:[.\-][a-z0-9]+)*")


def word_tokens(text: str) -> list[str]:
    return _WORD.findall(normalize_unicode(text).lower())


def shingles(text: str, k: int = 5) -> set[tuple[str, ...]]:
    toks = word_tokens(text)
    if len(toks) <= k:
        return {tuple(toks)} if toks else set()
    return {tuple(toks[i : i + k]) for i in range(len(toks) - k + 1)}


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    sp = cut.rfind(" ")
    return (cut[:sp] if sp > max_chars * 0.7 else cut).rstrip() + "…"


def dedupe_keep_order(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for it in items:
        if it not in seen:
            seen.add(it)
            out.append(it)
    return out
