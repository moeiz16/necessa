"""Policy knowledge graph built from STRUCTURED MCD tables — not LLM entity extraction.

    (code) ←LISTS_CODE─ (article|lcd|payer) ─HAS_ARTICLE/REFERENCES_NCD→ (lcd|ncd)
    (lcd|article) ─ISSUED_BY→ (contractor) ─SERVES→ (state)
    (version) ─SUPERSEDES→ (version)          # temporal chain

Because edges come from CMS's own relational data, the graph is exact, auditable and free to build —
the classic GraphRAG failure modes (noisy extraction, expensive community summarization) don't apply.
Stored relationally (adjacency tables + recursive traversal); an optional Neo4j export exists for
exploration (ADR-006).
"""

from __future__ import annotations

import itertools
import uuid
from collections import defaultdict
from datetime import date

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.knowledge import (
    Contractor,
    Policy,
    PolicyCode,
    PolicyContractor,
    PolicyLink,
    PolicyState,
    PolicyVersion,
)
from app.schemas.knowledge import CoverageGraph, GraphEdge, GraphNode

_TYPE = {"lcd": "lcd", "article": "article", "ncd": "ncd", "payer": "payer"}


def _norm(code: str) -> tuple[str, list[str]]:
    c = code.strip().upper()
    if len(c) >= 3 and c[0].isalpha() and c[1:3].isdigit() and (len(c) == 3 or "." in c):
        return c, ["ICD10_COVERED", "ICD10_NONCOVERED"]
    return c, ["HCPCS"]


async def coverage_paths(
    db: AsyncSession,
    code: str,
    state: str | None = None,
    as_of: date | None = None,
    max_hops: int = 3,
    max_states: int = 12,
) -> CoverageGraph:
    code, systems = _norm(code)
    nodes: dict[str, GraphNode] = {}
    edges: list[GraphEdge] = []
    edge_keys: set[tuple[str, str, str]] = set()

    def node(nid: str, ntype: str, label: str, **meta) -> str:
        if nid not in nodes:
            nodes[nid] = GraphNode(id=nid, type=ntype, label=label, meta=meta)  # type: ignore[arg-type]
        return nid

    def edge(a: str, b: str, t: str) -> None:
        if (a, b, t) not in edge_keys:
            edge_keys.add((a, b, t))
            edges.append(GraphEdge(source=a, target=b, type=t))

    root = node(f"code:{code}", "code", code, system=systems[0])
    rows = (
        await db.execute(
            select(PolicyCode.policy_version_id, PolicyCode.code_system)
            .where(PolicyCode.code == code, PolicyCode.code_system.in_(systems))
            .distinct()
        )
    ).all()
    frontier: dict[uuid.UUID, str] = {}
    for vid, system in rows:
        frontier[vid] = system
    if not frontier:
        return CoverageGraph(nodes=list(nodes.values()), edges=[], stats={"policies": 0})
    versions = {
        v.id: v
        for v in (
            await db.execute(select(PolicyVersion).where(PolicyVersion.id.in_(list(frontier))))
        ).scalars()
    }
    pols = {
        p.id: p
        for p in (
            await db.execute(select(Policy).where(Policy.id.in_([v.policy_id for v in versions.values()])))
        ).scalars()
    }

    def eff_ok(v: PolicyVersion) -> bool:
        if not as_of:
            return True
        return not (
            (v.effective_from and v.effective_from > as_of) or (v.effective_to and v.effective_to < as_of)
        )

    level: dict[uuid.UUID, int] = {}
    for vid, system in frontier.items():
        v = versions.get(vid)
        p = pols.get(v.policy_id) if v else None
        if not v or not p or not eff_ok(v) or p.current_version_id != v.id:
            continue
        nid = node(
            f"policy:{p.source_key}",
            _TYPE.get(p.source, "article"),
            p.source_key,
            title=p.title,
            docType=p.doc_type,
            version=v.version,
            policyId=str(p.id),
        )
        edge(
            nid,
            root,
            "LISTS_CODE"
            if system == "HCPCS"
            else ("COVERS_DX" if system == "ICD10_COVERED" else "EXCLUDES_DX"),
        )
        level[v.id] = 1

    # hop through links (article→LCD, LCD→NCD …) breadth-first, bounded
    current = set(level)
    for hop in range(2, max_hops + 1):
        if not current:
            break
        links = list(
            (
                await db.execute(select(PolicyLink).where(PolicyLink.from_version_id.in_(list(current))))
            ).scalars()
        )
        nxt: set[uuid.UUID] = set()
        targets = {ln.to_source_key for ln in links}
        tpols = (
            {
                p.source_key: p
                for p in (
                    await db.execute(select(Policy).where(Policy.source_key.in_(list(targets))))
                ).scalars()
            }
            if targets
            else {}
        )
        for ln in links:
            src_v = versions.get(ln.from_version_id)
            if src_v is None:
                continue
            src = pols[src_v.policy_id]
            tp = tpols.get(ln.to_source_key)
            label = ln.to_source_key
            ttype = "ncd" if label.startswith("NCD") else ("lcd" if label.startswith("L") else "article")
            tid = node(
                f"policy:{label}",
                ttype,
                label,
                title=tp.title if tp else None,
                docType=tp.doc_type if tp else None,
                indexed=tp is not None,
                policyId=str(tp.id) if tp else None,
            )
            etype = {
                "article_lcd": "SUPPORTS_LCD",
                "lcd_article": "HAS_ARTICLE",
                "lcd_ncd": "REFERENCES_NCD",
                "article_ncd": "REFERENCES_NCD",
            }.get(ln.relation, "RELATED")
            edge(f"policy:{src.source_key}", tid, etype)
            if tp and tp.current_version_id and tp.current_version_id not in level:
                v = await db.get(PolicyVersion, tp.current_version_id)
                if v:
                    versions[v.id] = v
                    pols[tp.id] = tp
                    level[v.id] = hop
                    nxt.add(v.id)
        current = nxt

    vids = list(level)
    # contractors + states
    crow = (
        await db.execute(
            select(PolicyContractor.policy_version_id, Contractor.id, Contractor.name, Contractor.type_label)
            .join(
                Contractor,
                and_(
                    Contractor.id == PolicyContractor.contractor_id,
                    Contractor.type_id == PolicyContractor.contractor_type_id,
                ),
            )
            .where(PolicyContractor.policy_version_id.in_(vids))
        )
    ).all()
    for vid, cid, name, tlabel in crow:
        p = pols[versions[vid].policy_id]
        c = node(f"contractor:{cid}", "contractor", name, typeLabel=tlabel)
        edge(f"policy:{p.source_key}", c, "ISSUED_BY")
    srows = (
        await db.execute(
            select(PolicyState.policy_version_id, PolicyState.state_abbrev).where(
                PolicyState.policy_version_id.in_(vids)
            )
        )
    ).all()
    by_policy_states: dict[str, set[str]] = defaultdict(set)
    for vid, ab in srows:
        by_policy_states[pols[versions[vid].policy_id].source_key].add(ab)
    for key, sts in by_policy_states.items():
        show = [s for s in sorted(sts) if (not state or s in {state.upper(), "US"})][:max_states]
        for s in show:
            sid = node(f"state:{s}", "state", "National" if s == "US" else s)
            edge(f"policy:{key}", sid, "APPLIES_IN")
    # temporal: previous versions of the reached policies
    for p in {pols[versions[v].policy_id] for v in vids}:
        prev = (
            (
                await db.execute(
                    select(PolicyVersion)
                    .where(PolicyVersion.policy_id == p.id)
                    .order_by(PolicyVersion.version.desc())
                )
            )
            .scalars()
            .all()
        )
        if len(prev) > 1:
            for newer, older in itertools.pairwise(prev):
                a = node(
                    f"version:{p.source_key}:v{newer.version}", "version", f"{p.source_key} v{newer.version}"
                )
                b = node(
                    f"version:{p.source_key}:v{older.version}", "version", f"{p.source_key} v{older.version}"
                )
                edge(a, b, "SUPERSEDES")
                edge(
                    f"policy:{p.source_key}",
                    a,
                    "CURRENT_VERSION" if newer.id == p.current_version_id else "VERSION",
                )
    stats = {
        "policies": sum(1 for n in nodes.values() if n.type in {"lcd", "article", "ncd", "payer"}),
        "contractors": sum(1 for n in nodes.values() if n.type == "contractor"),
        "states": sum(1 for n in nodes.values() if n.type == "state"),
        "hops": max(level.values(), default=0),
    }
    return CoverageGraph(nodes=list(nodes.values()), edges=edges, stats=stats)
