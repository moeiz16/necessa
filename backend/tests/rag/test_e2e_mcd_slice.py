"""End-to-end on a slice of the REAL CMS MCD exports (skipped when data/raw is absent, e.g. in CI)."""

from __future__ import annotations

import uuid
from datetime import date

import pytest

from app.ai.retrieval.retriever import get_retriever
from app.ai.retrieval.types import PolicyFilters, RetrievalQuery
from tests.rag.conftest import RAW_DIR, requires_mcd

pytestmark = [pytest.mark.asyncio, requires_mcd]


async def test_mcd_parse_pins_link_tables_to_current_version():
    from app.ai.ingestion.mcd import parse_mcd

    docs, _ = parse_mcd(RAW_DIR, policy_keys=["A52369", "L33396"])
    art = next(d for d in docs if d.source_key == "A52369")
    assert art.doc_type == "Billing and Coding" and art.version == 17
    assert {"29877", "G0289"} <= {c.code for c in art.codes if c.system == "HCPCS"}
    assert any(c.system == "ICD10_NONCOVERED" for c in art.codes)
    # CPT descriptors never enter chunkable text (AMA licensing); HCPCS numbers do
    codes_text = next(s.text for s in art.sections if s.key == "code_groups")
    assert "29877" in codes_text and "29877 (" not in codes_text  # CPT: number only
    assert "G0289 (" in codes_text  # HCPCS Level II descriptions are public domain
    lcd = next(d for d in docs if d.source_key == "L33396")
    assert any(rel == "lcd_ncd" for _, rel, _ in lcd.links) and lcd.contractors


async def test_real_slice_retrieval_resolution_and_graph(mcd_slice_index, db):
    assert mcd_slice_index["index"]["status"] in {"active", "failed"}
    org = uuid.uuid4()
    r = get_retriever()

    by_code = await r.search(RetrievalQuery(text="29877", org_id=org))
    assert by_code.chunks and by_code.chunks[0].source["source_key"] == "A52369"

    concept = await r.search(
        RetrievalQuery(
            text="arthroscopic lavage and debridement for osteoarthritis of the knee", org_id=org, top_k=10
        )
    )
    keys = {c.source["source_key"] for c in concept.chunks}
    assert keys & {"A52369", "NCD-150.9"}

    tibial = await r.search(
        RetrievalQuery(text="posterior tibial nerve stimulation for overactive bladder", org_id=org, top_k=10)
    )
    assert "L33396" in {c.source["source_key"] for c in tibial.chunks}

    from app.ai.graph.coverage_graph import coverage_paths
    from app.ai.sql.tools import find_policies_by_code

    g = await coverage_paths(db, "29877")
    types = {n.type for n in g.nodes}
    assert {"code", "article", "contractor", "state"} <= types
    rows = await find_policies_by_code(db, "29877")
    assert any(x["sourceKey"] == "A52369" for x in rows)


async def test_real_slice_state_filter_and_as_of(mcd_slice_index):
    org = uuid.uuid4()
    res = await get_retriever().search(
        RetrievalQuery(
            text="tibial nerve stimulation coverage",
            org_id=org,
            filters=PolicyFilters(states=["ZZ"], as_of=date.today()),
        )
    )
    # unknown state → only national (NCD) content may match
    assert all(c.source.get("doc_type") == "NCD" for c in res.chunks)
