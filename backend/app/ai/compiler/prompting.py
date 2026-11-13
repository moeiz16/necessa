"""Prompt rendering for workstream C (delegates to the shared versioned loader)."""

from __future__ import annotations

import re
from pathlib import Path

_DIR = Path(__file__).resolve().parents[1] / "prompts"
_VAR = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")
_FRONT = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)


def render_prompt(name: str, **variables: object) -> str:
    try:
        from app.ai.prompts.loader import render

        text, _version = render(name, **variables)
        return text
    except ImportError:  # pragma: no cover - loader always present in the full app
        raw = (_DIR / f"{name}.md").read_text(encoding="utf-8")
        m = _FRONT.match(raw)
        if m:
            raw = raw[m.end() :]
        return _VAR.sub(lambda mm: str(variables.get(mm.group(1), mm.group(0))), raw).strip()


def prompt_version(name: str) -> int:
    try:
        from app.ai.prompts.loader import load

        return load(name)[1]
    except Exception:
        return 1
