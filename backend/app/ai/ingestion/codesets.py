"""Code-set lookup table (`codes`) built from the code tables inside MCD documents, plus an optional
CDC ICD-10-CM order file (`data/raw/icd10cm/icd10cm_order_*.txt`) when present.

ICD-10-CM and HCPCS Level II descriptions are public domain. CPT descriptors are AMA content and are
stored only for the licensed local user (never exported, never sent to LLMs).
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.ingestion.mcd import ParsedDoc
from app.db.models.knowledge import Code

log = structlog.get_logger(__name__)


def _norm_icd(code: str) -> str:
    c = code.strip().upper().replace(".", "")
    return c if len(c) <= 3 else f"{c[:3]}.{c[3:]}"


def collect_codes(docs: Iterable[ParsedDoc]) -> dict[tuple[str, str], tuple[str | None, str | None]]:
    out: dict[tuple[str, str], tuple[str | None, str | None]] = {}
    for d in docs:
        for c in d.codes:
            if c.system == "HCPCS":
                key = ("HCPCS", c.code)
            elif c.system in {"ICD10_COVERED", "ICD10_NONCOVERED"}:
                key = ("ICD10CM", _norm_icd(c.code))
            elif c.system == "ICD10_PCS":
                key = ("ICD10PCS", c.code)
            else:
                continue
            if key not in out or (c.description and not out[key][1]):
                desc = c.description
                out[key] = ((desc[:80] if desc else None), desc)
    return out


def parse_cdc_order_file(path: Path) -> dict[tuple[str, str], tuple[str | None, str | None]]:
    """CDC `icd10cm_order_YYYY.txt` (fixed width): code [6:13], billable [14], short [16:76], long [77:]."""
    out: dict[tuple[str, str], tuple[str | None, str | None]] = {}
    with path.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if len(line) < 20:
                continue
            code = _norm_icd(line[6:13])
            out[("ICD10CM", code)] = (line[16:76].strip() or None, line[77:].strip() or None)
    return out


async def upsert_codes(
    session: AsyncSession, codes: dict[tuple[str, str], tuple[str | None, str | None]]
) -> int:
    if not codes:
        return 0
    existing = {
        (r.code_system, r.code) for r in (await session.execute(select(Code.code_system, Code.code))).all()
    }
    new = [
        Code(code_system=s, code=c, short_desc=sd, long_desc=ld)
        for (s, c), (sd, ld) in codes.items()
        if (s, c) not in existing
    ]
    session.add_all(new)
    await session.flush()
    log.info("codesets.upserted", new=len(new), total=len(existing) + len(new))
    return len(new)


def find_cdc_file(raw_dir: Path) -> Path | None:
    for p in (
        sorted((raw_dir / "icd10cm").glob("icd10cm_order_*.txt")) if (raw_dir / "icd10cm").exists() else []
    ):
        return p
    return None
