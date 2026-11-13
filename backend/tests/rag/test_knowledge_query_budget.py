"""Knowledge-side query regressions: the coverage graph and code->policy lookups must issue a constant
number of statements regardless of how many policies/links/versions they touch (they used to issue one
statement per link target, per reached policy and per candidate version), plus the library-search cache.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.ai.graph.coverage_graph import coverage_paths
from app.ai.sql.tools import covered_dx_for_policy, find_policies_by_code, resolve_policies
from app.db.models.knowledge import Policy, PolicyCode, PolicyLink, PolicyState, PolicyVersion
from app.db.session import query_stats, session_scope
from tests.conftest import signup_with_org

_SEEDED: list[str] = []  # source keys created by a test; removed afterwards (the test DB is shared)


@pytest_asyncio.fixture(autouse=True)
async def _cleanup_seeded_policies():
    yield
    if not _SEEDED:
        return
    keys = list(_SEEDED)
    _SEEDED.clear()
    async with session_scope() as db:
        pids = select(Policy.id).where(Policy.source_key.in_(keys))
        vids = select(PolicyVersion.id).where(PolicyVersion.policy_id.in_(pids))
        await db.execute(delete(PolicyCode).where(PolicyCode.policy_version_id.in_(vids)))
        await db.execute(delete(PolicyState).where(PolicyState.policy_version_id.in_(vids)))
        await db.execute(delete(PolicyLink).where(PolicyLink.from_version_id.in_(vids)))
        await db.execute(delete(PolicyVersion).where(PolicyVersion.policy_id.in_(pids)))
        await db.execute(delete(Policy).where(Policy.source_key.in_(keys)))


async def _seed_graph(n_articles: int) -> tuple[str, list[str]]:
    """`n_articles` articles list one fresh HCPCS code; each links to its own LCD; every policy has two
    versions. Returns (code, article source keys)."""
    code = "X" + uuid.uuid4().hex[:4].upper()
    tag = uuid.uuid4().hex[:6].upper()
    keys: list[str] = []
    async with session_scope() as db:
        for i in range(n_articles):
            lcd_key, art_key = f"L{tag}{i}", f"A{tag}{i}"
            keys.append(art_key)
            _SEEDED.extend((lcd_key, art_key))
            vids: dict[str, uuid.UUID] = {}
            for key, source, doc_type in ((lcd_key, "lcd", "LCD"), (art_key, "article", "Article")):
                pol = Policy(source=source, source_key=key, title=f"{doc_type} {key}", doc_type=doc_type)
                db.add(pol)
                await db.flush()
                for ver in (1, 2):
                    vid = uuid.uuid4()
                    db.add(PolicyVersion(id=vid, policy_id=pol.id, version=ver, content_hash=f"{key}{ver}"))
                    vids[key] = vid
                await db.flush()
                pol.current_version_id = vids[key]
                db.add(PolicyState(policy_version_id=vids[key], state_abbrev="OH", primary=True))
            db.add(PolicyCode(policy_version_id=vids[art_key], code_system="HCPCS", code=code))
            for dx, system in (("M54.50", "ICD10_COVERED"), ("Z00.00", "ICD10_NONCOVERED")):
                db.add(PolicyCode(policy_version_id=vids[art_key], code_system=system, code=dx))
            db.add(PolicyLink(from_version_id=vids[art_key], to_source_key=lcd_key, relation="article_lcd"))
    return code, keys


async def _count(coro) -> tuple[object, int]:
    stats = {"count": 0, "ms": 0.0}
    token = query_stats.set(stats)
    try:
        result = await coro
    finally:
        query_stats.reset(token)
    return result, int(stats["count"])


async def test_coverage_graph_statements_are_constant_in_graph_size():
    counts = []
    for n in (2, 6):
        code, keys = await _seed_graph(n)
        async with session_scope() as db:
            graph, stmts = await _count(coverage_paths(db, code, "OH"))
        counts.append(stmts)
        types = [nd.type for nd in graph.nodes]
        assert types.count("article") == n and types.count("lcd") == n  # article -> LCD hop followed
        assert sum(1 for e in graph.edges if e.type == "SUPERSEDES") == 2 * n  # version chains built
        assert {f"policy:{k}" for k in keys} <= {nd.id for nd in graph.nodes}
    # code rows, versions, policies, 2 hops x (links, link targets, target versions), contractors,
    # states, version history: 10 no matter how many policies, links and versions are reached
    assert counts[0] == counts[1] <= 10, counts


async def test_code_lookup_and_policy_resolution_statements_are_constant():
    find_counts, resolve_counts = [], []
    for n in (2, 6):
        code, keys = await _seed_graph(n)
        async with session_scope() as db:
            found, stmts = await _count(find_policies_by_code(db, code, "OH", limit=50))
            assert {f["sourceKey"] for f in found} == set(keys)
            assert all(f["states"] == ["OH"] for f in found)
            find_counts.append(stmts)
            matches, stmts = await _count(
                resolve_policies(
                    db,
                    service_codes=[code],
                    dx_codes=["M54.50", "Z00.00", "R69"],
                    state="OH",
                    payer_type="medicare_ffs",
                    date_of_service=date(2026, 12, 1),
                    limit=50,
                )
            )
            resolve_counts.append(stmts)
            by_key = {m.source_key: m for m in matches}
            assert set(keys) <= set(by_key)  # articles (listing the code) + their linked LCDs
            art = by_key[keys[0]]
            assert art.dx_status == {"M54.50": "covered", "Z00.00": "noncovered", "R69": "unlisted"}
            # the single-version helper still agrees with the batched path
            assert await covered_dx_for_policy(db, art.policy_version_id, ["M54.50"]) == {"M54.50": "covered"}
    assert find_counts[0] == find_counts[1] <= 2, find_counts
    assert resolve_counts[0] == resolve_counts[1] <= 10, resolve_counts


async def test_code_graph_endpoint_budget(client, fixtures_index):
    owner = await signup_with_org(client)
    r = await owner.get("/api/v1/codes/HCPCS/E0601/graph")
    assert r.status_code == 200 and r.json()["nodes"]
    from tests.platform.test_query_budget import statements

    # Structural maximum for hops=3, independent of graph size: 1 auth + code rows, versions, policies
    # + 2 hops x (links, link targets, target versions) + contractors, states, version history.
    # (Before batching, E0601/OH on the real CMS data took 59 statements.)
    assert statements(r) <= 13


async def test_library_search_hits_are_cached_per_org_and_invalidated_by_knowledge_writes(
    client, make_client, fixtures_index, monkeypatch
):
    from app.ai.retrieval.retriever import get_retriever
    from app.api.v1 import policies as policies_api

    policies_api._LIBRARY_HITS.clear()
    retriever = get_retriever()
    calls = 0
    real_search = retriever.search

    async def counting_search(*args, **kwargs):
        nonlocal calls
        calls += 1
        return await real_search(*args, **kwargs)

    monkeypatch.setattr(retriever, "search", counting_search)
    owner = await signup_with_org(client)
    params = {"q": "CPAP adherence documentation"}
    first = await owner.get("/api/v1/policies", params=params)
    assert first.status_code == 200 and first.json()["items"]
    second = await owner.get("/api/v1/policies", params={"q": "  CPAP   adherence documentation "})
    assert second.json() == first.json() and calls == 1  # whitespace-normalized cache hit

    other = await signup_with_org(make_client(), "Other Org")
    assert (await other.get("/api/v1/policies", params=params)).status_code == 200
    assert calls == 2  # tenant-scoped: payer uploads differ per org, so no cross-org reuse

    upload_key = f"PAYER-T-{uuid.uuid4().hex[:8]}"
    _SEEDED.append(upload_key)
    async with session_scope() as db:  # e.g. a payer policy upload for this org
        db.add(
            Policy(
                source="payer",
                source_key=upload_key,
                title="Uploaded payer policy",
                doc_type="Payer Policy",
                org_id=uuid.UUID(owner.org["id"]),
            )
        )
    assert (await owner.get("/api/v1/policies", params=params)).status_code == 200
    assert calls == 3  # knowledge write -> recomputed


@pytest.mark.parametrize("cursor", ["LTE", "MTAwMDAwMDA", "%%%"])
async def test_policy_list_rejects_out_of_range_cursors(client, cursor):
    owner = await signup_with_org(client)
    r = await owner.get("/api/v1/policies", params={"cursor": cursor})
    assert r.status_code == 400 and r.json()["code"] == "invalid_cursor"
