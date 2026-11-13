"""Section-aware, hierarchical (parent-child) chunking with deterministic contextual headers.

* Split boundary priority: Markdown headings → paragraphs → list items / table rows → sentences.
  Rules are never cut mid-sentence; tables keep their header row with every row group.
* Children (retrieval units) target 200-400 tokens; parents (context units) ≤ 1,500 tokens.
  "Match small, return big": retrieval hits children, the generator receives the parent span.
* A deterministic header (doc type · key · version · title · section · effective date) is prepended
  to the embedded/BM25 text — contextual retrieval without an LLM call.
* Chunk IDs are content-addressed (uuid5) so unchanged chunks keep their ID across ingestion runs,
  letting a blue/green rebuild reuse vectors instead of re-embedding.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from app.ai.textutil import estimate_tokens, sha256_hex, split_sentences

CHUNK_NS = uuid.UUID("6f1d0f7e-3c4b-4b9e-9a51-2a8d0e5c7b11")
CHILD_TARGET_CHARS = 1200  # ~300 tokens
CHILD_MAX_CHARS = 1600  # ~400 tokens
CHILD_MIN_CHARS = 350
PARENT_MAX_CHARS = 6000  # ~1,500 tokens

# Sections stored in Postgres but not indexed for retrieval (low signal, high volume).
NON_INDEXED_SECTIONS = frozenset({"bibliography", "source_info"})

_HEADING = re.compile(r"^#{1,6}\s+.+$", re.M)
_TABLE_ROW = re.compile(r"^\|.*\|$")


@dataclass
class Chunk:
    id: str
    parent_id: str | None
    level: str  # child|parent
    ordinal: int
    text: str
    header: str
    char_start: int
    char_end: int
    content_hash: str

    @property
    def token_estimate(self) -> int:
        return estimate_tokens(self.text)

    @property
    def index_text(self) -> str:
        return f"{self.header}\n{self.text}"


def make_header(
    *,
    doc_type: str,
    source_key: str,
    version: int | str | None,
    title: str,
    section_title: str,
    effective_from: str | None,
    extra: str | None = None,
) -> str:
    parts = [
        f"{doc_type} {source_key}" + (f" v{version}" if version not in (None, "") else ""),
        title.strip(),
    ]
    parts.append(f"Section: {section_title}")
    if effective_from:
        parts.append(f"Effective {effective_from}")
    if extra:
        parts.append(extra)
    return "[" + " · ".join(p for p in parts if p) + "]"


def _blocks(text: str) -> list[tuple[int, int]]:
    """Return (start, end) spans of atomic blocks: paragraphs, list items, table-row groups."""
    spans: list[tuple[int, int]] = []
    pos = 0
    for para in re.split(r"(\n\s*\n)", text):
        if not para.strip() or re.fullmatch(r"\n\s*\n", para):
            pos += len(para)
            continue
        start = pos
        lines = para.split("\n")
        # tables: keep header + group of up to 12 rows together
        if all(_TABLE_ROW.match(ln.strip()) for ln in lines if ln.strip()) and len(lines) > 2:
            header = "\n".join(lines[:2])
            off = start + len(header) + 1
            rows = lines[2:]
            for i in range(0, len(rows), 12):
                grp = "\n".join(rows[i : i + 12])
                spans.append((start if i == 0 else off, off + len(grp)))
                off += len(grp) + 1
        elif any(re.match(r"^\s*(?:-|\d+\.)\s", ln) for ln in lines):
            off = start
            item_start = start
            for j, ln in enumerate(lines):
                if j and re.match(r"^\s*(?:-|\d+\.)\s", ln):
                    spans.append((item_start, off - 1))
                    item_start = off
                off += len(ln) + 1
            spans.append((item_start, start + len(para)))
        else:
            spans.append((start, start + len(para)))
        pos += len(para)
    return [(s, e) for s, e in spans if text[s:e].strip()]


def _split_long(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """Split an oversized block at sentence boundaries (never mid-sentence unless a sentence is huge)."""
    segment = text[start:end]
    if len(segment) <= CHILD_MAX_CHARS:
        return [(start, end)]
    out: list[tuple[int, int]] = []
    cur_s = start
    cur_len = 0
    cursor = start
    for sent in split_sentences(segment):
        idx = text.find(sent, cursor, end)
        if idx == -1:
            continue
        s_end = idx + len(sent)
        if cur_len and cur_len + len(sent) > CHILD_TARGET_CHARS:
            out.append((cur_s, idx))
            cur_s, cur_len = idx, 0
        cur_len += len(sent) + 1
        cursor = s_end
    out.append((cur_s, end))
    final: list[tuple[int, int]] = []
    for s, e in out:
        while e - s > CHILD_MAX_CHARS * 1.5:  # pathological sentence (e.g. long code lists)
            cut = text.rfind(";", s, s + CHILD_TARGET_CHARS)
            cut = cut + 1 if cut > s + CHILD_MIN_CHARS else s + CHILD_TARGET_CHARS
            final.append((s, cut))
            s = cut
        final.append((s, e))
    return [(s, e) for s, e in final if text[s:e].strip()]


def chunk_section(*, section_text: str, header: str, scope_key: str) -> list[Chunk]:
    """Chunk one section. `scope_key` (e.g. "<version_id>:<section_key>") namespaces chunk IDs."""
    text = section_text
    if not text.strip():
        return []
    atoms: list[tuple[int, int]] = []
    for s, e in _blocks(text):
        atoms.extend(_split_long(text, s, e))
    # parents: consecutive atoms up to PARENT_MAX_CHARS, breaking preferentially at headings
    parents: list[list[tuple[int, int]]] = [[]]
    size = 0
    for s, e in atoms:
        is_heading = bool(_HEADING.match(text[s:e].strip()))
        if parents[-1] and (
            size + (e - s) > PARENT_MAX_CHARS or (is_heading and size > PARENT_MAX_CHARS * 0.5)
        ):
            parents.append([])
            size = 0
        parents[-1].append((s, e))
        size += e - s
    chunks: list[Chunk] = []
    ordinal = 0
    for p_idx, group in enumerate(p for p in parents if p):
        p_start, p_end = group[0][0], group[-1][1]
        p_text = text[p_start:p_end].strip()
        p_hash = sha256_hex(header, p_text)
        parent_id = str(uuid.uuid5(CHUNK_NS, f"{scope_key}:p{p_idx}:{p_hash}"))
        children: list[tuple[int, int]] = []
        c_start, c_end = group[0]
        for s, e in group[1:]:
            if (e - c_start) <= CHILD_TARGET_CHARS or (c_end - c_start) < CHILD_MIN_CHARS:
                c_end = e
            else:
                children.append((c_start, c_end))
                c_start, c_end = s, e
        children.append((c_start, c_end))
        # merge a tiny trailing child into its predecessor
        if len(children) > 1 and children[-1][1] - children[-1][0] < CHILD_MIN_CHARS // 2:
            last = children.pop()
            children[-1] = (children[-1][0], last[1])
        if len(children) == 1 and (p_end - p_start) <= CHILD_MAX_CHARS:
            # small section: the child *is* the parent — store one child chunk, no separate parent
            t = text[p_start:p_end].strip()
            h = sha256_hex(header, t)
            chunks.append(
                Chunk(
                    id=str(uuid.uuid5(CHUNK_NS, f"{scope_key}:c{ordinal}:{h}")),
                    parent_id=None,
                    level="child",
                    ordinal=ordinal,
                    text=t,
                    header=header,
                    char_start=p_start,
                    char_end=p_end,
                    content_hash=h,
                )
            )
            ordinal += 1
            continue
        chunks.append(
            Chunk(
                id=parent_id,
                parent_id=None,
                level="parent",
                ordinal=ordinal,
                text=p_text,
                header=header,
                char_start=p_start,
                char_end=p_end,
                content_hash=p_hash,
            )
        )
        ordinal += 1
        for s, e in children:
            t = text[s:e].strip()
            if not t:
                continue
            h = sha256_hex(header, t)
            chunks.append(
                Chunk(
                    id=str(uuid.uuid5(CHUNK_NS, f"{scope_key}:c{ordinal}:{h}")),
                    parent_id=parent_id,
                    level="child",
                    ordinal=ordinal,
                    text=t,
                    header=header,
                    char_start=s,
                    char_end=e,
                    content_hash=h,
                )
            )
            ordinal += 1
    return chunks
