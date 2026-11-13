"""Criteria review API shapes the review editor relies on."""

from __future__ import annotations

import pytest

from tests.conftest import signup_with_org

pytestmark = pytest.mark.asyncio


async def _first_set(acct):
    from app.ai.compiler.criteria_compiler import upsert_curated
    from app.ai.compiler.curated import load_curated
    from app.db.session import session_scope

    async with session_scope() as db:
        tree = load_curated()["PAYER-SYNHP-MP0207"]
        await upsert_curated(db, tree, None, tree.sections)
    r = await acct.get("/api/v1/admin/criteria")
    assert r.status_code == 200, r.text
    return r.json()["items"][0]


async def test_list_exposes_editor_fields(client):
    acct = await signup_with_org(client)
    item = await _first_set(acct)
    assert item["sourceKey"] == item["policyKey"]
    assert item["policyTitle"] == item["title"]
    assert "version" in item


async def test_patch_accepts_root_node_with_section_spelling(client):
    acct = await signup_with_org(client)
    item = await _first_set(acct)
    full = (await acct.get(f"/api/v1/admin/criteria/{item['id']}")).json()
    root = full["tree"]["root"]

    def to_editor(node):  # what the review editor sends back: root node, `section` not `sectionKey`
        node = dict(node)
        if "sourceSpan" in node:
            span = dict(node["sourceSpan"])
            span["section"] = span.pop("sectionKey")
            node["sourceSpan"] = span
        if "children" in node:
            node["children"] = [to_editor(c) for c in node["children"]]
        return node

    r = await acct.patch(f"/api/v1/admin/criteria/{item['id']}", json={"tree": to_editor(root)})
    assert r.status_code == 200, r.text
    saved = r.json()
    assert saved["tree"]["title"] == full["tree"]["title"]

    def spans(node):
        if "sourceSpan" in node:
            yield node["sourceSpan"]
        for c in node.get("children", []):
            yield from spans(c)

    assert all("sectionKey" in sp and "section" not in sp for sp in spans(saved["tree"]["root"]))
