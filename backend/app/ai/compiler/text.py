"""Text normalization + verbatim grounding used by the criteria compiler and the case agent.

Deliberately dependency-free (stdlib `html.parser`) so that grounding checks behave identically
in CI, offline demos and production. Grounding is *normalized verbatim* matching: we collapse
whitespace, unify quotes/dashes and casefold — we never fuzzy-match, because a citation must be
something a human can find with Ctrl-F in the source document.
"""

from __future__ import annotations

import html
import re
import unicodedata
from html.parser import HTMLParser

_BLOCK_TAGS = {
    "p",
    "div",
    "br",
    "li",
    "ul",
    "ol",
    "tr",
    "table",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "section",
    "article",
    "blockquote",
    "dd",
    "dt",
    "hr",
}
_TRANSLATE = str.maketrans(
    {
        "‘": "'",  # noqa: RUF001
        "’": "'",  # noqa: RUF001
        "‚": "'",  # noqa: RUF001
        "‛": "'",  # noqa: RUF001
        "“": '"',
        "”": '"',
        "„": '"',
        "″": '"',
        "–": "-",  # noqa: RUF001
        "—": "-",
        "‒": "-",  # noqa: RUF001
        "−": "-",  # noqa: RUF001
        "‐": "-",  # noqa: RUF001
        "‑": "-",  # noqa: RUF001
        " ": " ",  # noqa: RUF001
        " ": " ",  # noqa: RUF001
        " ": " ",  # noqa: RUF001
        " ": " ",  # noqa: RUF001
        " ": " ",  # noqa: RUF001
        "•": " ",
        "·": " ",
        "…": "...",
        "≥": ">=",
        "≤": "<=",
    }
)


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def html_to_text(raw: str | None) -> str:
    """HTML fragment (as found in CMS MCD CSV fields) → readable plain text with paragraph breaks."""
    if not raw:
        return ""
    parser = _TextExtractor()
    parser.feed(raw)
    parser.close()
    text = html.unescape("".join(parser.parts))
    text = unicodedata.normalize("NFKC", text).translate(_TRANSLATE)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()


def normalize_for_match(text: str) -> str:
    """Canonical form used for verbatim matching (whitespace/quote/dash/case insensitive)."""
    text = unicodedata.normalize("NFKC", text or "").translate(_TRANSLATE)
    text = re.sub(r"\s+", " ", text)
    return text.strip().casefold()


def _normalized_with_index(text: str) -> tuple[str, list[int]]:
    """Normalize while keeping a map from normalized offset → original offset."""
    out: list[str] = []
    index: list[int] = []
    prev_space = True
    for i, ch in enumerate(text or ""):
        ch = unicodedata.normalize("NFKC", ch).translate(_TRANSLATE)
        for c in ch:
            if c.isspace():
                if prev_space:
                    continue
                out.append(" ")
                index.append(i)
                prev_space = True
            else:
                out.append(c.casefold())
                index.append(i)
                prev_space = False
    while out and out[-1] == " ":
        out.pop()
        index.pop()
    return "".join(out), index


def find_quote(quote: str, source_text: str) -> tuple[bool, int | None, int | None]:
    """Return (found, start, end) of `quote` inside `source_text` (offsets into the original text)."""
    q = normalize_for_match(quote)
    if len(q) < 8:  # too short to be a meaningful citation
        return False, None, None
    norm, index = _normalized_with_index(source_text)
    pos = norm.find(q)
    if pos < 0:
        return False, None, None
    start = index[pos]
    end = index[pos + len(q) - 1] + 1
    return True, start, end


def verify_quote(quote: str, source_text: str) -> tuple[bool, int | None, int | None]:
    """Prefer the platform guardrail implementation; fall back to ours (identical semantics)."""
    try:  # pragma: no cover - guardrails module is optional here
        from app.ai.guardrails.output import verify_quote as _b_verify

        ok, s, e = _b_verify(quote, source_text)
        if ok:
            return ok, s, e
    except Exception:  # peer implementation unavailable; ours has identical semantics
        return find_quote(quote, source_text)
    return find_quote(quote, source_text)


_TOKEN_RE = re.compile(r"[a-z0-9]+(?:[.\-/][a-z0-9]+)*")
STOPWORDS = frozenset(
    "a an and are as at be been by for from has have in is it its of on or that the this to was were "
    "will with within who whom which than then there these those not no nor any all each per".split()
)


def tokenize(text: str, *, keep_stopwords: bool = False) -> list[str]:
    toks = _TOKEN_RE.findall(normalize_for_match(text))
    if keep_stopwords:
        return toks
    return [t for t in toks if t not in STOPWORDS]


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"(])|\n+", text or "")
    return [p.strip() for p in parts if p and p.strip()]
