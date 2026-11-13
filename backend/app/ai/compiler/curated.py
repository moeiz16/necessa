"""Curated (human-authored, reviewer-approved) criteria sets shipped with the product.

They make the platform fully functional offline / without LLM keys, and they are the gold standard
the LLM compiler is evaluated against. Each quote is verified verbatim against the policy text
(tests/cases/test_curated_grounding.py).
"""

from __future__ import annotations

import csv
import json
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from app.ai.compiler.schema import CriteriaTree, CriterionLeaf
from app.ai.compiler.text import find_quote, html_to_text

CURATED_DIR = Path(__file__).parent / "curated"

# CMS LCD CSV column → our section_key (mirrors ingestion; kept local so grounding is self-contained).
LCD_SECTION_COLUMNS = {
    "indication": "indication",
    "doc_reqs": "doc_reqs",
    "coding_guidelines": "coding_guidelines",
    "util_guide": "util_guide",
    "associated_info": "associated_info",
    "cms_cov_policy": "cms_cov_policy",
    "summary_of_evidence": "summary_of_evidence",
    "analysis_of_evidence": "analysis_of_evidence",
}


@lru_cache
def load_curated() -> dict[str, CriteriaTree]:
    trees: dict[str, CriteriaTree] = {}
    for path in sorted(CURATED_DIR.glob("*.json")):
        tree = CriteriaTree.model_validate(json.loads(path.read_text(encoding="utf-8")))
        trees[tree.policy_key] = tree
    return trees


def curated_for_services(service_codes: list[str]) -> list[CriteriaTree]:
    wanted = {c.strip().upper() for c in service_codes if c}
    return [t for t in load_curated().values() if wanted & {s.upper() for s in t.services}]


@dataclass
class LeafGrounding:
    criterion_id: str
    section_key: str
    ok: bool
    start: int | None = None
    end: int | None = None
    reason: str | None = None


@dataclass
class GroundingReport:
    policy_key: str
    leaves: list[LeafGrounding] = field(default_factory=list)

    @property
    def pass_rate(self) -> float:
        return sum(1 for g in self.leaves if g.ok) / len(self.leaves) if self.leaves else 0.0

    @property
    def failures(self) -> list[LeafGrounding]:
        return [g for g in self.leaves if not g.ok]


def ground_tree(tree: CriteriaTree, sections: dict[str, str]) -> GroundingReport:
    """Verify every leaf's quote verbatim against `sections` ({section_key: plain text}).

    Falls back to searching all sections when the declared section doesn't contain the quote
    (section boundaries differ slightly between ingestion normalizers), but still requires a
    verbatim hit somewhere in the same policy version.
    """
    report = GroundingReport(policy_key=tree.policy_key)
    for leaf in tree.leaves():
        report.leaves.append(_ground_leaf(leaf, sections))
    return report


def _ground_leaf(leaf: CriterionLeaf, sections: dict[str, str]) -> LeafGrounding:
    span = leaf.source_span
    primary = sections.get(span.section_key, "")
    ok, s, e = find_quote(span.quote, primary)
    if ok:
        return LeafGrounding(leaf.id, span.section_key, True, s, e)
    for key, text in sections.items():
        ok, s, e = find_quote(span.quote, text)
        if ok:
            return LeafGrounding(
                leaf.id, key, True, s, e, reason=f"found in '{key}' not '{span.section_key}'"
            )
    return LeafGrounding(leaf.id, span.section_key, False, reason="quote not found verbatim in policy text")


def apply_grounding(tree: CriteriaTree, report: GroundingReport) -> CriteriaTree:
    """Write resolved offsets/section keys back into the tree (copy)."""
    by_id = {g.criterion_id: g for g in report.leaves}
    data = tree.model_copy(deep=True)
    for leaf in data.leaves():
        g = by_id.get(leaf.id)
        if g and g.ok:
            leaf.source_span.section_key = g.section_key
            leaf.source_span.start = g.start
            leaf.source_span.end = g.end
    return data


def lcd_sections_from_csv(source_key: str, data_dir: Path) -> dict[str, str] | None:
    """Read an LCD's sections straight from the CMS MCD CSV export (offline grounding / tests)."""
    if not source_key.startswith("L"):
        return None
    path = data_dir / "raw" / "current_lcd" / "csv" / "lcd.csv"
    if not path.exists():
        return None
    csv.field_size_limit(sys.maxsize)
    lcd_id = source_key[1:]
    with path.open(newline="", encoding="utf-8", errors="replace") as fh:
        for row in csv.DictReader(fh):
            if row.get("lcd_id") == lcd_id:
                return {key: html_to_text(row.get(col, "")) for col, key in LCD_SECTION_COLUMNS.items()}
    return None


async def sections_from_db(db, policy_key: str) -> tuple[str | None, dict[str, str]]:
    """Return (policy_version_id, {section_key: text}) for the current version of a policy (knowledge tables)."""  # noqa: E501
    try:
        from sqlalchemy import select

        from app.db.models.knowledge import Policy, PolicySection, PolicyVersion  # type: ignore[attr-defined]
    except Exception:
        return None, {}
    pol = (await db.execute(select(Policy).where(Policy.source_key == policy_key))).scalar_one_or_none()
    if pol is None:
        return None, {}
    version_id = getattr(pol, "current_version_id", None)
    if version_id is None:
        ver = (
            (
                await db.execute(
                    select(PolicyVersion)
                    .where(PolicyVersion.policy_id == pol.id)
                    .order_by(PolicyVersion.version.desc())
                )
            )
            .scalars()
            .first()
        )
        version_id = ver.id if ver else None
    if version_id is None:
        return None, {}
    rows = (
        (await db.execute(select(PolicySection).where(PolicySection.policy_version_id == version_id)))
        .scalars()
        .all()
    )
    sections: dict[str, str] = {}
    for r in rows:
        sections[r.section_key] = (sections.get(r.section_key, "") + "\n" + (r.text or "")).strip()
    return str(version_id), sections
