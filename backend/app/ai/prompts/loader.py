"""Versioned prompt templates stored as Markdown files next to this module.

File format:
    ---
    version: 3
    description: ...
    ---
    <template body with {{placeholders}}>

`render(name, **vars)` returns (text, version). Prompt versions are recorded in telemetry and
included in cache keys so a prompt change never serves stale cached outputs.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

_DIR = Path(__file__).resolve().parent
_FRONT = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)


@lru_cache(maxsize=128)
def load(name: str) -> tuple[str, int]:
    path = _DIR / f"{name}.md"
    raw = path.read_text(encoding="utf-8")
    version = 1
    m = _FRONT.match(raw)
    if m:
        for line in m.group(1).splitlines():
            if line.strip().startswith("version:"):
                version = int(line.split(":", 1)[1].strip())
        raw = raw[m.end() :]
    return raw.strip(), version


_VAR = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")


def render(name: str, **variables: object) -> tuple[str, int]:
    """Substitute `{{var}}` placeholders (single braces are left alone so JSON examples work)."""
    body, version = load(name)
    return _VAR.sub(lambda m: str(variables.get(m.group(1), m.group(0))), body), version
