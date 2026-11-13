"""Deterministic knowledge tools (strategy S2 and the case agent's policy resolution).

These are parameterized, tested SQL — the first rung of the "tools before text-to-SQL" ladder.
"""

from __future__ import annotations

import difflib
import re
import uuid
from collections import defaultdict
from datetime import date
from typing import Literal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.knowledge import (
    Contractor,
    Policy,
    PolicyCode,
    PolicyContractor,
    PolicyLink,
    PolicySection,
    PolicyState,
    PolicyVersion,
)
from app.schemas.knowledge import ContractorRef, MatchReason, PolicyMatchDTO

DOC_WEIGHT = {"LCD": 0.12, "NCD": 0.1, "Payer Policy": 0.12, "Billing and Coding": 0.06, "Article": 0.04}


def _norm_icd(code: str) -> str:
    c = code.strip().upper().replace(".", "")
    return c if len(c) <= 3 else f"{c[:3]}.{c[3:]}"


def _effective(v: PolicyVersion, dos: date) -> bool:
    if v.effective_from and v.effective_from > dos:
        return False
    if v.effective_to and v.effective_to < dos:
        return False
    return not (v.retired_at and v.retired_at <= dos)


async def _criteria_status(db: AsyncSession, version_ids: list[uuid.UUID]) -> dict[str, str]:
    if not version_ids:
        return {}
    try:
        from app.db.models.criteria import CriteriaSet

        rows = (
            await db.execute(
                select(CriteriaSet.policy_version_id, CriteriaSet.status).where(
                    CriteriaSet.policy_version_id.in_(version_ids)
                )
            )
        ).all()
        out: dict[str, str] = {}
        rank = {"approved": 4, "needs_review": 3, "draft": 2, "rejected": 1, "superseded": 0}
        for vid, st in rows:
            k = str(vid)
            if rank.get(st, 0) >= rank.get(out.get(k, ""), -1):
                out[k] = st
        return out
    except Exception:
        return {}


async def _contractor_for(
    db: AsyncSession, version_ids: list[uuid.UUID], state: str | None
) -> dict[uuid.UUID, ContractorRef]:
    if not version_ids:
        return {}
    rows = (
        await db.execute(
            select(PolicyContractor.policy_version_id, Contractor.id, Contractor.name)
            .join(
                Contractor,
                and_(
                    Contractor.id == PolicyContractor.contractor_id,
                    Contractor.type_id == PolicyContractor.contractor_type_id,
                ),
            )
            .where(PolicyContractor.policy_version_id.in_(version_ids))
        )
    ).all()
    out: dict[uuid.UUID, ContractorRef] = {}
    for vid, cid, name in rows:
        out.setdefault(vid, ContractorRef(id=cid, name=name))
    return out


DxStatus = Literal["covered", "noncovered", "unlisted", "no_list"]


async def covered_dx_for_policy(
    db: AsyncSession, policy_version_id: str | uuid.UUID, dx_codes: list[str]
) -> dict[str, DxStatus]:
    vid = uuid.UUID(str(policy_version_id))
    return (await covered_dx_for_policies(db, [vid], dx_codes)).get(vid, {})


async def covered_dx_for_policies(
    db: AsyncSession, version_ids: list[uuid.UUID], dx_codes: list[str]
) -> dict[uuid.UUID, dict[str, DxStatus]]:
    """`covered_dx_for_policy` for many policy versions in ONE query."""
    wanted = {_norm_icd(c) for c in dx_codes if c}
    if not wanted or not version_ids:
        return {}
    by_vid: dict[uuid.UUID, list[tuple[str, str]]] = defaultdict(list)
    for vid, system, code in (
        await db.execute(
            select(PolicyCode.policy_version_id, PolicyCode.code_system, PolicyCode.code).where(
                PolicyCode.policy_version_id.in_(list(dict.fromkeys(version_ids))),
                PolicyCode.code_system.in_(["ICD10_COVERED", "ICD10_NONCOVERED"]),
            )
        )
    ).all():
        by_vid[vid].append((system, code))
    return {vid: _dx_status(wanted, by_vid.get(vid, [])) for vid in version_ids}


def _dx_status(wanted: set[str], rows: list[tuple[str, str]]) -> dict[str, DxStatus]:
    if not rows:
        return dict.fromkeys(wanted, "no_list")
    covered = {_norm_icd(c) for s, c in rows if s == "ICD10_COVERED"}
    non = {_norm_icd(c) for s, c in rows if s == "ICD10_NONCOVERED"}
    out: dict[str, DxStatus] = {}
    for c in wanted:
        if c in covered:
            out[c] = "covered"
        elif c in non:
            out[c] = "noncovered"
        else:
            # category-level match (e.g. M23.2 family) counts as listed when the policy lists a prefix
            out[c] = (
                "covered"
                if any(x.startswith(c) or c.startswith(x) for x in covered if len(x) >= 5)
                else ("noncovered" if any(c.startswith(x) for x in non if len(x) >= 5) else "unlisted")
            )
    return out


async def resolve_policies(
    db: AsyncSession,
    *,
    service_codes: list[str],
    dx_codes: list[str],
    state: str | None,
    payer_type: str,
    date_of_service: date,
    limit: int = 8,
) -> list[PolicyMatchDTO]:
    """Deterministic policy resolution.

    service code → listing articles/LCDs/payer policies → linked LCDs/NCDs,
    filtered by jurisdiction (state) and the date of service, scored by evidence of applicability."""
    codes = [c.strip().upper() for c in service_codes if c and c.strip()]
    if not codes:
        return []
    is_medicare = payer_type in {"medicare_ffs", "medicare_advantage"}
    st = (state or "").upper() or None

    code_rows = (
        await db.execute(
            select(PolicyCode.policy_version_id, PolicyCode.code).where(
                PolicyCode.code_system == "HCPCS", PolicyCode.code.in_(codes)
            )
        )
    ).all()
    by_version: dict[uuid.UUID, set[str]] = defaultdict(set)
    for vid, code in code_rows:
        by_version[vid].add(code)
    if not by_version:
        return []
    versions = {
        v.id: v
        for v in (
            await db.execute(select(PolicyVersion).where(PolicyVersion.id.in_(list(by_version))))
        ).scalars()
    }
    policies = {
        p.id: p
        for p in (
            await db.execute(select(Policy).where(Policy.id.in_([v.policy_id for v in versions.values()])))
        ).scalars()
    }

    # pick, per policy, the version effective on the date of service (fallback: current version)
    cand: dict[uuid.UUID, PolicyVersion] = {}
    for v in versions.values():
        pol = policies.get(v.policy_id)
        if pol is None:
            continue
        if is_medicare and pol.source == "payer":
            continue  # commercial payer policies never govern Medicare claims
        prev = cand.get(v.policy_id)
        eff_v, eff_prev = (
            _effective(v, date_of_service),
            prev is not None and _effective(prev, date_of_service),
        )
        if prev is None or (eff_v and not eff_prev) or (eff_v == eff_prev and v.version > prev.version):
            cand[v.policy_id] = v

    # follow article → LCD links and LCD/article → NCD links
    linked: dict[str, tuple[str, str]] = {}  # to_source_key -> (relation, via_source_key)
    if cand:
        for ln in (
            await db.execute(
                select(PolicyLink).where(
                    PolicyLink.from_version_id.in_([v.id for v in cand.values()]),
                    PolicyLink.relation.in_(["article_lcd", "lcd_article", "lcd_ncd", "article_ncd"]),
                )
            )
        ).scalars():
            src = (
                policies[versions[ln.from_version_id].policy_id].source_key
                if ln.from_version_id in versions
                else ""
            )
            if ln.relation in {"article_lcd", "lcd_ncd", "article_ncd"}:
                linked.setdefault(ln.to_source_key, (ln.relation, src))
    if linked:
        extra = list((await db.execute(select(Policy).where(Policy.source_key.in_(list(linked))))).scalars())
        want = [p.current_version_id for p in extra if p.id not in cand and p.current_version_id]
        # linked policies' current versions in ONE query (was one `db.get` per linked policy: N+1)
        extra_versions = (
            {
                v.id: v
                for v in (
                    await db.execute(select(PolicyVersion).where(PolicyVersion.id.in_(want)))
                ).scalars()
            }
            if want
            else {}
        )
        for p in extra:
            policies[p.id] = p
            if p.id in cand or not p.current_version_id:
                continue
            v = extra_versions.get(p.current_version_id)
            if v is not None:
                versions[v.id] = v
                cand[p.id] = v

    vids = [v.id for v in cand.values()]
    states: dict[uuid.UUID, dict[str, bool]] = defaultdict(dict)
    if vids:
        for ps in (
            await db.execute(select(PolicyState).where(PolicyState.policy_version_id.in_(vids)))
        ).scalars():
            states[ps.policy_version_id][ps.state_abbrev] = ps.primary
    contractors = await _contractor_for(db, vids, st)
    crit = await _criteria_status(db, vids)

    def _in_scope(pol: Policy, v: PolicyVersion) -> bool:  # mirrors the jurisdiction/payer skips below
        vs = states.get(v.id, {})
        if "US" not in vs and st and st not in vs:
            return False
        return not (pol.source == "payer" and is_medicare)

    # diagnosis lists for every in-scope candidate in ONE query (was one query per candidate)
    dx_by_version = (
        await covered_dx_for_policies(
            db, [v.id for pid, v in cand.items() if _in_scope(policies[pid], v)], dx_codes
        )
        if dx_codes
        else {}
    )

    out: list[PolicyMatchDTO] = []
    for pid, v in cand.items():
        pol = policies[pid]
        reasons: list[MatchReason] = []
        score = DOC_WEIGHT.get(pol.doc_type, 0.03)
        matched_codes = by_version.get(v.id, set())
        for c in sorted(matched_codes):
            reasons.append(MatchReason(type="hcpcs", value=c, detail=f"{pol.source_key} lists {c}"))
        if matched_codes:
            score += 0.45
        if pol.source_key in linked:
            rel, via = linked[pol.source_key]
            reasons.append(
                MatchReason(type="link", value=via, detail=f"linked from {via} ({rel.replace('_', ' → ')})")
            )
            score += 0.3
        vs = states.get(v.id, {})
        if "US" in vs:
            reasons.append(MatchReason(type="national", value="US", detail="national coverage"))
            score += 0.15
        elif st:
            if st in vs:
                reasons.append(
                    MatchReason(
                        type="state",
                        value=st,
                        detail=f"applies in {st}" + (" (primary jurisdiction)" if vs[st] else ""),
                    )
                )
                score += 0.2
            else:
                continue  # wrong jurisdiction: an LCD from another MAC does not apply
        if pol.source == "payer":
            if is_medicare:
                continue
            reasons.append(
                MatchReason(type="payer", value=pol.keywords or "payer", detail="commercial payer policy")
            )
            score += 0.15
        elif not is_medicare:
            score -= 0.25  # Medicare policy shown only as reference for commercial plans
        dx_status: dict[str, str] = {}
        if dx_codes:
            dx_status = dx_by_version.get(v.id, {})
            cov = [c for c, s in dx_status.items() if s == "covered"]
            bad = [c for c, s in dx_status.items() if s == "noncovered"]
            if cov:
                reasons.append(
                    MatchReason(type="icd10", value=",".join(cov), detail="diagnosis listed as covered")
                )
                score += 0.2
            if bad:
                reasons.append(
                    MatchReason(
                        type="dx_warning",
                        value=",".join(bad),
                        detail="diagnosis listed as NOT supporting medical necessity",
                    )
                )
                score -= 0.1
            if dx_status and all(s == "unlisted" for s in dx_status.values()):
                reasons.append(
                    MatchReason(
                        type="dx_warning",
                        value=",".join(dx_status),
                        detail="diagnosis not on the policy's covered list",
                    )
                )
                score -= 0.05
        if not _effective(v, date_of_service):
            score -= 0.2
        out.append(
            PolicyMatchDTO(
                policy_id=str(pol.id),
                policy_version_id=str(v.id),
                source_key=pol.source_key,
                title=pol.title,
                doc_type=pol.doc_type,
                version=v.version,
                effective_from=v.effective_from,
                effective_to=v.effective_to,
                match_reasons=reasons,
                score=round(max(0.0, min(1.0, score)), 3),
                contractor=contractors.get(v.id),
                criteria_set_status=crit.get(str(v.id)),
                url=pol.url,
                dx_status=dx_status,
            )
        )
    out.sort(key=lambda m: (-m.score, m.doc_type != "LCD"))
    return out[:limit]


async def find_policies_by_code(
    db: AsyncSession, code: str, state: str | None = None, as_of: date | None = None, limit: int = 25
) -> list[dict]:
    code = code.strip().upper()
    if re.match(r"^[A-Z]\d{2}(\.\w+)?$", code) and not re.match(r"^[A-Z]\d{4}$", code):
        systems = ["ICD10_COVERED", "ICD10_NONCOVERED"]
        code = _norm_icd(code)
    else:
        systems = ["HCPCS"]
    q = (
        select(
            Policy.id,
            Policy.source_key,
            Policy.title,
            Policy.doc_type,
            PolicyVersion.id,
            PolicyVersion.version,
            PolicyVersion.effective_from,
            PolicyVersion.effective_to,
            PolicyCode.code_system,
        )
        .join(PolicyVersion, PolicyVersion.id == PolicyCode.policy_version_id)
        .join(Policy, Policy.id == PolicyVersion.policy_id)
        .where(PolicyCode.code == code, PolicyCode.code_system.in_(systems))
        .distinct()
        .limit(limit * 3)
    )
    rows = (await db.execute(q)).all()
    # states for every candidate version in ONE query (was one query per row: N+1)
    state_map: dict[uuid.UUID, set[str]] = defaultdict(set)
    cand_vids = {r[4] for r in rows}
    if cand_vids:
        for vid_, ab in (
            await db.execute(
                select(PolicyState.policy_version_id, PolicyState.state_abbrev).where(
                    PolicyState.policy_version_id.in_(list(cand_vids))
                )
            )
        ).all():
            state_map[vid_].add(ab)
    out = []
    seen = set()
    for pid, key, title, dtype, vid, ver, eff, end, system in rows:
        if key in seen:
            continue
        if as_of and ((eff and eff > as_of) or (end and end < as_of)):
            continue
        states = sorted(state_map.get(vid, set()))
        if state and state.upper() not in states and "US" not in states:
            continue
        seen.add(key)
        out.append(
            {
                "policyId": str(pid),
                "sourceKey": key,
                "title": title,
                "docType": dtype,
                "version": ver,
                "policyVersionId": str(vid),
                "effectiveFrom": eff.isoformat() if eff else None,
                "listedAs": {
                    "HCPCS": "billable code",
                    "ICD10_COVERED": "covered diagnosis",
                    "ICD10_NONCOVERED": "non-covered diagnosis",
                }.get(system, system),
                "states": states[:60],
                "stateCount": len(states),
            }
        )
        if len(out) >= limit:
            break
    return out


async def policy_versions(db: AsyncSession, source_key: str) -> list[dict]:
    pol = (await db.execute(select(Policy).where(Policy.source_key == source_key.upper()))).scalars().first()
    if pol is None:
        return []
    vs = (
        await db.execute(
            select(PolicyVersion)
            .where(PolicyVersion.policy_id == pol.id)
            .order_by(PolicyVersion.version.desc())
        )
    ).scalars()
    return [
        {
            "id": str(v.id),
            "version": v.version,
            "effectiveFrom": v.effective_from.isoformat() if v.effective_from else None,
            "effectiveTo": v.effective_to.isoformat() if v.effective_to else None,
            "isCurrent": v.id == pol.current_version_id,
        }
        for v in vs
    ]


def diff_text(a: str, b: str) -> list[dict]:
    sm = difflib.SequenceMatcher(a=a.split(), b=b.split(), autojunk=False)
    hunks: list[dict] = []
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            hunks.append({"op": "equal", "text": " ".join(a.split()[i1:i2])})
        else:
            if i2 > i1:
                hunks.append({"op": "delete", "text": " ".join(a.split()[i1:i2])})
            if j2 > j1:
                hunks.append({"op": "insert", "text": " ".join(b.split()[j1:j2])})
    return hunks


async def section_diff(
    db: AsyncSession, policy_id: uuid.UUID, from_version: int, to_version: int
) -> list[dict]:
    vs = {
        v.version: v
        for v in (
            await db.execute(
                select(PolicyVersion).where(
                    PolicyVersion.policy_id == policy_id,
                    PolicyVersion.version.in_([from_version, to_version]),
                )
            )
        ).scalars()
    }
    if from_version not in vs or to_version not in vs:
        return []

    async def sections(v: PolicyVersion) -> dict[str, PolicySection]:
        return {
            s.section_key: s
            for s in (
                await db.execute(
                    select(PolicySection)
                    .where(PolicySection.policy_version_id == v.id)
                    .order_by(PolicySection.ordinal)
                )
            ).scalars()
        }

    a, b = await sections(vs[from_version]), await sections(vs[to_version])
    out = []
    for key in list(dict.fromkeys([*a, *b])):
        sa, sb = a.get(key), b.get(key)
        if sa and not sb:
            out.append(
                {
                    "sectionKey": key,
                    "title": sa.title,
                    "status": "removed",
                    "hunks": [{"op": "delete", "text": sa.text}],
                }
            )
        elif sb and not sa:
            out.append(
                {
                    "sectionKey": key,
                    "title": sb.title,
                    "status": "added",
                    "hunks": [{"op": "insert", "text": sb.text}],
                }
            )
        elif sa and sb:
            same = sa.text == sb.text
            out.append(
                {
                    "sectionKey": key,
                    "title": sb.title,
                    "status": "same" if same else "changed",
                    "hunks": [] if same else diff_text(sa.text, sb.text),
                }
            )
    return out


async def search_codes(db: AsyncSession, q: str, system: str | None = None, limit: int = 20) -> list[dict]:
    from app.db.models.knowledge import Code

    term = q.strip()
    if not term:
        return []
    up = term.upper()
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    base = select(Code)
    if system:
        base = base.where(Code.code_system == system.upper())
    exact = (await db.execute(base.where(or_(Code.code == up, Code.code == _norm_icd(up))))).scalars().all()
    prefix = (await db.execute(base.where(Code.code.like(f"{up}%")).limit(limit))).scalars().all()
    words = [w for w in re.findall(r"[A-Za-z]{3,}", term)][:4]
    text_rows: list = []
    if words:
        conds = [
            func.lower(func.coalesce(Code.long_desc, Code.short_desc, "")).like(f"%{w.lower()}%")
            for w in words
        ]
        text_rows = (await db.execute(base.where(and_(*conds)).limit(limit))).scalars().all()
    for c in [*exact, *prefix, *text_rows]:
        k = (c.code_system, c.code)
        if k in seen:
            continue
        seen.add(k)
        out.append(
            {"system": c.code_system, "code": c.code, "shortDesc": c.short_desc, "longDesc": c.long_desc}
        )
        if len(out) >= limit:
            break
    return out
