"""Criteria transfer across Medicare contractors' editions of the same LCD."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.ai.compiler.criteria_compiler import transfer_from_family
from app.ai.compiler.curated import load_curated
from app.db.models.criteria import CriteriaSet
from app.db.models.knowledge import Policy, PolicySection, PolicyVersion
from app.db.session import session_scope

pytestmark = pytest.mark.asyncio

DONOR = "L33930"  # curated facet-joint LCD


async def _edition(db, key: str, title: str, text: str) -> None:
    pol = Policy(source="lcd", source_key=key, title=title, doc_type="LCD", status="active")
    db.add(pol)
    await db.flush()
    ver = PolicyVersion(policy_id=pol.id, version=3, content_hash=key)
    db.add(ver)
    await db.flush()
    pol.current_version_id = ver.id
    db.add(PolicySection(policy_version_id=ver.id, section_key="indication", title="Indications", text=text))
    await db.flush()


def _all_quotes() -> tuple[str, list[str]]:
    tree = load_curated()[DONOR]
    return tree.title, [leaf.source_span.quote for leaf in tree.leaves()]


async def test_identical_edition_gets_grounded_approved_criteria():
    title, quotes = _all_quotes()
    async with session_scope() as db:
        await _edition(db, "L99001", title, "Preamble.\n\n" + "\n\n".join(quotes) + "\n\nEnd.")
        cs = await transfer_from_family(db, "L99001")
        assert cs is not None and cs.status == "approved"
        assert cs.policy_key == "L99001" and cs.grounding_pass_rate == 1.0
        assert cs.extractor_model == f"transfer:{DONOR}"
        assert "re-verified verbatim" in (cs.notes or "")


async def test_diverging_edition_is_held_for_review_and_not_used():
    title, quotes = _all_quotes()
    async with session_scope() as db:
        await _edition(db, "L99002", title, "\n\n".join(quotes[1:]))  # one requirement missing
        assert await transfer_from_family(db, "L99002") is None
        held = (
            (await db.execute(select(CriteriaSet).where(CriteriaSet.policy_key == "L99002"))).scalars().all()
        )
        assert [c.status for c in held] == ["needs_review"]
        assert held[0].grounding_pass_rate < 1.0
        # A second attempt doesn't pile up duplicate review items.
        assert await transfer_from_family(db, "L99002") is None
        again = (
            (await db.execute(select(CriteriaSet).where(CriteriaSet.policy_key == "L99002"))).scalars().all()
        )
        assert len(again) == 1


async def test_unrelated_policy_title_is_not_transferred():
    _, quotes = _all_quotes()
    async with session_scope() as db:
        await _edition(db, "L99003", "Cataract Surgery", "\n\n".join(quotes))
        assert await transfer_from_family(db, "L99003") is None
