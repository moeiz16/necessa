"""Ingestion orchestration: parse → persist (incremental, versioned) → chunk → index (blue/green).

Idempotent and incremental: a document whose content hash is unchanged is skipped; a new CMS version
creates a new `policy_versions` row (history is kept for diffs / "as of" questions); a changed
document with the same version number is rebuilt in place.
"""

from __future__ import annotations

import json
import time
import uuid
from collections import defaultdict
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from pathlib import Path

import structlog
from sqlalchemy import delete, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.ingestion.chunker import chunk_section, make_header
from app.ai.ingestion.codesets import collect_codes, find_cdc_file, parse_cdc_order_file, upsert_codes
from app.ai.ingestion.mcd import ContractorRow, MCDReader, ParsedCode, ParsedDoc, ParsedSection, parse_mcd
from app.core.config import get_settings
from app.db.models.knowledge import (
    Contractor,
    ContractorState,
    IngestionRun,
    Policy,
    PolicyChunk,
    PolicyCode,
    PolicyCodeGroup,
    PolicyContractor,
    PolicyLink,
    PolicySection,
    PolicyState,
    PolicyVersion,
    State,
)

log = structlog.get_logger(__name__)
Progress = Callable[[float, str], Awaitable[None]] | None
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


async def _noop(_p: float, _m: str) -> None:
    return None


# ── fixtures ───────────────────────────────────────────────────────────────
def load_fixture_docs() -> list[ParsedDoc]:
    docs = []
    for path in sorted(FIXTURES_DIR.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        eff = date.fromisoformat(raw["effective_from"]) if raw.get("effective_from") else None
        docs.append(
            ParsedDoc(
                source="payer",
                source_key=raw["source_key"],
                cms_id=None,
                version=int(raw.get("version", 1)),
                title=raw["title"],
                doc_type=raw.get("doc_type", "Payer Policy"),
                status="active" if not eff or eff <= date.today() else "future",
                effective_from=eff,
                effective_to=None,
                retired_at=None,
                last_updated=datetime.now(UTC),
                url=raw.get("url"),
                keywords=raw.get("payer"),
                sections=[ParsedSection(s["key"], s["title"], s["text"]) for s in raw["sections"]],
                codes=[
                    ParsedCode(c["system"], c["code"].upper(), int(c.get("group", 0)), c.get("description"))
                    for c in raw.get("codes", [])
                ],
                national=bool(raw.get("national", True)),
                raw={"payer": raw.get("payer"), "synthetic": True},
            )
        )
    return docs


# ── reference tables ───────────────────────────────────────────────────────
async def persist_reference(session: AsyncSession, reader: MCDReader) -> dict:
    states = reader.states()
    await session.execute(delete(State))
    session.add_all([State(id=i, abbrev=a, name=n) for i, (a, n) in states.items()])
    contractors: list[ContractorRow] = reader.contractors()
    await session.execute(delete(Contractor))
    seen = set()
    for c in contractors:
        if (c.id, c.type_id, c.version) in seen:
            continue
        seen.add((c.id, c.type_id, c.version))
        session.add(
            Contractor(
                id=c.id,
                type_id=c.type_id,
                version=c.version,
                name=c.name,
                number=c.number,
                type_label=c.type_label,
                url=c.url,
                dmerc_region=c.dmerc_region,
            )
        )
    await session.execute(delete(ContractorState))
    juris = reader.contractor_jurisdictions()
    if juris:
        await session.execute(insert(ContractorState), juris)
    await session.flush()
    return {"states": len(states), "contractors": len(seen), "jurisdictions": len(juris)}


async def _jurisdiction_map(session: AsyncSession) -> dict[tuple[int, int], set[str]]:
    states = {s.id: s.abbrev for s in (await session.execute(select(State))).scalars()}
    today = date.today()
    out: dict[tuple[int, int], set[str]] = defaultdict(set)
    for cs in (await session.execute(select(ContractorState))).scalars():
        if cs.term_date and cs.term_date < today:
            continue
        ab = states.get(cs.state_id)
        if ab:
            out[(cs.contractor_id, cs.contractor_type_id)].add(ab)
    return out


# ── documents ──────────────────────────────────────────────────────────────
async def persist_docs(
    session: AsyncSession,
    docs: list[ParsedDoc],
    *,
    progress: Progress = None,
    org_id: uuid.UUID | None = None,
) -> dict:
    progress = progress or _noop
    juris = await _jurisdiction_map(session)
    state_ids = {s.id: s.abbrev for s in (await session.execute(select(State))).scalars()}
    existing = {p.source_key: p for p in (await session.execute(select(Policy))).scalars()}
    stats = defaultdict(int)
    touched_versions: list[uuid.UUID] = []
    link_rows: list[tuple[uuid.UUID, str, str, dict]] = []
    for i, d in enumerate(docs):
        h = d.content_hash()
        pol = existing.get(d.source_key)
        if pol is None:
            pol = Policy(
                id=uuid.uuid4(),
                source=d.source,
                source_key=d.source_key,
                cms_id=d.cms_id,
                title=d.title,
                doc_type=d.doc_type,
                status=d.status,
                url=d.url,
                keywords=d.keywords,
                org_id=org_id if d.source == "payer" and org_id else None,
            )
            session.add(pol)
            existing[d.source_key] = pol
            stats["policies_new"] += 1
        else:
            pol.title, pol.doc_type, pol.status, pol.url, pol.keywords = (
                d.title,
                d.doc_type,
                d.status,
                d.url,
                d.keywords,
            )
        ver = (
            (
                await session.execute(
                    select(PolicyVersion).where(
                        PolicyVersion.policy_id == pol.id, PolicyVersion.version == d.version
                    )
                )
            )
            .scalars()
            .first()
        )
        if ver is not None and ver.content_hash == h:
            pol.current_version_id = ver.id
            stats["unchanged"] += 1
            continue
        if ver is not None:  # same version number, changed content → rebuild in place
            await session.delete(ver)
            await session.flush()
            stats["rebuilt"] += 1
        else:
            stats["versions_new"] += 1
        ver = PolicyVersion(
            id=uuid.uuid4(),
            policy_id=pol.id,
            version=d.version,
            effective_from=d.effective_from,
            effective_to=d.effective_to,
            retired_at=d.retired_at,
            last_updated=d.last_updated,
            content_hash=h,
            raw=d.raw,
        )
        session.add(ver)
        await session.flush()
        pol.current_version_id = ver.id
        touched_versions.append(ver.id)

        # sections + chunks
        header_extra = None
        if d.contractors:
            header_extra = f"{len({c[0] for c in d.contractors})} contractor(s)"
        sec_rows = []
        for ordinal, s in enumerate(d.sections):
            sec = PolicySection(
                id=uuid.uuid4(),
                policy_version_id=ver.id,
                section_key=s.key,
                title=s.title,
                text=s.text,
                ordinal=ordinal,
            )
            session.add(sec)
            sec_rows.append((sec, s))
        await session.flush()  # sections must exist before chunk rows reference them
        chunk_rows: list[dict] = []
        for sec, s in sec_rows:
            header = make_header(
                doc_type=d.doc_type,
                source_key=d.source_key,
                version=d.version,
                title=d.title,
                section_title=s.title,
                effective_from=d.effective_from.isoformat() if d.effective_from else None,
                extra=header_extra,
            )
            for ch in chunk_section(
                section_text=s.text, header=header, scope_key=f"{d.source_key}:{d.version}:{s.key}"
            ):
                chunk_rows.append(
                    {
                        "id": uuid.UUID(ch.id),
                        "policy_version_id": ver.id,
                        "section_id": sec.id,
                        "ordinal": ch.ordinal,
                        "parent_id": uuid.UUID(ch.parent_id) if ch.parent_id else None,
                        "level": ch.level,
                        "text": ch.text,
                        "header": ch.header,
                        "token_estimate": ch.token_estimate,
                        "char_start": ch.char_start,
                        "char_end": ch.char_end,
                        "content_hash": ch.content_hash,
                    }
                )
        if chunk_rows:
            await session.execute(insert(PolicyChunk), chunk_rows)
            stats["chunks"] += len(chunk_rows)
        # codes (bulk)
        if d.codes:
            await session.execute(
                insert(PolicyCode),
                [
                    {
                        "policy_version_id": ver.id,
                        "code_system": c.system,
                        "code": c.code,
                        "group_no": c.group_no,
                        "description": c.description,
                        "is_range": c.is_range,
                    }
                    for c in d.codes
                ],
            )
            stats["codes"] += len(d.codes)
        group_rows = [
            {"policy_version_id": ver.id, "code_system": s, "group_no": g, "paragraph": p}
            for s, g, p in d.code_groups
            if p
        ]
        if group_rows:
            await session.execute(insert(PolicyCodeGroup), group_rows)
        # contractors + jurisdiction states
        seen_c = set()
        st: dict[str, bool] = {}
        for cid, ctype, _cver in d.contractors:
            if (cid, ctype) in seen_c:
                continue
            seen_c.add((cid, ctype))
            session.add(
                PolicyContractor(policy_version_id=ver.id, contractor_id=cid, contractor_type_id=ctype)
            )
            for ab in juris.get((cid, ctype), ()):
                st.setdefault(ab, False)
        for sid in d.primary_state_ids:
            ab = state_ids.get(sid)
            if ab:
                st[ab] = True
        if d.national:
            st["US"] = True
        for ab, primary in st.items():
            session.add(PolicyState(policy_version_id=ver.id, state_abbrev=ab, primary=primary))
        for to_key, rel, meta in d.links:
            link_rows.append((ver.id, to_key, rel, meta))
        if i % 25 == 0:
            await session.flush()
            await progress(0.1 + 0.4 * i / max(1, len(docs)), f"persisted {i}/{len(docs)} documents")
    await session.flush()
    # links (second pass so targets inserted in this run resolve)
    if link_rows:
        keys = {p.source_key: p.id for p in existing.values()}
        await session.execute(
            insert(PolicyLink),
            [
                {
                    "from_version_id": vid,
                    "to_source_key": k,
                    "to_policy_id": keys.get(k),
                    "relation": rel,
                    "meta": meta,
                }
                for vid, k, rel, meta in link_rows
            ],
        )
    # refresh unresolved links (targets that arrived later)
    unresolved = (
        await session.execute(select(PolicyLink).where(PolicyLink.to_policy_id.is_(None)))
    ).scalars()
    for ln in unresolved:
        p = existing.get(ln.to_source_key)
        if p is not None:
            ln.to_policy_id = p.id
    await session.flush()
    stats["touched_versions"] = len(touched_versions)
    return dict(stats)


# ── orchestration ──────────────────────────────────────────────────────────
async def run_ingestion(
    session: AsyncSession,
    *,
    source: str = "mcd",
    scope: str | None = None,
    policy_keys: list[str] | None = None,
    limit: int | None = None,
    raw_dir: Path | None = None,
    progress: Progress = None,
    job_id: uuid.UUID | None = None,
    build_index: bool = True,
    activate: bool = True,
) -> dict:
    """source: mcd | fixtures | codesets. Returns run stats (also stored on `ingestion_runs`)."""
    progress = progress or _noop
    s = get_settings()
    scope = scope or s.ingest_scope
    raw_dir = raw_dir or (Path(s.data_dir) / "raw")
    run = IngestionRun(
        source=source,
        scope={"scope": scope, "policyKeys": policy_keys, "limit": limit},
        status="running",
        job_id=job_id,
    )
    session.add(run)
    await session.flush()
    t0 = time.perf_counter()
    try:
        from app.ai.retrieval.lexical import ensure_fts

        await ensure_fts(session)
        stats: dict = {}
        if source == "fixtures":
            await progress(0.05, "loading synthetic fixture policies")
            docs = load_fixture_docs()
            stats["documents"] = len(docs)
            stats.update(await persist_docs(session, docs, progress=progress))
            stats["codes_new"] = await upsert_codes(session, collect_codes(docs))
        elif source == "mcd":
            await progress(0.03, f"parsing MCD exports ({scope})")
            docs, reader = parse_mcd(raw_dir, scope, policy_keys, limit)
            stats["documents"] = len(docs)
            stats["reference"] = await persist_reference(session, reader)
            stats.update(await persist_docs(session, docs, progress=progress))
            stats["codes_new"] = await upsert_codes(session, collect_codes(docs))
        elif source == "codesets":
            cdc = find_cdc_file(raw_dir)
            stats["codes_new"] = await upsert_codes(session, parse_cdc_order_file(cdc)) if cdc else 0
            stats["cdc_file"] = str(cdc) if cdc else None
            build_index = False
        else:
            raise ValueError(f"unknown ingestion source '{source}'")
        await session.flush()
        if build_index:
            from app.ai.ingestion.indexer import build_policy_index

            async def idx_progress(p: float, m: str) -> None:
                await progress(0.5 + 0.5 * p, m)

            iv = await build_policy_index(session, progress=idx_progress, activate=activate)
            stats["index"] = {
                "id": str(iv.id),
                "physical": iv.physical_name,
                "status": iv.status,
                "points": iv.points,
                **(iv.stats or {}),
            }
        stats["seconds"] = round(time.perf_counter() - t0, 1)
        run.stats = stats
        run.status = "succeeded"
        run.finished_at = datetime.now(UTC)
        await session.flush()
        log.info(
            "ingestion.completed",
            source=source,
            scope=scope,
            **{k: v for k, v in stats.items() if not isinstance(v, dict)},
        )
        return {"runId": str(run.id), **stats}
    except Exception as exc:
        run.status = "failed"
        run.error = str(exc)[:4000]
        run.finished_at = datetime.now(UTC)
        await session.flush()
        raise
