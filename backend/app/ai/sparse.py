"""BM25 sparse vectors computed in pure Python (no model).

Qdrant stores, per document, the BM25 *term-frequency* component
    tf' = tf·(k1+1) / (tf + k1·(1 - b + b·dl/avgdl))
and applies IDF at query time via `Modifier.IDF`, so score(q, d) = Σ idf(t)·q_t·tf'_t — i.e. BM25.

Tokenization is medical-code aware: HCPCS/CPT (`E0601`, `29877`), ICD-10 (`M17.11`),
LCD/Article ids (`L33718`, `A52369`) and NCD sections (`150.9`) are kept intact and never stemmed.
Words are Snowball-stemmed; stopwords dropped; tokens hashed to stable uint32 indices.
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache

import snowballstemmer

from app.ai.textutil import normalize_unicode

SPARSE_MODEL_ID = "bm25-snowball-v1"
K1 = 1.2
B = 0.75
DEFAULT_AVGDL = 180.0

_TOKEN = re.compile(r"[a-z0-9]+(?:[.\-/][a-z0-9]+)*")
_CODE = re.compile(
    r"^(?:[a-z]\d{4}[a-z0-9]?"  # HCPCS level II e.g. e0601, q4101, k0823
    r"|\d{4}[0-9a-z]"  # CPT e.g. 29877, 0275t
    r"|[a-tv-z]\d{2}(?:\.[0-9a-z]{1,4})?"  # ICD-10-CM e.g. m17.11
    r"|[la]\d{5}"  # LCD / Article ids
    r"|\d{2,3}\.\d{1,3}(?:\.\d)?"  # NCD manual sections 150.9, 220.6.17
    r"|(?=[a-z]*\d)[0-9a-hj-np-z]{7})$"  # ICD-10-PCS (7 chars incl. a digit, approximate)
)
_HAS_DIGIT = re.compile(r"\d")

STOPWORDS = frozenset(
    """
a about above after again against all am an and any are as at be because been before being below
between both but by can could did do does doing down during each few for from further had has have
having he her here hers herself him himself his how i if in into is it its itself just me more most
my myself no nor not of off on once only or other our ours ourselves out over own same she should so
some such than that the their theirs them themselves then there these they this those through to too
under until up very was we were what when where which while who whom why will with would you your
yours yourself yourselves also may must shall per via etc
""".split()
)
# Clinically meaningful negations / qualifiers are NOT stopwords (with vs without contrast, no history of).
STOPWORDS = STOPWORDS - {
    "no",
    "not",
    "nor",
    "without",
    "with",
    "against",
    "before",
    "after",
    "only",
    "all",
    "any",
    "more",
    "most",
    "few",
    "under",
    "over",
    "between",
}

_stemmer = snowballstemmer.stemmer("english")


@lru_cache(maxsize=200_000)
def _stem(word: str) -> str:
    return _stemmer.stemWord(word)


def is_code_token(tok: str) -> bool:
    return bool(_CODE.match(tok))


def tokenize(text: str) -> list[str]:
    """Normalize → lowercase → split, keeping codes intact; stem words; drop stopwords."""
    out: list[str] = []
    for raw in _TOKEN.findall(normalize_unicode(text).lower()):
        tok = raw.strip(".-/")
        if not tok:
            continue
        if is_code_token(tok):
            out.append(tok)
            continue
        if "-" in tok or "/" in tok:
            parts = [p for p in re.split(r"[-/]", tok) if p]
            # keep the compound (e.g. "non-covered") and its parts
            if all(not _HAS_DIGIT.search(p) for p in parts):
                out.append(_stem(tok.replace("/", "-")))
            for p in parts:
                if p in STOPWORDS:
                    continue
                if is_code_token(p) or _HAS_DIGIT.search(p):
                    out.append(p)
                elif len(p) > 1:
                    out.append(_stem(p))
            continue
        if "." in tok and not _HAS_DIGIT.search(tok):
            tok = tok.replace(".", "")
        if tok in STOPWORDS:
            continue
        if _HAS_DIGIT.search(tok):
            out.append(tok)
        elif len(tok) > 1:
            out.append(_stem(tok))
    return out


@lru_cache(maxsize=500_000)
def token_index(token: str) -> int:
    """Stable 32-bit index (blake2b) — identical across processes/machines (unlike hash())."""
    return int.from_bytes(hashlib.blake2b(token.encode("utf-8"), digest_size=4).digest(), "little")


@dataclass(frozen=True)
class SparseVec:
    indices: list[int]
    values: list[float]

    def to_qdrant(self):
        from qdrant_client import models

        return models.SparseVector(indices=self.indices, values=self.values)

    def __len__(self) -> int:
        return len(self.indices)


def _merge(pairs: dict[int, float]) -> SparseVec:
    items = sorted(pairs.items())
    return SparseVec(indices=[i for i, _ in items], values=[round(v, 5) for _, v in items])


def encode_document(text: str, avgdl: float = DEFAULT_AVGDL, k1: float = K1, b: float = B) -> SparseVec:
    toks = tokenize(text)
    if not toks:
        return SparseVec([], [])
    dl = len(toks)
    tf = Counter(toks)
    norm = k1 * (1 - b + b * dl / max(1.0, avgdl))
    acc: dict[int, float] = {}
    for tok, f in tf.items():
        idx = token_index(tok)
        acc[idx] = acc.get(idx, 0.0) + f * (k1 + 1) / (f + norm)
    return _merge(acc)


def encode_query(text: str) -> SparseVec:
    """Query side: binary term weights (IDF is applied server-side by Qdrant)."""
    toks = tokenize(text)
    acc: dict[int, float] = {}
    for tok in toks:
        # exact codes are the strongest signal in this domain — upweight them
        acc[token_index(tok)] = 2.0 if is_code_token(tok) else 1.0
    return _merge(acc)


def doc_length(text: str) -> int:
    return len(tokenize(text))
