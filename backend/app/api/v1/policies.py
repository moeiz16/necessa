"""Coverage policy library: hybrid search, detail, versions, diffs, codes, compiled criteria."""

from __future__ import annotations

import base64
import uuid
from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.retrieval.retriever import get_retriever
from app.ai.retrieval.types import PolicyFilters, RetrievalQuery
from app.ai.sql.tools import section_diff
from app.ai.vectorstore import get_vectorstore
from app.core.cache import TTLCache, org_cache
from app.core.deps import RequestContext, get_db, require_perm
from app.core.errors import bad_request, not_found
from app.db.models.knowledge import (
    Contractor,
    Policy,
    PolicyChunk,
    PolicyCode,
    PolicyContractor,
    PolicyLink,
    PolicySection,
    PolicyState,
    PolicyVersion,
)
from app.schemas.base import Page
from app.schemas.knowledge import (
    ContractorRef,
    LinkedDoc,
    PolicyCodeOut,
    PolicyDetail,
    PolicyDiff,
    PolicySummary,
    PolicyVersionDetail,
    PolicyVersionSummary,
)
from app.schemas.knowledge import (
    PolicySection as PolicySectionOut,
)

router = APIRouter(tags=["knowledge"])
# Offset pagination: deep pages scan and discard every preceding row; nobody pages 10k rows deep in the UI.
_MAX_OFFSET = 10_000


def _cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(str(offset).encode()).decode().rstrip("=")


def _offset(cursor: str | None) -> int:
    if not cursor:
        return 0
    try:
        off = int(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode())
    except Exception as exc:
        raise bad_request("invalid_cursor", "Malformed pagination cursor.") from exc
    if not 0 <= off <= _MAX_OFFSET:
        raise bad_request("invalid_cursor", "Malformed pagination cursor.")
    return off


def _tenant(ctx: RequestContext):
    return or_(Policy.org_id.is_(None), Policy.org_id == ctx.org_id)


async def _get_policy(db: AsyncSession, ctx: RequestContext, policy_ref: str) -> Policy:
    try:
        pid = uuid.UUID(policy_ref)
        pol = await db.get(Policy, pid)
    except ValueError:
        pol = (
            (await db.execute(select(Policy).where(Policy.source_key == policy_ref.upper())))
            .scalars()
            .first()
        )
    if pol is None or (pol.org_id is not None and pol.org_id != ctx.org_id):
        raise not_found("Policy")
    return pol


async def _summaries(db: AsyncSession, policies: list[Policy]) -> list[PolicySummary]:
    vids = [p.current_version_id for p in policies if p.current_version_id]
    versions = (
        {
            v.id: v
            for v in (await db.execute(select(PolicyVersion).where(PolicyVersion.id.in_(vids)))).scalars()
        }
        if vids
        else {}
    )
    states: dict[uuid.UUID, set[str]] = defaultdict(set)
    contractors: dict[uuid.UUID, dict[int, str]] = defaultdict(dict)
    counts: dict[uuid.UUID, int] = {}
    crit: set[str] = set()
    if vids:
        for vid, ab in (
            await db.execute(
                select(PolicyState.policy_version_id, PolicyState.state_abbrev).where(
                    PolicyState.policy_version_id.in_(vids)
                )
            )
        ).all():
            states[vid].add(ab)
        for vid, cid, name in (
            await db.execute(
                select(PolicyContractor.policy_version_id, Contractor.id, Contractor.name)
                .join(
                    Contractor,
                    and_(
                        Contractor.id == PolicyContractor.contractor_id,
                        Contractor.type_id == PolicyContractor.contractor_type_id,
                    ),
                )
                .where(PolicyContractor.policy_version_id.in_(vids))
            )
        ).all():
            contractors[vid][cid] = name
        for vid, n in (
            await db.execute(
                select(PolicyCode.policy_version_id, func.count())
                .where(PolicyCode.policy_version_id.in_(vids))
                .group_by(PolicyCode.policy_version_id)
            )
        ).all():
            counts[vid] = n
        try:
            from app.db.models.criteria import CriteriaSet

            crit = {
                str(v)
                for v in (
                    await db.execute(
                        select(CriteriaSet.policy_version_id).where(
                            CriteriaSet.policy_version_id.in_(vids),
                            CriteriaSet.status == "approved",
                        )
                    )
                ).scalars()
            }
        except Exception:
            crit = set()
    out = []
    for p in policies:
        v = versions.get(p.current_version_id) if p.current_version_id else None
        vid = v.id if v else None
        out.append(
            PolicySummary(
                id=str(p.id),
                source_key=p.source_key,
                title=p.title,
                doc_type=p.doc_type,
                status=p.status,
                version=v.version if v else None,
                effective_from=v.effective_from if v else None,
                effective_to=v.effective_to if v else None,
                contractors=[
                    ContractorRef(id=i, name=n) for i, n in list(contractors.get(vid, {}).items())[:6]
                ]
                if vid
                else [],
                states=sorted(states.get(vid, set())) if vid else [],
                code_count=counts.get(vid, 0) if vid else 0,
                has_criteria=str(vid) in crit,
                url=p.url,
            )
        )
    return out


# Library search runs the full hybrid retriever (embedding + vector search + rerank), by far the most
# expensive read in the app. Users re-run the same search constantly (back/forward, filters, paging the
# detail view), so the ranked policy hits are cached briefly per org. The key includes the active index
# collection and the knowledge-write generation, so a re-index or payer upload never serves results from
# before it; summaries (criteria status, code counts) are still hydrated from the database every time.
_LIBRARY_HITS = TTLCache(maxsize=512, ttl_s=120.0)


async def _library_hits(
    ctx: RequestContext,
    q: str,
    as_of: date | None,
    state: str | None,
    doc_type: str | None,
    contractor_id: int | None,
    limit: int,
) -> dict[str, tuple[float, str]]:
    top_k = min(30, limit * 2)
    try:
        index = await (await get_vectorstore()).current_physical("policy_chunks")
    except Exception:
        index = None
    key = (
        ctx.org_id,
        index,
        org_cache.knowledge_generation,  # bumped by any committed knowledge write (e.g. a payer upload)
        " ".join(q.split()),
        as_of,
        state,
        doc_type,
        contractor_id,
        top_k,
    )
    cached = _LIBRARY_HITS.get(key) if index else None
    if cached is not None:
        return cached
    res = await get_retriever().search(
        RetrievalQuery(
            text=q,
            org_id=ctx.org_id,
            top_k=top_k,
            strategy=None,
            filters=PolicyFilters(
                as_of=as_of,
                states=[state] if state else None,
                doc_types=[doc_type] if doc_type else None,
                contractor_ids=[contractor_id] if contractor_id else None,
            ),
        )
    )
    best: dict[str, tuple[float, str]] = {}
    for c in res.chunks:
        pid = c.source.get("policy_id")
        if pid and (pid not in best or c.score > best[pid][0]):
            best[pid] = (c.score, c.text[:280])
    if index and not res.route.degraded:
        _LIBRARY_HITS.set(key, best)
    return best


@router.get("/policies", response_model=Page[PolicySummary])
async def list_policies(
    ctx: RequestContext = Depends(require_perm("policies:read")),
    db: AsyncSession = Depends(get_db),
    q: str | None = Query(None, max_length=500),
    doc_type: str | None = Query(None, alias="docType"),
    state: str | None = Query(None, max_length=2),
    contractor_id: int | None = Query(None, alias="contractorId"),
    code: str | None = Query(None, max_length=16),
    status: str | None = Query(None),
    as_of: date | None = Query(None, alias="asOf"),
    limit: int = Query(25, ge=1, le=100),
    cursor: str | None = None,
):
    if q and q.strip():
        best = await _library_hits(ctx, q, as_of, state, doc_type, contractor_id, limit)
        if not best:
            return Page[PolicySummary](items=[], next_cursor=None, total=0)
        pols = list(
            (
                await db.execute(
                    select(Policy).where(Policy.id.in_([uuid.UUID(p) for p in best]), _tenant(ctx))
                )
            ).scalars()
        )
        items = await _summaries(db, pols)
        for it in items:
            it.score, it.snippet = round(best[it.id][0], 4), best[it.id][1]
        items.sort(key=lambda s: -(s.score or 0))
        return Page[PolicySummary](items=items[:limit], next_cursor=None, total=len(items))

    stmt = select(Policy).where(_tenant(ctx))
    if doc_type:
        stmt = stmt.where(Policy.doc_type == doc_type)
    if status:
        stmt = stmt.where(Policy.status == status)
    if state:
        stmt = stmt.where(
            Policy.current_version_id.in_(
                select(PolicyState.policy_version_id).where(
                    PolicyState.state_abbrev.in_([state.upper(), "US"])
                )
            )
        )
    if contractor_id:
        stmt = stmt.where(
            Policy.current_version_id.in_(
                select(PolicyContractor.policy_version_id).where(
                    PolicyContractor.contractor_id == contractor_id
                )
            )
        )
    if code:
        stmt = stmt.where(
            Policy.current_version_id.in_(
                select(PolicyCode.policy_version_id).where(PolicyCode.code == code.upper())
            )
        )
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    off = _offset(cursor)
    pols = list(
        (await db.execute(stmt.order_by(Policy.doc_type, Policy.title).offset(off).limit(limit))).scalars()
    )
    items = await _summaries(db, pols)
    nxt = _cursor(off + limit) if off + limit < total else None
    return Page[PolicySummary](items=items, next_cursor=nxt, total=total)


@router.get("/policies/{policy_ref}", response_model=PolicyDetail)
async def get_policy(
    policy_ref: str,
    ctx: RequestContext = Depends(require_perm("policies:read")),
    db: AsyncSession = Depends(get_db),
):
    pol = await _get_policy(db, ctx, policy_ref)
    summary = (await _summaries(db, [pol]))[0]
    versions = list(
        (
            await db.execute(
                select(PolicyVersion)
                .where(PolicyVersion.policy_id == pol.id)
                .order_by(PolicyVersion.version.desc())
            )
        ).scalars()
    )
    cur = next((v for v in versions if v.id == pol.current_version_id), versions[0] if versions else None)
    sections: list[PolicySectionOut] = []
    code_counts: dict[str, int] = {}
    linked: list[LinkedDoc] = []
    if cur:
        sections = [
            PolicySectionOut(
                id=str(s.id), section_key=s.section_key, title=s.title, text=s.text, ordinal=s.ordinal
            )
            for s in (
                await db.execute(
                    select(PolicySection)
                    .where(PolicySection.policy_version_id == cur.id)
                    .order_by(PolicySection.ordinal)
                )
            ).scalars()
        ]
        code_counts = {
            sys_: n
            for sys_, n in (
                await db.execute(
                    select(PolicyCode.code_system, func.count())
                    .where(PolicyCode.policy_version_id == cur.id)
                    .group_by(PolicyCode.code_system)
                )
            ).all()
        }
        links = list(
            (await db.execute(select(PolicyLink).where(PolicyLink.from_version_id == cur.id))).scalars()
        )
        # inbound links (e.g. articles pointing to this LCD)
        inbound = (
            await db.execute(
                select(PolicyLink, Policy)
                .join(PolicyVersion, PolicyVersion.id == PolicyLink.from_version_id)
                .join(Policy, Policy.id == PolicyVersion.policy_id)
                .where(
                    PolicyLink.to_source_key == pol.source_key, Policy.current_version_id == PolicyVersion.id
                )
            )
        ).all()
        keys = {ln.to_source_key for ln in links}
        targets = (
            {
                p.source_key: p
                for p in (await db.execute(select(Policy).where(Policy.source_key.in_(list(keys))))).scalars()
            }
            if keys
            else {}
        )
        seen = set()
        for ln in links:
            t = targets.get(ln.to_source_key)
            if ln.to_source_key in seen:
                continue
            seen.add(ln.to_source_key)
            linked.append(
                LinkedDoc(
                    source_key=ln.to_source_key,
                    title=t.title if t else None,
                    doc_type=t.doc_type if t else None,
                    relation=ln.relation,
                    policy_id=str(t.id) if t else None,
                )
            )
        for ln, p in inbound:
            if p.source_key in seen:
                continue
            seen.add(p.source_key)
            linked.append(
                LinkedDoc(
                    source_key=p.source_key,
                    title=p.title,
                    doc_type=p.doc_type,
                    relation=f"inbound:{ln.relation}",
                    policy_id=str(p.id),
                )
            )

    def vs(v: PolicyVersion) -> PolicyVersionSummary:
        return PolicyVersionSummary(
            id=str(v.id),
            version=v.version,
            effective_from=v.effective_from,
            effective_to=v.effective_to,
            retired_at=v.retired_at,
            last_updated=v.last_updated,
            is_current=v.id == pol.current_version_id,
        )

    return PolicyDetail(
        **summary.model_dump(),
        keywords=pol.keywords,
        current_version=vs(cur) if cur else None,
        sections=sections,
        linked=linked,
        versions=[vs(v) for v in versions],
        code_counts=code_counts,
        raw=(cur.raw if cur else {}) or {},
        synthetic=bool((cur.raw or {}).get("synthetic")) if cur else False,
    )


@router.get("/policies/{policy_ref}/versions/{version_id}", response_model=PolicyVersionDetail)
async def get_policy_version(
    policy_ref: str,
    version_id: str,
    ctx: RequestContext = Depends(require_perm("policies:read")),
    db: AsyncSession = Depends(get_db),
):
    pol = await _get_policy(db, ctx, policy_ref)
    try:
        v = await db.get(PolicyVersion, uuid.UUID(version_id))
    except ValueError:
        v = (
            (
                await db.execute(
                    select(PolicyVersion).where(
                        PolicyVersion.policy_id == pol.id,
                        PolicyVersion.version == int(version_id.lstrip("v")),
                    )
                )
            )
            .scalars()
            .first()
            if version_id.lstrip("v").isdigit()
            else None
        )
    if v is None or v.policy_id != pol.id:
        raise not_found("Policy version")
    secs = [
        PolicySectionOut(
            id=str(s.id), section_key=s.section_key, title=s.title, text=s.text, ordinal=s.ordinal
        )
        for s in (
            await db.execute(
                select(PolicySection)
                .where(PolicySection.policy_version_id == v.id)
                .order_by(PolicySection.ordinal)
            )
        ).scalars()
    ]
    return PolicyVersionDetail(
        id=str(v.id),
        policy_id=str(pol.id),
        version=v.version,
        effective_from=v.effective_from,
        effective_to=v.effective_to,
        retired_at=v.retired_at,
        last_updated=v.last_updated,
        is_current=v.id == pol.current_version_id,
        sections=secs,
    )


@router.get("/policies/{policy_ref}/diff", response_model=PolicyDiff)
async def diff_policy(
    policy_ref: str,
    from_version: int = Query(..., alias="from"),
    to_version: int = Query(..., alias="to"),
    ctx: RequestContext = Depends(require_perm("policies:read")),
    db: AsyncSession = Depends(get_db),
):
    pol = await _get_policy(db, ctx, policy_ref)
    sections = await section_diff(db, pol.id, from_version, to_version)
    if not sections:
        raise not_found("One or both policy versions")
    return PolicyDiff(
        policy_id=str(pol.id), from_version=from_version, to_version=to_version, sections=sections
    )


@router.get("/policies/{policy_ref}/codes", response_model=Page[PolicyCodeOut])
async def policy_codes(
    policy_ref: str,
    system: str | None = Query(None),
    group: int | None = Query(None),
    q: str | None = Query(None, max_length=64),
    limit: int = Query(100, ge=1, le=500),
    cursor: str | None = None,
    ctx: RequestContext = Depends(require_perm("policies:read")),
    db: AsyncSession = Depends(get_db),
):
    pol = await _get_policy(db, ctx, policy_ref)
    stmt = select(PolicyCode).where(PolicyCode.policy_version_id == pol.current_version_id)
    if system:
        stmt = stmt.where(PolicyCode.code_system == system.upper())
    if group is not None:
        stmt = stmt.where(PolicyCode.group_no == group)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(
            or_(func.lower(PolicyCode.code).like(like), func.lower(PolicyCode.description).like(like))
        )
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    off = _offset(cursor)
    rows = (
        await db.execute(
            stmt.order_by(PolicyCode.code_system, PolicyCode.group_no, PolicyCode.code)
            .offset(off)
            .limit(limit)
        )
    ).scalars()
    items = [
        PolicyCodeOut(
            code_system=r.code_system,
            code=r.code,
            group_no=r.group_no,
            description=r.description,
            is_range=r.is_range,
        )
        for r in rows
    ]
    return Page[PolicyCodeOut](
        items=items, next_cursor=_cursor(off + limit) if off + limit < total else None, total=total
    )


@router.get("/policies/{policy_ref}/chunks")
async def policy_chunks(
    policy_ref: str,
    ctx: RequestContext = Depends(require_perm("policies:read")),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(50, ge=1, le=200),
):
    """Chunk inspector for the knowledge-ops UI (how a policy was split for retrieval)."""
    pol = await _get_policy(db, ctx, policy_ref)
    rows = (
        await db.execute(
            select(PolicyChunk, PolicySection.section_key)
            .join(PolicySection, PolicySection.id == PolicyChunk.section_id, isouter=True)
            .where(PolicyChunk.policy_version_id == pol.current_version_id)
            .order_by(PolicySection.ordinal, PolicyChunk.ordinal)
            .limit(limit)
        )
    ).all()
    return {
        "items": [
            {
                "id": str(c.id),
                "level": c.level,
                "parentId": str(c.parent_id) if c.parent_id else None,
                "sectionKey": sk,
                "ordinal": c.ordinal,
                "tokens": c.token_estimate,
                "header": c.header,
                "text": c.text,
                "indexedAt": c.indexed_at,
                "embedModel": c.embed_model,
            }
            for c, sk in rows
        ]
    }


@router.get("/policies/{policy_ref}/criteria")
async def policy_criteria(
    policy_ref: str,
    ctx: RequestContext = Depends(require_perm("policies:read")),
    db: AsyncSession = Depends(get_db),
):
    pol = await _get_policy(db, ctx, policy_ref)
    try:
        from app.db.models.criteria import CriteriaSet
    except Exception as exc:  # pragma: no cover
        raise not_found("Criteria set") from exc
    rank = {"approved": 0, "needs_review": 1, "draft": 2, "rejected": 3, "superseded": 4}
    rows = list(
        (
            await db.execute(
                select(CriteriaSet).where(CriteriaSet.policy_version_id == pol.current_version_id)
            )
        ).scalars()
    )
    if not rows:
        raise not_found("Criteria set")
    cs = sorted(
        rows, key=lambda r: (rank.get(r.status, 9), -(r.created_at.timestamp() if r.created_at else 0))
    )[0]
    return {
        "id": str(cs.id),
        "policyVersionId": str(cs.policy_version_id),
        "status": cs.status,
        "sourceKey": cs.policy_key,
        "policyTitle": cs.title,
        "version": cs.policy_version,
        "notes": cs.notes,
        "tree": cs.tree,
        "extractorModel": cs.extractor_model,
        "verifierModel": cs.verifier_model,
        "agreement": cs.agreement,
        "groundingPassRate": cs.grounding_pass_rate,
        "reviewedAt": cs.reviewed_at,
        "createdAt": cs.created_at,
    }
