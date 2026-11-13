"""Code explorer: HCPCS/CPT/ICD-10 lookup, linked policies, coverage graph."""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.graph.coverage_graph import coverage_paths
from app.ai.sql.tools import _norm_icd, find_policies_by_code, search_codes
from app.core.deps import RequestContext, get_db, require_perm
from app.core.errors import not_found
from app.db.models.knowledge import Code
from app.schemas.knowledge import CodeDetail, CodeOut, CoverageGraph

router = APIRouter(tags=["knowledge"])


@router.get("/codes/search", response_model=list[CodeOut])
async def codes_search(
    q: str = Query(..., min_length=1, max_length=120),
    system: str | None = Query(None),
    limit: int = Query(20, ge=1, le=50),
    ctx: RequestContext = Depends(require_perm("policies:read")),
    db: AsyncSession = Depends(get_db),
):
    rows = await search_codes(db, q, system, limit)
    return [
        CodeOut(system=r["system"], code=r["code"], short_desc=r["shortDesc"], long_desc=r["longDesc"])
        for r in rows
    ]


@router.get("/codes/{system}/{code}", response_model=CodeDetail)
async def code_detail(
    system: str,
    code: str,
    state: str | None = Query(None, max_length=2),
    as_of: date | None = Query(None, alias="asOf"),
    ctx: RequestContext = Depends(require_perm("policies:read")),
    db: AsyncSession = Depends(get_db),
):
    sys_u = system.upper()
    c = code.upper() if sys_u != "ICD10CM" else _norm_icd(code)
    row = (
        (await db.execute(select(Code).where(Code.code_system == sys_u, or_(Code.code == c))))
        .scalars()
        .first()
    )
    policies = await find_policies_by_code(db, c, state, as_of, limit=40)
    if row is None and not policies:
        raise not_found("Code")
    return CodeDetail(
        system=sys_u,
        code=c,
        short_desc=row.short_desc if row else None,
        long_desc=row.long_desc if row else None,
        policies=policies,
    )


@router.get("/codes/{system}/{code}/graph", response_model=CoverageGraph)
async def code_graph(
    system: str,
    code: str,
    state: str | None = Query(None, max_length=2),
    as_of: date | None = Query(None, alias="asOf"),
    hops: int = Query(3, ge=1, le=4),
    ctx: RequestContext = Depends(require_perm("policies:read")),
    db: AsyncSession = Depends(get_db),
):
    c = _norm_icd(code) if system.upper() == "ICD10CM" else code.upper()
    return await coverage_paths(db, c, state, as_of, max_hops=hops)
