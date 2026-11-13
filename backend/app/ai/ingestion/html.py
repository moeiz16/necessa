"""HTML (as embedded in CMS MCD CSV fields) → clean Markdown-ish plain text.

Keeps structure that matters for retrieval and citation: headings (bold/underlined paragraph
leads become headings), ordered/unordered lists, and tables (rendered as Markdown rows).
"""

from __future__ import annotations

import html as html_lib
import re

from selectolax.lexbor import LexborHTMLParser as HTMLParser
from selectolax.lexbor import LexborNode as Node

from app.ai.textutil import normalize_unicode

_BLOCK = {
    "p",
    "div",
    "section",
    "article",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "ul",
    "ol",
    "table",
    "tr",
    "blockquote",
    "pre",
    "hr",
}
_MULTI_NL = re.compile(r"\n{3,}")
_SP = re.compile("[ \t\u00a0]+")


def _inline_text(node: Node) -> str:
    parts: list[str] = []
    for child in node.iter(include_text=True):
        if child.tag == "-text":
            parts.append(child.text_content or "")
        elif child.tag == "br":
            parts.append("\n")
        elif child.tag in {"script", "style"}:
            continue
        else:
            parts.append(_inline_text(child))
    return "".join(parts)


def _render(node: Node, out: list[str], list_stack: list[tuple[str, int]]) -> None:
    for child in node.iter(include_text=True):
        tag = child.tag
        if tag == "-text":
            txt = child.text_content or ""
            if txt.strip():
                out.append(txt)
            continue
        if tag in {"script", "style", "head"}:
            continue
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            level = int(tag[1])
            out.append(f"\n\n{'#' * min(level + 1, 4)} {_SP.sub(' ', _inline_text(child)).strip()}\n\n")
        elif tag == "p":
            txt = _SP.sub(" ", _inline_text(child)).strip()
            if not txt:
                continue
            # A paragraph that is entirely bold/underlined and short reads as a heading in MCD docs.
            strong = child.css_first("strong, b, u")
            if strong and len(txt) < 90 and _SP.sub(" ", _inline_text(strong)).strip() == txt:
                out.append(f"\n\n### {txt.rstrip(':')}\n\n")
            else:
                out.append(f"\n\n{txt}\n\n")
        elif tag in {"ul", "ol"}:
            list_stack.append((tag, 0))
            out.append("\n")
            _render(child, out, list_stack)
            list_stack.pop()
            out.append("\n")
        elif tag == "li":
            kind, n = list_stack[-1] if list_stack else ("ul", 0)
            if list_stack:
                list_stack[-1] = (kind, n + 1)
            indent = "  " * max(0, len(list_stack) - 1)
            bullet = f"{n + 1}." if kind == "ol" else "-"
            # render nested lists separately to keep numbering
            inner: list[str] = []
            for sub in child.iter(include_text=True):
                if sub.tag in {"ul", "ol"}:
                    continue
                inner.append(sub.text_content if sub.tag == "-text" else _inline_text(sub))
            out.append(f"\n{indent}{bullet} {_SP.sub(' ', ''.join(inner)).strip()}")
            for sub in child.iter():
                if sub.tag in {"ul", "ol"}:
                    list_stack.append((sub.tag, 0))
                    _render(sub, out, list_stack)
                    list_stack.pop()
        elif tag == "table":
            out.append("\n\n" + _table(child) + "\n\n")
        elif tag == "br":
            out.append("\n")
        elif tag in _BLOCK:
            out.append("\n")
            _render(child, out, list_stack)
            out.append("\n")
        else:
            _render(child, out, list_stack)


def _table(table: Node) -> str:
    rows: list[list[str]] = []
    for tr in table.css("tr"):
        cells = [_SP.sub(" ", _inline_text(td)).strip().replace("|", "/") for td in tr.css("th, td")]
        if any(cells):
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    lines = ["| " + " | ".join(rows[0]) + " |", "|" + "---|" * width]
    lines += ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join(lines)


def html_to_text(raw: str | None) -> str:
    if not raw or not raw.strip():
        return ""
    raw = html_lib.unescape(raw) if "&" in raw and "<" not in raw else raw
    if "<" not in raw:
        return _clean(html_lib.unescape(raw))
    tree = HTMLParser(raw)
    root = tree.body or tree.root
    if root is None:
        return _clean(raw)
    out: list[str] = []
    _render(root, out, [])
    return _clean("".join(out))


def _clean(text: str) -> str:
    text = normalize_unicode(text)
    lines = [_SP.sub(" ", ln).rstrip() for ln in text.splitlines()]
    text = "\n".join(lines)
    text = _MULTI_NL.sub("\n\n", text).strip()
    if text.upper() in {"N/A", "NA", "NONE", "N/A."}:
        return ""
    return text
