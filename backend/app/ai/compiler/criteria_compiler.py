"""Policy text → criteria tree, with proof.

Pipeline (one policy version):
  1. Load sections (knowledge base). Curated trees short-circuit the LLM entirely.
  2. Extract with the `compiler-longctx` group into a FLAT schema (groups + criteria). Flat output is far
     more reliable than recursive JSON on free-tier models; we rebuild the tree in code.
  3. Validate against the Pydantic schema (structure, unique ids, N_OF_M bounds).
  4. Ground: every quote must appear verbatim in the policy text (`find_quote`). Ungrounded leaves are
     removed and the set can't be auto-approved.
  5. Cross-model verification: the `verifier` group (a different model family) re-extracts; agreement
     = 1 - normalized tree edit distance.
  6. status = approved iff grounding == 100% and agreement ≥ 0.80; otherwise needs_review (admin queue).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import structlog
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.compiler.curated import (
    GroundingReport,
    apply_grounding,
    ground_tree,
    load_curated,
    sections_from_db,
)
from app.ai.compiler.prompting import render_prompt
from app.ai.compiler.schema import CriteriaNode, CriteriaTree, CriterionLeaf, SourceSpan
from app.ai.compiler.tree_distance import agreement
from app.db.models.criteria import CriteriaSet

log = structlog.get_logger(__name__)

AUTO_APPROVE_AGREEMENT = 0.80
MAX_POLICY_CHARS = 60_000
SECTION_PRIORITY = [
    "indication",
    "doc_reqs",
    "limitations",
    "cms_cov_policy",
    "util_guide",
    "associated_info",
    "item_service",
    "coding_guidelines",
    "description",
    "other_comments",
]


# ── flat LLM output schema ─────────────────────────────────────────────────────────────────────


class FlatGroup(BaseModel):
    id: str
    op: str = "AND"
    n: int | None = None
    parent: str | None = None
    label: str | None = None


class FlatCriterion(BaseModel):
    id: str
    group: str = "G0"
    text: str
    kind: str = "positive"
    sectionKey: str = "indication"
    quote: str
    lookbackDays: int | None = None
    keywords: list[str] = Field(default_factory=list)
    suggestedFix: str | None = None


class FlatCriteria(BaseModel):
    title: str = ""
    scope: str = ""
    services: list[str] = Field(default_factory=list)
    groups: list[FlatGroup] = Field(default_factory=list)
    criteria: list[FlatCriterion] = Field(default_factory=list)


def build_tree(
    flat: FlatCriteria, *, policy_key: str, policy_version: int | None, title: str
) -> CriteriaTree:
    groups = {g.id: g for g in flat.groups} or {"G0": FlatGroup(id="G0", op="AND")}
    root_id = next((g.id for g in groups.values() if not g.parent), next(iter(groups)))
    nodes: dict[str, dict[str, Any]] = {}
    for g in groups.values():
        op = g.op.upper() if g.op.upper() in {"AND", "OR", "N_OF_M"} else "AND"
        nodes[g.id] = {
            "type": "node",
            "op": op,
            "n": g.n if op == "N_OF_M" else None,
            "label": g.label,
            "children": [],
        }
    seen_ids: set[str] = set()
    for i, c in enumerate(flat.criteria, start=1):
        cid = c.id if c.id and c.id[0].isalpha() and c.id not in seen_ids else f"C{i}"
        seen_ids.add(cid)
        kind = (
            c.kind
            if c.kind in {"positive", "negative_attestation", "documentation", "temporal", "numeric"}
            else "positive"
        )
        leaf = {
            "type": "criterion",
            "id": cid[:16],
            "text": c.text[:600],
            "kind": kind,
            "lookbackDays": c.lookbackDays if c.lookbackDays and c.lookbackDays > 0 else None,
            "keywords": c.keywords[:10],
            "suggestedFix": c.suggestedFix,
            "sourceSpan": {"sectionKey": c.sectionKey or "indication", "quote": c.quote},
        }
        nodes.get(c.group, nodes[root_id])["children"].append(leaf)
    for g in groups.values():
        if g.id != root_id:
            parent = nodes.get(g.parent or root_id, nodes[root_id])
            if nodes[g.id]["children"]:
                parent["children"].append(nodes[g.id])
    _prune(nodes[root_id])
    return CriteriaTree.model_validate(
        {
            "policyKey": policy_key,
            "policyVersion": policy_version,
            "title": flat.title or title,
            "scope": flat.scope or None,
            "services": flat.services,
            "root": nodes[root_id],
        }
    )


def _prune(node: dict) -> None:
    node["children"] = [c for c in node["children"] if c["type"] == "criterion" or c["children"]]
    for c in node["children"]:
        if c["type"] == "node":
            _prune(c)
    if node["op"] == "N_OF_M" and (node["n"] or 0) > len(node["children"]):
        node["n"] = len(node["children"]) or 1


def drop_ungrounded(tree: CriteriaTree, report: GroundingReport) -> CriteriaTree:
    bad = {g.criterion_id for g in report.failures}
    if not bad:
        return tree

    def strip(node: CriteriaNode) -> CriteriaNode | None:
        kids: list[CriteriaNode | CriterionLeaf] = []
        for c in node.children:
            if isinstance(c, CriterionLeaf):
                if c.id not in bad:
                    kids.append(c)
            else:
                s = strip(c)
                if s is not None:
                    kids.append(s)
        if not kids:
            return None
        n = min(node.n, len(kids)) if node.n else None
        return CriteriaNode(op=node.op, n=n, label=node.label, children=kids)

    root = strip(tree.root)
    if root is None:  # nothing grounded — keep a placeholder leaf so the set is reviewable
        root = CriteriaNode(
            op="AND",
            children=[
                CriterionLeaf(
                    id="C1",
                    text="(no grounded criteria extracted — manual authoring required)",
                    source_span=SourceSpan(section_key="indication", quote="manual authoring required"),
                )
            ],
        )
    return tree.model_copy(update={"root": root})


def sections_prompt(sections: dict[str, str]) -> str:
    ordered = [k for k in SECTION_PRIORITY if sections.get(k)] + [
        k for k in sections if k not in SECTION_PRIORITY
    ]
    out, used = [], 0
    for k in ordered:
        text = (sections.get(k) or "").strip()
        if not text:
            continue
        text = text[: max(0, MAX_POLICY_CHARS - used)]
        if not text:
            break
        out.append(f'<section key="{k}">\n{text}\n</section>')
        used += len(text)
    return "\n".join(out)


async def extract(
    router: Any,
    *,
    group: str,
    policy_key: str,
    title: str,
    scope: str,
    sections: dict[str, str],
    policy_version: int | None,
) -> tuple[CriteriaTree, str]:
    from app.ai.llm.types import DataClass

    prompt = render_prompt(
        "criteria_extract",
        policy_key=policy_key,
        title=title,
        scope=scope or title,
        sections=sections_prompt(sections),
    )
    res = await router.complete(
        group=group,
        purpose=f"criteria.extract.{group}",
        data_class=DataClass.PUBLIC,
        messages=[{"role": "user", "content": prompt}],
        response_model=FlatCriteria,
        temperature=0.0,
        max_tokens=4096,
    )
    tree = build_tree(res.parsed, policy_key=policy_key, policy_version=policy_version, title=title)
    return tree, f"{res.provider}/{res.model}"


async def compile_policy(
    db: AsyncSession,
    *,
    policy_key: str,
    router: Any | None,
    scope: str | None = None,
    actor_id: uuid.UUID | None = None,
    job_id: uuid.UUID | None = None,
) -> CriteriaSet:
    """Compile (or sync the curated tree for) the current version of `policy_key` and persist a CriteriaSet."""  # noqa: E501
    version_id, sections = await sections_from_db(db, policy_key)
    curated = load_curated().get(policy_key)
    if curated is not None:
        return await upsert_curated(db, curated, version_id, sections)
    if not sections:
        raise ValueError(f"policy {policy_key} has no ingested sections")
    if router is None:
        raise RuntimeError("LLM router unavailable — cannot compile criteria")
    title = await _policy_title(db, policy_key) or policy_key
    version_no = await _policy_version_no(db, version_id)
    tree, extractor = await extract(
        router,
        group="compiler-longctx",
        policy_key=policy_key,
        title=title,
        scope=scope or "",
        sections=sections,
        policy_version=version_no,
    )
    report = ground_tree(tree, sections)
    grounded = apply_grounding(
        drop_ungrounded(tree, report), ground_tree(drop_ungrounded(tree, report), sections)
    )
    agreement_score, verifier = None, None
    try:
        check_tree, verifier = await extract(
            router,
            group="verifier",
            policy_key=policy_key,
            title=title,
            scope=scope or "",
            sections=sections,
            policy_version=version_no,
        )
        agreement_score = agreement(tree.root, check_tree.root)
    except Exception as exc:
        log.warning("criteria.verify_failed", policy=policy_key, error=str(exc)[:200])
    status = (
        "approved"
        if (report.pass_rate == 1.0 and (agreement_score or 0) >= AUTO_APPROVE_AGREEMENT)
        else "needs_review"
    )
    cs = CriteriaSet(
        policy_version_id=version_id,
        policy_key=policy_key,
        policy_version=version_no,
        title=grounded.title,
        status=status,
        source="llm",
        tree=grounded.model_dump(by_alias=True, exclude_none=True),
        extractor_model=extractor,
        verifier_model=verifier,
        agreement=agreement_score,
        grounding_pass_rate=round(report.pass_rate, 4),
        grounding=_report_json(report),
        notes=None if status == "approved" else _review_note(report, agreement_score),
        job_id=job_id,
    )
    if status == "approved":
        await _supersede(db, policy_key)
    db.add(cs)
    await db.flush()
    if status == "approved":
        await index_criteria_set(cs)
    return cs


async def upsert_curated(
    db: AsyncSession, tree: CriteriaTree, version_id: str | None, sections: dict[str, str] | None = None
) -> CriteriaSet:
    existing = (
        (
            await db.execute(
                select(CriteriaSet).where(
                    CriteriaSet.policy_key == tree.policy_key,
                    CriteriaSet.source == "curated",
                    CriteriaSet.status == "approved",
                )
            )
        )
        .scalars()
        .first()
    )
    report = None
    secs = sections or tree.sections or {}
    if secs:
        report = ground_tree(tree, secs)
        tree = apply_grounding(tree, report)
    data = tree.model_dump(by_alias=True, exclude_none=True)
    if existing is not None:
        existing.tree = data
        existing.policy_version_id = version_id or existing.policy_version_id
        existing.grounding_pass_rate = round(report.pass_rate, 4) if report else existing.grounding_pass_rate
        existing.grounding = _report_json(report) if report else existing.grounding
        await db.flush()
        return existing
    await _supersede(db, tree.policy_key)
    cs = CriteriaSet(
        policy_version_id=version_id,
        policy_key=tree.policy_key,
        policy_version=tree.policy_version,
        title=tree.title,
        status="approved",
        source="curated",
        tree=data,
        extractor_model="curated",
        verifier_model="human-review",
        agreement=1.0,
        grounding_pass_rate=round(report.pass_rate, 4) if report else None,
        grounding=_report_json(report) if report else None,
        notes="Curated by clinical content team (synthetic demo policy)."
        if tree.synthetic
        else "Curated by clinical content team; quotes verified against CMS MCD text.",
        reviewed_at=datetime.now(UTC),
    )
    db.add(cs)
    await db.flush()
    await index_criteria_set(cs)
    return cs


async def index_criteria_set(cs: CriteriaSet) -> int:
    """Best-effort: index approved criteria into the retrieval layer (scope="criteria", denial mapping)."""
    try:
        from app.ai.retrieval.chart_index import index_criteria

        tree = CriteriaTree.model_validate(cs.tree)
        return await index_criteria(
            cs.policy_version_id or f"curated:{cs.policy_key}",
            cs.policy_key,
            cs.title,
            [
                {"criterion_id": leaf.id, "text": leaf.text, "quote": leaf.source_span.quote}
                for leaf in tree.leaves()
            ],
        )
    except Exception as exc:
        log.info("criteria.index_skipped", policy=cs.policy_key, error=str(exc)[:160])
        return 0


async def sync_curated(db: AsyncSession) -> list[CriteriaSet]:
    out = []
    for key, tree in load_curated().items():
        version_id, sections = await sections_from_db(db, key)
        out.append(await upsert_curated(db, tree, version_id, sections or None))
    return out


async def approved_set(
    db: AsyncSession, policy_key: str, policy_version_id: str | None = None
) -> CriteriaSet | None:
    q = select(CriteriaSet).where(CriteriaSet.policy_key == policy_key, CriteriaSet.status == "approved")
    rows = (await db.execute(q.order_by(CriteriaSet.created_at.desc()))).scalars().all()
    if policy_version_id:
        for r in rows:
            if r.policy_version_id == policy_version_id:
                return r
    return rows[0] if rows else None


async def _supersede(db: AsyncSession, policy_key: str) -> None:
    await db.execute(
        update(CriteriaSet)
        .where(CriteriaSet.policy_key == policy_key, CriteriaSet.status == "approved")
        .values(status="superseded")
    )


async def _policy_title(db: AsyncSession, policy_key: str) -> str | None:
    try:
        from app.db.models.knowledge import Policy
    except Exception:
        return None
    return (
        await db.execute(select(Policy.title).where(Policy.source_key == policy_key))
    ).scalar_one_or_none()


async def _policy_version_no(db: AsyncSession, version_id: str | None) -> int | None:
    if not version_id:
        return None
    try:
        from app.db.models.knowledge import PolicyVersion
    except Exception:
        return None
    return (
        await db.execute(select(PolicyVersion.version).where(PolicyVersion.id == uuid.UUID(str(version_id))))
    ).scalar_one_or_none()


def _report_json(report: GroundingReport | None) -> dict | None:
    if report is None:
        return None
    return {
        "passRate": round(report.pass_rate, 4),
        "leaves": [
            {
                "criterionId": g.criterion_id,
                "ok": g.ok,
                "sectionKey": g.section_key,
                "start": g.start,
                "end": g.end,
                "reason": g.reason,
            }
            for g in report.leaves
        ],
    }


def _review_note(report: GroundingReport, agreement_score: float | None) -> str:
    parts = []
    if report.failures:
        parts.append(
            f"{len(report.failures)} criteria failed verbatim grounding and were removed: "
            + ", ".join(g.criterion_id for g in report.failures)
        )
    if agreement_score is None:
        parts.append("Cross-model verification unavailable.")
    elif agreement_score < AUTO_APPROVE_AGREEMENT:
        parts.append(f"Cross-model agreement {agreement_score:.2f} < {AUTO_APPROVE_AGREEMENT}.")
    return " ".join(parts) or "Needs human review."


def tree_of(cs: CriteriaSet) -> CriteriaTree:
    return CriteriaTree.model_validate(cs.tree)


def _norm_title(title: str | None) -> str:
    return " ".join((title or "").lower().split())


async def transfer_from_family(
    db: AsyncSession, policy_key: str, version_id: str | None = None
) -> CriteriaSet | None:
    """Reuse a curated criteria set from another contractor's edition of the same policy.

    Medicare contractors frequently publish the same LCD text under different IDs (e.g. the
    facet-joint LCD exists once per jurisdiction). A curated tree is transferred only when EVERY
    quote is found verbatim in the target policy's own current text; otherwise the attempt is
    stored as `needs_review` for a human and nothing is returned, so an evaluation never runs on
    criteria that aren't grounded in the policy that actually applies.
    """
    try:
        from app.db.models.knowledge import Policy
    except Exception:  # knowledge schema unavailable
        return None
    target = (await db.execute(select(Policy).where(Policy.source_key == policy_key))).scalar_one_or_none()
    if target is None:
        return None
    curated = load_curated()
    donors = [
        t
        for t in curated.values()
        if not t.synthetic
        and t.policy_key != policy_key
        and _norm_title(t.title) == _norm_title(target.title)
    ]
    if not donors:
        return None
    pending = (
        await db.execute(
            select(CriteriaSet.id).where(
                CriteriaSet.policy_key == policy_key, CriteriaSet.status == "needs_review"
            )
        )
    ).first()
    vid, sections = await sections_from_db(db, policy_key)
    if not sections:
        return None
    version_no = await _policy_version_no(db, vid or version_id)
    for donor in sorted(donors, key=lambda t: t.policy_key):
        tree = donor.model_copy(deep=True, update={"policy_key": policy_key, "policy_version": version_no})
        report = ground_tree(tree, sections)
        grounded = report.pass_rate == 1.0
        if not grounded and pending is not None:
            continue
        verified = sum(1 for g in report.leaves if g.ok)
        if grounded:
            await _supersede(db, policy_key)
        cs = CriteriaSet(
            policy_version_id=vid or version_id,
            policy_key=policy_key,
            policy_version=version_no,
            title=target.title,
            status="approved" if grounded else "needs_review",
            source="curated",
            tree=apply_grounding(tree, report).model_dump(by_alias=True, exclude_none=True),
            extractor_model=f"transfer:{donor.policy_key}",
            verifier_model="verbatim-grounding",
            agreement=round(report.pass_rate, 4),
            grounding_pass_rate=round(report.pass_rate, 4),
            grounding=_report_json(report),
            notes=(
                f"Transferred from {donor.policy_key}, another contractor's edition of this policy: "
                f"{verified}/{len(report.leaves)} quotes re-verified verbatim against {policy_key}."
            ),
            reviewed_at=datetime.now(UTC) if grounded else None,
        )
        db.add(cs)
        await db.flush()
        log.info("criteria.transferred", policy=policy_key, donor=donor.policy_key, grounded=grounded)
        if grounded:
            await index_criteria_set(cs)
            return cs
        pending = cs
    return None
