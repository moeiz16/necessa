"""Chart processing for case evaluation: section/date-aware chunking, a per-case BM25 index and
deterministic extractors used both as a cross-check of the LLM judge and as the degraded-mode path.

Per-case BM25 is the right tool here (not a degraded hack): a chart is a few dozen chunks, exact
terms (drug names, scores, durations) matter, and it needs no network or model.
"""

from __future__ import annotations

import math
import re
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime

from app.ai.compiler.schema import CriterionLeaf, NumericRule, Verdict
from app.ai.compiler.text import tokenize

try:
    import snowballstemmer

    _STEM = snowballstemmer.stemmer("english")
except Exception:  # pragma: no cover
    _STEM = None


def lexical_tokens(text: str) -> list[str]:
    """Stemmed tokens for BM25 ("locking" ≈ "locks"); codes/numbers are kept verbatim."""
    toks = tokenize(text)
    if _STEM is None:
        return toks
    return [t if any(ch.isdigit() for ch in t) else _STEM.stemWord(t) for t in toks]


MAX_CHUNK_CHARS = 1100
MIN_CHUNK_CHARS = 60

_HEADING = re.compile(
    r"^\s*(?:#+\s*)?(?P<h>(?:chief complaint|cc|hpi|history of present illness|history|pmh|past medical history|"  # noqa: E501
    r"medications?|allergies|ros|review of systems|exam(?:ination)?|physical exam(?:ination)?|"
    r"assessment(?: and plan)?|a/p|plan|impression|imaging|radiology|mri|x-?ray|labs?|results?|findings|"
    r"procedure|procedures|therapy|physical therapy|pt|sleep study|polysomnography|visual fields?|"
    r"diagnos(?:is|es)|problem list|social history|functional (?:status|assessment)|"
    r"subjective|objective|recommendations?|discussion|follow[- ]up|disposition|note))\s*[:\-]\s*",
    re.I,
)
_DATED_LINE = re.compile(r"^\s*(?P<d>\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{2,4}|\[DATE_\d+\])\s*[:\-–]\s*")  # noqa: RUF001
_DATE_ANY = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})/(\d{1,2})/(\d{4})\b")


@dataclass
class ChartDoc:
    document_id: str
    kind: str
    text: str  # de-identified
    note_date: date | None = None
    title: str | None = None


@dataclass
class ChartChunk:
    chunk_id: str
    document_id: str
    ordinal: int
    text: str
    section: str | None
    note_date: date | None
    char_start: int
    char_end: int
    doc_kind: str = "clinical_note"
    tokens: list[str] = field(default_factory=list)


def _parse_date(s: str) -> date | None:
    m = _DATE_ANY.search(s)
    if not m:
        return None
    try:
        if m.group(1):
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        return date(int(m.group(6)), int(m.group(4)), int(m.group(5)))
    except ValueError:
        return None


def chunk_document(doc: ChartDoc, start_ordinal: int = 0) -> list[ChartChunk]:
    """Split a note into section-aware chunks; dated entry lines start a new chunk."""
    text = doc.text or ""
    if not text.strip():
        return []
    lines = text.splitlines(keepends=True)
    blocks: list[tuple[int, int, str | None]] = []  # (start, end, section)
    pos, cur_start, cur_section = 0, 0, None
    for line in lines:
        head = _HEADING.match(line)
        dated = _DATED_LINE.match(line)
        if (head or dated) and pos > cur_start:
            blocks.append((cur_start, pos, cur_section))
            cur_start = pos
        if head:
            cur_section = head.group("h").strip().lower()
        pos += len(line)
    blocks.append((cur_start, pos, cur_section))

    # Split oversized blocks on paragraph/sentence boundaries; merge tiny blocks into neighbours.
    pieces: list[tuple[int, int, str | None]] = []
    for s, e, sec in blocks:
        while e - s > MAX_CHUNK_CHARS:
            window = text[s : s + MAX_CHUNK_CHARS]
            cut = max(window.rfind("\n"), window.rfind(". "))
            cut = cut + 1 if cut > MAX_CHUNK_CHARS // 3 else MAX_CHUNK_CHARS
            pieces.append((s, s + cut, sec))
            s += cut
        pieces.append((s, e, sec))
    merged: list[tuple[int, int, str | None]] = []
    carry: int | None = None  # start of a tiny block (e.g. a bare heading) waiting to join the next block
    for s, e, sec in pieces:
        if carry is not None:
            s, carry = carry, None
        if (e - s) < MIN_CHUNK_CHARS:
            if merged and (e - merged[-1][0]) <= MAX_CHUNK_CHARS and not text[s:e].strip().endswith(":"):
                ps, _, psec = merged[-1]
                merged[-1] = (ps, e, psec)
            else:
                carry = s
            continue
        merged.append((s, e, sec))
    if carry is not None:
        if merged:
            ps, _, psec = merged[-1]
            merged[-1] = (ps, len(text), psec)
        else:
            merged.append((carry, len(text), None))
    out: list[ChartChunk] = []
    for s, e, sec in merged:
        body = text[s:e]
        stripped = body.strip()
        if not stripped:
            continue
        lead = len(body) - len(body.lstrip())
        cs, ce = s + lead, s + lead + len(stripped)
        nd = _parse_date(stripped[:40]) or doc.note_date
        out.append(
            ChartChunk(
                chunk_id=str(uuid.uuid4()),
                document_id=doc.document_id,
                ordinal=start_ordinal + len(out),
                text=stripped,
                section=sec,
                note_date=nd,
                char_start=cs,
                char_end=ce,
                doc_kind=doc.kind,
                tokens=lexical_tokens(stripped),
            )
        )
    return out


def chunk_chart(docs: list[ChartDoc]) -> list[ChartChunk]:
    chunks: list[ChartChunk] = []
    for d in docs:
        chunks.extend(chunk_document(d, start_ordinal=len(chunks)))
    return chunks


class LexicalIndex:
    """Okapi BM25 over one case's chart chunks."""

    def __init__(self, chunks: list[ChartChunk], k1: float = 1.4, b: float = 0.72) -> None:
        self.chunks = chunks
        self.k1, self.b = k1, b
        self.tf = [Counter(c.tokens) for c in chunks]
        self.len = [len(c.tokens) or 1 for c in chunks]
        self.avg = (sum(self.len) / len(self.len)) if self.len else 1.0
        df: Counter[str] = Counter()
        for tf in self.tf:
            df.update(tf.keys())
        n = len(chunks)
        self.idf = {t: math.log(1 + (n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def search(
        self, query: str, *, top_k: int = 6, not_before: date | None = None, not_after: date | None = None
    ) -> list[tuple[ChartChunk, float]]:
        q = lexical_tokens(query)
        scored: list[tuple[ChartChunk, float]] = []
        for i, c in enumerate(self.chunks):
            if c.note_date and not_before and c.note_date < not_before:
                continue
            if c.note_date and not_after and c.note_date > not_after:
                continue
            tf = self.tf[i]
            s = 0.0
            for t in q:
                f = tf.get(t)
                if not f:
                    continue
                s += (
                    self.idf.get(t, 0.0)
                    * f
                    * (self.k1 + 1)
                    / (f + self.k1 * (1 - self.b + self.b * self.len[i] / self.avg))
                )
            if s > 0:
                scored.append((c, s))
        scored.sort(key=lambda x: -x[1])
        return scored[:top_k]


def criterion_query(leaf: CriterionLeaf) -> str:
    return " ".join([leaf.text, *leaf.keywords])


def expand_query(leaf: CriterionLeaf, iteration: int) -> str:
    """Corrective retrieval rewrites: iteration 1 = keywords only (precision), 2 = policy quote (recall)."""
    if iteration == 1 and leaf.keywords:
        return " ".join(leaf.keywords)
    return f"{leaf.source_span.quote} {' '.join(leaf.keywords)}"


# ── deterministic extractors ───────────────────────────────────────────────────────────────────

_NEGATION = re.compile(
    r"\b(no|not|denies|denied|without|negative for|absent|never|none|has not|have not|hasn't|haven't|"
    r"pending|not yet|declined|deferred)\b",
    re.I,
)
_WORD_NUM = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "half a year": 6,
    "a year": 12,
    "two years": 24,
}


def _compare(op: str, x: float, rule: NumericRule) -> bool:
    if op == ">=":
        return x >= rule.value
    if op == ">":
        return x > rule.value
    if op == "<=":
        return x <= rule.value
    if op == "<":
        return x < rule.value
    if op == "==":
        return abs(x - rule.value) < 1e-9
    return rule.value <= x <= (rule.value_high or rule.value)


@dataclass
class NumericFinding:
    value: float
    quote: str
    chunk_id: str
    satisfied: bool
    negated: bool


def numeric_findings(rule: NumericRule, chunks: list[ChartChunk]) -> list[NumericFinding]:
    out: list[NumericFinding] = []
    pats = [re.compile(p, re.I) for p in rule.patterns]
    for c in chunks:
        for p in pats:
            for m in p.finditer(c.text):
                try:
                    val = float(m.group(1))
                except (ValueError, IndexError):
                    continue
                # quote = the sentence containing the match
                s = c.text.rfind(".", 0, m.start()) + 1
                e = c.text.find(".", m.end())
                e = len(c.text) if e < 0 else e + 1
                quote = c.text[s:e].strip()
                window = c.text[max(0, m.start() - 40) : m.start()]
                neg = bool(_NEGATION.search(window))
                out.append(
                    NumericFinding(val, quote, c.chunk_id, _compare(rule.op, val, rule) and not neg, neg)
                )
    return out


def deterministic_verdict(
    leaf: CriterionLeaf, chunks: list[ChartChunk]
) -> tuple[Verdict, list[NumericFinding]]:
    """Degraded-mode / cross-check verdict for numeric & temporal rules.

    Conservative by design: it can only return MET (a documented value satisfying the threshold, in a sentence
    that also mentions the criterion's own terms) or INSUFFICIENT. NOT_MET requires clinical judgement (the
    LLM judge + verifier) — a number found in an unrelated sentence must never sink a criterion."""
    if leaf.numeric is None:
        return Verdict.INSUFFICIENT, []
    vocab = set(tokenize(" ".join([*leaf.keywords, leaf.text]))) - {
        leaf.numeric.unit or "",
        "documented",
        "least",
    }
    findings = [f for f in numeric_findings(leaf.numeric, chunks) if vocab & set(tokenize(f.quote))]
    satisfied = [f for f in findings if f.satisfied]
    if satisfied:
        return Verdict.MET, satisfied
    return Verdict.INSUFFICIENT, findings


def lookback_window(
    date_of_service: date | None, lookback_days: int | None
) -> tuple[date | None, date | None]:
    if not date_of_service:
        return None, None
    if lookback_days:
        from datetime import timedelta

        return date_of_service - timedelta(days=lookback_days), date_of_service
    return None, date_of_service


def to_date(v: date | datetime | str | None) -> date | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None
