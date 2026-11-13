"""Criteria review queue: list / inspect / edit / approve compiled criteria sets; trigger compilation."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.compiler.criteria_compiler import _supersede
from app.ai.compiler.curated import apply_grounding, ground_tree, load_curated, sections_from_db
from app.ai.compiler.schema import CriteriaTree
from app.core.deps import RequestContext, get_db, require_perm
from app.core.errors import bad_request, not_found
from app.db.base import utcnow
from app.db.models.criteria import CriteriaSet
from app.schemas.evals import CompileIn, CriteriaPatch

router = APIRouter(prefix="/admin/criteria", tags=["admin-criteria"])


def criteria_set_api(cs: CriteriaSet, *, full: bool = False, people: dict[str, dict] | None = None) -> dict:
    tree = cs.tree or {}
    leaves = _count_leaves(tree.get("root", {}))
    reviewer = str(cs.reviewed_by) if cs.reviewed_by else None
    out = {
        "id": str(cs.id),
        "policyKey": cs.policy_key,
        "sourceKey": cs.policy_key,
        "policyVersionId": cs.policy_version_id,
        "policyVersion": cs.policy_version,
        "version": cs.policy_version,
        "title": cs.title,
        "policyTitle": cs.title,
        "status": cs.status,
        "source": cs.source,
        "criteriaCount": leaves,
        "extractorModel": cs.extractor_model,
        "verifierModel": cs.verifier_model,
        "agreement": cs.agreement,
        "groundingPassRate": cs.grounding_pass_rate,
        "notes": cs.notes,
        "synthetic": bool(tree.get("synthetic")),
        "reviewedBy": (people or {}).get(reviewer, {"id": reviewer, "fullName": None}) if reviewer else None,
        "reviewedAt": cs.reviewed_at.isoformat() if cs.reviewed_at else None,
        "createdAt": cs.created_at.isoformat() if cs.created_at else None,
    }
    if full:
        out["tree"] = tree
        out["grounding"] = cs.grounding
    return out


async def _people(db: AsyncSession, rows: list[CriteriaSet]) -> dict[str, dict]:
    from app.db.models.platform import User

    ids = {r.reviewed_by for r in rows if r.reviewed_by}
    if not ids:
        return {}
    users = (await db.execute(select(User.id, User.full_name).where(User.id.in_(ids)))).all()
    return {str(uid): {"id": str(uid), "fullName": name} for uid, name in users}


def _normalize_tree_input(tree: dict, existing: dict | None) -> dict:
    """Accept either a full criteria tree or just its root node (as the review editor sends it),
    and the editor's `sourceSpan.section` spelling of `sectionKey`."""

    def fix(node: dict) -> dict:
        node = dict(node)
        span = node.get("sourceSpan")
        if isinstance(span, dict) and "sectionKey" not in span and "section" in span:
            span = {**span, "sectionKey": span["section"]}
            span.pop("section", None)
            node["sourceSpan"] = span
        if isinstance(node.get("children"), list):
            node["children"] = [fix(c) for c in node["children"]]
        return node

    if "root" in tree:
        return {**tree, "root": fix(tree["root"])}
    return {**(existing or {}), "root": fix(tree)}


def _count_leaves(node: dict) -> int:
    if not node:
        return 0
    if node.get("type") == "criterion":
        return 1
    return sum(_count_leaves(c) for c in node.get("children", []))


@router.get("")
async def list_criteria_sets(
    status: str | None = None,
    q: str | None = None,
    source: str | None = None,
    limit: int = Query(25, ge=1, le=100),
    cursor: int = Query(0, ge=0),
    ctx: RequestContext = Depends(require_perm("criteria:review")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    stmt = select(CriteriaSet)
    if status:
        stmt = stmt.where(CriteriaSet.status == status)
    if source:
        stmt = stmt.where(CriteriaSet.source == source)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(CriteriaSet.policy_key.ilike(like), CriteriaSet.title.ilike(like)))
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (
        (await db.execute(stmt.order_by(CriteriaSet.created_at.desc()).offset(cursor).limit(limit)))
        .scalars()
        .all()
    )
    nxt = cursor + limit if cursor + limit < total else None
    people = await _people(db, list(rows))
    return {
        "items": [criteria_set_api(r, people=people) for r in rows],
        "nextCursor": str(nxt) if nxt is not None else None,
        "total": total,
    }


@router.get("/curated")
async def curated_catalog(ctx: RequestContext = Depends(require_perm("criteria:review"))) -> list[dict]:
    return [
        {
            "policyKey": k,
            "title": t.title,
            "scope": t.scope,
            "services": t.services,
            "synthetic": t.synthetic,
            "criteriaCount": len(t.leaves()),
        }
        for k, t in load_curated().items()
    ]


async def _get(db: AsyncSession, set_id: uuid.UUID) -> CriteriaSet:
    cs = await db.get(CriteriaSet, set_id)
    if cs is None:
        raise not_found("Criteria set")
    return cs


@router.get("/{set_id}")
async def get_criteria_set(
    set_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("criteria:review")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    cs = await _get(db, set_id)
    return criteria_set_api(cs, full=True, people=await _people(db, [cs]))


@router.patch("/{set_id}")
async def update_criteria_set(
    set_id: uuid.UUID,
    body: CriteriaPatch,
    ctx: RequestContext = Depends(require_perm("criteria:review")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.services.audit import audit

    cs = await _get(db, set_id)
    if body.tree is not None:
        try:
            tree = CriteriaTree.model_validate(
                {**_normalize_tree_input(body.tree, cs.tree), "policyKey": cs.policy_key}
            )
        except ValidationError as exc:
            raise bad_request(
                "invalid_tree",
                "Criteria tree failed validation.",
                errors=[{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()[:20]],
            ) from exc
        _vid, sections = await sections_from_db(db, cs.policy_key)
        sections = sections or tree.sections or {}
        if sections:
            report = ground_tree(tree, sections)
            tree = apply_grounding(tree, report)
            cs.grounding_pass_rate = round(report.pass_rate, 4)
            cs.grounding = {
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
        cs.tree = tree.model_dump(by_alias=True, exclude_none=True)
        cs.source = "manual" if cs.source == "llm" else cs.source
    if body.notes is not None:
        cs.notes = body.notes
    if body.status is not None:
        if body.status == "approved":
            if (cs.grounding_pass_rate is not None and cs.grounding_pass_rate < 1.0) and not body.force:
                raise bad_request(
                    "grounding_failed",
                    "Some criteria quotes are not verbatim in the policy text. Fix them or approve with force.",  # noqa: E501
                )
            await _supersede(db, cs.policy_key)
        cs.status = body.status
        cs.reviewed_by, cs.reviewed_at = ctx.user.id, utcnow()
    await db.flush()
    await audit(
        db,
        ctx,
        action="criteria.update",
        resource_type="criteria_set",
        resource_id=cs.id,
        metadata={"status": cs.status, "policyKey": cs.policy_key, "force": body.force},
    )
    return criteria_set_api(cs, full=True, people=await _people(db, [cs]))


@router.post("/compile", status_code=202)
async def compile_criteria(
    body: CompileIn,
    ctx: RequestContext = Depends(require_perm("knowledge:admin")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.services.audit import audit
    from app.services.jobs import enqueue, job_to_dict

    params = {
        "policyVersionIds": body.policy_version_ids or [],
        "sourceKeys": body.source_keys or [],
        "syncCurated": body.sync_curated or not (body.policy_version_ids or body.source_keys),
    }
    job = await enqueue(db, "criteria.compile", params, org_id=ctx.org_id, created_by=ctx.user.id)
    await audit(
        db,
        ctx,
        action="criteria.compile",
        resource_type="job",
        resource_id=job.id,
        metadata={"count": len(params["policyVersionIds"]) + len(params["sourceKeys"])},
    )
    return job_to_dict(job)
