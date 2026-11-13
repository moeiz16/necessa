"""Every curated criterion quote must be verbatim in its policy text (real CMS LCDs, B's fixtures, or
the synthetic policy text embedded in the curated file). No CPT descriptors in quotes."""

from __future__ import annotations

import json
import re

import pytest

from app.ai.compiler.curated import ground_tree, lcd_sections_from_csv, load_curated
from app.ai.compiler.text import find_quote, html_to_text, normalize_for_match
from app.core.config import REPO_ROOT, get_settings

FIXTURES = REPO_ROOT / "backend" / "app" / "ai" / "ingestion" / "fixtures"


def fixture_sections() -> dict[str, dict[str, str]]:
    out = {}
    for p in FIXTURES.glob("*.json"):
        d = json.loads(p.read_text())
        secs = d.get("sections") or []
        out[d["source_key"]] = {s["key"]: s["text"] for s in secs} if isinstance(secs, list) else secs
    return out


CURATED = load_curated()


def test_curated_catalog_loaded():
    assert len(CURATED) >= 10
    real = [k for k in CURATED if k.startswith("L")]
    assert len(real) >= 5


@pytest.mark.parametrize("key", sorted(CURATED))
def test_quotes_are_verbatim(key):
    tree = CURATED[key]
    sections = (
        tree.sections or fixture_sections().get(key) or lcd_sections_from_csv(key, get_settings().data_dir)
    )
    if not sections:
        pytest.skip(f"source text for {key} not available offline (CMS MCD CSV not downloaded)")
    report = ground_tree(tree, sections)
    assert report.pass_rate == 1.0, [(g.criterion_id, g.reason) for g in report.failures]


@pytest.mark.parametrize("key", sorted(CURATED))
def test_no_cpt_codes_or_descriptors_in_quotes(key):
    for leaf in CURATED[key].leaves():
        assert not re.search(r"\b\d{5}\b", leaf.source_span.quote), (key, leaf.id)


@pytest.mark.parametrize("key", sorted(CURATED))
def test_synthetic_hints_dont_reuse_policy_quotes(key):
    for leaf in CURATED[key].leaves():
        for s in leaf.synthetic.present if leaf.synthetic else []:
            assert normalize_for_match(leaf.source_span.quote) not in normalize_for_match(s)


def test_find_quote_offsets_and_normalization():
    src = "The  member’s pain\n has been present for at least three months."  # noqa: RUF001
    ok, s, e = find_quote("member's pain has been present", src)
    assert ok and src[s:e].startswith("member")
    assert not find_quote("present for at least four months", src)[0]
    assert not find_quote("short", src)[0]  # too short to be a citation


def test_html_to_text_keeps_paragraphs():
    t = html_to_text("<p>A&nbsp;&amp; B</p><ul><li>one</li><li>two&#8217;s</li></ul>")
    assert "A & B" in t and "one" in t and "two's" in t and "\n" in t
