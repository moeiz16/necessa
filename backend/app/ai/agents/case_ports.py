"""Production adapters for the case agent: Postgres (A's case tables, B's knowledge tables),
Qdrant chart index + hybrid retriever (B), event bus, audit, notifications (A).

Every peer integration degrades gracefully: missing knowledge base → curated policies by service
code; missing dense index → per-case BM25; missing LLM → deterministic rules. Each degradation is
recorded as a flag and surfaced in the UI ("degraded" banner) and the evaluation's model_info.
"""

from __future__ import annotations

import time
import uuid
from datetime import date

import structlog
from sqlalchemy import delete, select

from app.ai.agents.case_chart import ChartChunk, ChartDoc, LexicalIndex, to_date
from app.ai.agents.case_graph import CaseSnapshot, LoadedCriteria
from app.ai.agents.case_results import criterion_result_api, evaluation_api
from app.ai.compiler.criteria_compiler import approved_set, compile_policy, tree_of, upsert_curated
from app.ai.compiler.curated import curated_for_services, load_curated, sections_from_db
from app.ai.compiler.schema import CriterionLeaf
from app.db.base import utcnow
from app.db.models.cases import Case, CaseChunk, CaseDocument, CaseEvaluation, CriterionResult
from app.db.session import get_sessionmaker

log = structlog.get_logger(__name__)

MEDICARE_TYPES = {"medicare_ffs", "medicare_advantage"}


class DbCasePorts:
    def __init__(
        self,
        *,
        case_id: uuid.UUID,
        org_id: uuid.UUID,
        evaluation_id: uuid.UUID,
        actor_id: uuid.UUID | None,
        policy_version_ids: list[str] | None = None,
        job_id: uuid.UUID | None = None,
        router=None,
    ) -> None:
        self.case_id, self.org_id, self.evaluation_id = case_id, org_id, evaluation_id
        self.actor_id, self.job_id = actor_id, job_id
        self.policy_version_ids = policy_version_ids or []
        self.router = router
        self.sm = get_sessionmaker()
        self._last_cancel_check = 0.0
        self._cancelled = False
        self._retriever = None
        self._retriever_checked = False

    # ── load ────────────────────────────────────────────────────────────────────────────────
    async def load_case(self) -> CaseSnapshot:
        async with self.sm() as db:
            case = (
                await db.execute(select(Case).where(Case.id == self.case_id, Case.org_id == self.org_id))
            ).scalar_one()
            docs = (
                (
                    await db.execute(
                        select(CaseDocument)
                        .where(
                            CaseDocument.case_id == case.id,
                            CaseDocument.org_id == self.org_id,
                            CaseDocument.quarantined.is_(False),
                        )
                        .order_by(CaseDocument.note_date.asc().nulls_last(), CaseDocument.created_at.asc())
                    )
                )
                .scalars()
                .all()
            )
            # Intake (workstream A) de-identifies with date_policy="keep": identifiers are tokenized and
            # clinical dates are preserved, so chart dates line up with the date of service and note dates.
            chart_docs = [
                ChartDoc(
                    document_id=str(d.id),
                    kind=d.kind,
                    text=d.text_deid,
                    note_date=d.note_date,
                    title=d.filename,
                )
                for d in docs
                if (d.text_deid or "").strip()
            ]
            dos = to_date(case.date_of_service)
            return CaseSnapshot(
                case_id=str(case.id),
                org_id=str(case.org_id),
                number=case.number,
                title=case.title,
                payer_type=case.payer_type,
                payer_name=case.payer_name,
                state=case.state,
                service_codes=list(case.service_codes or []),
                dx_codes=list(case.dx_codes or []),
                date_of_service=dos,
                dos_label=dos.isoformat() if dos else "not provided",
                docs=chart_docs,
            )

    # ── policies ────────────────────────────────────────────────────────────────────────────
    async def resolve_policies(self, snap: CaseSnapshot) -> list[dict]:
        matches: list[dict] = []
        async with self.sm() as db:
            if self.policy_version_ids:
                matches = await self._matches_for_versions(db, self.policy_version_ids)
            else:
                try:
                    from app.ai.sql.tools import resolve_policies

                    found = await resolve_policies(
                        db,
                        service_codes=snap.service_codes,
                        dx_codes=snap.dx_codes,
                        state=snap.state,
                        payer_type=snap.payer_type,
                        date_of_service=snap.date_of_service or date.today(),
                    )
                    matches = [m if isinstance(m, dict) else _dto(m) for m in found]
                except Exception as exc:
                    log.info("case.resolve_policies_unavailable", error=str(exc)[:200])
        return merge_curated(matches, snap.service_codes, snap.payer_type)

    async def _matches_for_versions(self, db, version_ids: list[str]) -> list[dict]:
        try:
            from app.db.models.knowledge import Policy, PolicyVersion
        except Exception:
            return []
        out = []
        for vid in version_ids:
            try:
                row = (
                    await db.execute(
                        select(PolicyVersion, Policy)
                        .join(Policy, Policy.id == PolicyVersion.policy_id)
                        .where(PolicyVersion.id == uuid.UUID(str(vid)))
                    )
                ).first()
            except ValueError:
                row = None
            if row is None:
                tree = load_curated().get(str(vid))
                if tree:
                    out.append(curated_match(tree, []))
                continue
            v, p = row
            out.append(
                {
                    "policyId": str(p.id),
                    "policyVersionId": str(v.id),
                    "sourceKey": p.source_key,
                    "title": p.title,
                    "docType": p.doc_type,
                    "version": v.version,
                    "effectiveFrom": v.effective_from.isoformat() if v.effective_from else None,
                    "effectiveTo": v.effective_to.isoformat() if v.effective_to else None,
                    "matchReasons": [{"type": "manual", "value": str(v.id), "detail": "selected by user"}],
                    "score": 1.0,
                    "contractor": None,
                }
            )
        return out

    async def load_criteria(self, snap: CaseSnapshot, matches: list[dict]) -> list[LoadedCriteria]:
        loaded: list[LoadedCriteria] = []
        async with self.sm() as db:
            for m in matches:
                key = m.get("sourceKey")
                vid = m.get("policyVersionId")
                flags: list[str] = []
                cs = await approved_set(db, key, vid)
                if cs is None and key in load_curated():
                    version_id, sections = await sections_from_db(db, key)
                    cs = await upsert_curated(db, load_curated()[key], version_id or vid, sections or None)
                if cs is None and self.router is not None and _llm_available(self.router, "compiler-longctx"):
                    try:
                        cs = await compile_policy(
                            db, policy_key=key, router=self.router, actor_id=self.actor_id
                        )
                        if cs.status != "approved":
                            flags.append(f"criteria_unreviewed:{key}")
                    except Exception as exc:
                        log.warning("case.compile_on_demand_failed", policy=key, error=str(exc)[:200])
                if cs is None:
                    flags.append(f"no_criteria:{key}")
                    continue
                m = {**m, "criteriaSetStatus": cs.status}
                loaded.append(
                    LoadedCriteria(
                        tree=tree_of(cs),
                        match=m,
                        criteria_set_id=str(cs.id),
                        policy_version_id=vid or cs.policy_version_id,
                        flags=flags,
                    )
                )
            await db.commit()
            ev = await db.get(CaseEvaluation, self.evaluation_id)
            if ev is not None:
                ev.policy_version_ids = [lc.policy_version_id for lc in loaded if lc.policy_version_id]
                ev.criteria_set_ids = [lc.criteria_set_id for lc in loaded if lc.criteria_set_id]
                await db.commit()
        return loaded

    # ── chart ───────────────────────────────────────────────────────────────────────────────
    async def index_chart(self, snap: CaseSnapshot, chunks: list[ChartChunk]) -> list[str]:
        async with self.sm() as db:
            await db.execute(
                delete(CaseChunk).where(CaseChunk.case_id == self.case_id, CaseChunk.org_id == self.org_id)
            )
            for c in chunks:
                db.add(
                    CaseChunk(
                        id=uuid.UUID(c.chunk_id),
                        org_id=self.org_id,
                        case_id=self.case_id,
                        document_id=uuid.UUID(c.document_id),
                        ordinal=c.ordinal,
                        text_deid=c.text,
                        section=c.section,
                        note_date=c.note_date,
                        char_start=c.char_start,
                        char_end=c.char_end,
                        meta={"docKind": c.doc_kind},
                    )
                )
            await db.commit()
        flags: list[str] = []
        try:
            from app.ai.retrieval.chart_index import ChartChunkIn, index_chart_chunks

            await index_chart_chunks(
                self.case_id,
                self.org_id,
                [
                    ChartChunkIn(
                        chunk_id=c.chunk_id,
                        document_id=c.document_id,
                        text=c.text,
                        section=c.section,
                        note_date=c.note_date,
                    )
                    for c in chunks
                ],
            )
        except Exception as exc:
            log.info("case.chart_dense_index_unavailable", error=str(exc)[:200])
            flags.append("chart_dense_index_unavailable")
        return flags

    async def retrieve(
        self,
        snap: CaseSnapshot,
        leaf: CriterionLeaf,
        query: str,
        lexical: LexicalIndex,
        window: tuple[date | None, date | None],
        top_k: int,
    ) -> tuple[list[tuple[ChartChunk, float]], list[str]]:
        lex = lexical.search(query, top_k=top_k * 2, not_before=window[0], not_after=window[1])
        retriever = self._get_retriever()
        if retriever is None:
            return lex[:top_k], ["lexical_only"]
        try:
            from app.ai.retrieval.types import PolicyFilters, RetrievalQuery

            res = await retriever.search(
                RetrievalQuery(
                    text=query,
                    org_id=self.org_id,
                    scope="chart",
                    case_id=self.case_id,
                    top_k=top_k * 2,
                    lookback_days=leaf.lookback_days,
                    filters=PolicyFilters(as_of=snap.date_of_service),
                    trace=False,
                )
            )
            by_id = {c.chunk_id: c for c in lexical.chunks}
            dense = [(by_id[r.chunk_id], float(r.score)) for r in res.chunks if r.chunk_id in by_id]
            return rrf_merge([dense, lex])[:top_k], []
        except Exception as exc:
            log.info("case.hybrid_chart_retrieval_failed", error=str(exc)[:200])
            return lex[:top_k], ["lexical_only"]

    def _get_retriever(self):
        if not self._retriever_checked:
            self._retriever_checked = True
            try:
                from app.ai.retrieval.retriever import get_retriever

                self._retriever = get_retriever()
            except Exception:
                self._retriever = None
        return self._retriever

    # ── persistence ─────────────────────────────────────────────────────────────────────────
    async def persist_result(self, result: dict) -> dict:
        async with self.sm() as db:
            row = CriterionResult(
                org_id=self.org_id, evaluation_id=self.evaluation_id, case_id=self.case_id, **result
            )
            db.add(row)
            await db.commit()
            return criterion_result_api(row)

    async def finish(self, summary: dict) -> dict:
        from app.services.audit import audit
        from app.services.cases import add_event, set_status

        async with self.sm() as db:
            ev = await db.get(CaseEvaluation, self.evaluation_id)
            case = await db.get(Case, self.case_id)
            ev.status = "awaiting_review"
            ev.readiness = summary["readiness"]
            ev.readiness_score = summary["readiness_score"]
            ev.tree_result = summary["tree_result"]
            ev.gaps = summary["gaps"]
            ev.policy_version_ids = summary["policy_version_ids"]
            ev.criteria_set_ids = summary["criteria_set_ids"]
            ev.model_info = {**summary["model_info"], "policies": summary["policies"]}
            ev.token_usage = summary["token_usage"]
            ev.degraded = summary["degraded"]
            ev.finished_at = utcnow()
            case.readiness = summary["readiness"]
            case.readiness_score = summary["readiness_score"]
            case.latest_evaluation_id = ev.id
            case.policy_refs = [
                {
                    "policyId": p.get("policyId"),
                    "policyVersionId": p.get("policyVersionId"),
                    "sourceKey": p.get("sourceKey"),
                    "title": p.get("title"),
                    "version": p.get("version"),
                }
                for p in summary["policies"]
            ]
            await set_status(
                db, case, "needs_review", actor_id=self.actor_id, reason="evaluation completed", force=True
            )
            await add_event(
                db,
                case,
                "evaluation_completed",
                {
                    "evaluationId": str(ev.id),
                    "readiness": ev.readiness,
                    "readinessScore": ev.readiness_score,
                    "gaps": len(ev.gaps),
                    "degraded": ev.degraded,
                },
                self.actor_id,
            )
            await audit(
                db,
                action="case.evaluation.completed",
                resource_type="case",
                resource_id=case.id,
                org_id=self.org_id,
                actor_id=self.actor_id,
                actor_type="system" if not self.actor_id else "user",
                metadata={
                    "evaluationId": str(ev.id),
                    "readiness": ev.readiness,
                    "criteria": len(summary.get("policies", [])),
                    "degraded": ev.degraded,
                },
            )
            try:
                from app.services.notifications import notify

                users = [u for u in {case.assignee_id, self.actor_id} if u]
                blockers = sum(1 for g in ev.gaps if g.get("severity") == "blocker")
                await notify(
                    db,
                    org_id=self.org_id,
                    type="evaluation_ready",
                    title=f"{case.number}: evaluation ready for review",
                    body=f"Readiness: {ev.readiness.replace('_', ' ')} · {len(ev.gaps)} gap(s)"
                    + (f", {blockers} blocker(s)" if blockers else ""),
                    link=f"/cases/{case.id}",
                    user_ids=users or None,
                )
            except Exception:
                log.exception("case.notify_failed")
            results = (
                (
                    await db.execute(
                        select(CriterionResult)
                        .where(CriterionResult.evaluation_id == ev.id)
                        .order_by(CriterionResult.tree_path)
                    )
                )
                .scalars()
                .all()
            )
            await db.commit()
            return evaluation_api(ev, [criterion_result_api(r) for r in results], summary["policies"])

    async def fail(self, error: str) -> None:
        async with self.sm() as db:
            ev = await db.get(CaseEvaluation, self.evaluation_id)
            case = await db.get(Case, self.case_id)
            if ev is not None:
                ev.status = "cancelled" if error == "cancelled" else "failed"
                ev.error = error[:500]
                ev.finished_at = utcnow()
            if case is not None and case.status == "evaluating":
                from app.services.cases import set_status

                await set_status(
                    db, case, "draft", actor_id=self.actor_id, reason=f"evaluation {error}", force=True
                )
            await db.commit()

    async def publish(self, event: str, data: dict) -> None:
        try:
            from app.core.events import publish

            await publish(f"case:{self.case_id}", event, data)
        except Exception:
            log.debug("case.publish_failed", event=event)

    async def cancelled(self) -> bool:
        if self._cancelled or self.job_id is None:
            return self._cancelled
        now = time.monotonic()
        if now - self._last_cancel_check < 2.0:
            return False
        self._last_cancel_check = now
        try:
            from app.db.models.platform import Job

            async with self.sm() as db:
                status = (
                    await db.execute(select(Job.status).where(Job.id == self.job_id))
                ).scalar_one_or_none()
            self._cancelled = status == "cancelled"
        except Exception:
            return False
        return self._cancelled


def merge_curated(matches: list[dict], service_codes: list[str], payer_type: str) -> list[dict]:
    """Add curated policies for services that no ingested policy of the right *family* covers (or when the
    knowledge base is empty). Medicare FFS/MA cases use Medicare (LCD/NCD) criteria; commercial and
    Medicaid cases use the plan's own (synthetic demo) policy."""
    out = list(matches)
    medicare = payer_type in MEDICARE_TYPES

    def is_payer_match(m: dict) -> bool:
        return str(m.get("sourceKey", "")).startswith("PAYER-") or m.get("docType") == "Payer Policy"

    covered = {
        r.get("value")
        for m in out
        if is_payer_match(m) != medicare
        for r in m.get("matchReasons", [])
        if r.get("type") in {"hcpcs", "manual"}
    }
    for tree in curated_for_services(service_codes):
        is_payer = tree.policy_key.startswith("PAYER-")
        if is_payer == medicare:  # wrong family for this payer type
            continue
        if any(m.get("sourceKey") == tree.policy_key for m in out):
            continue
        if set(tree.services) & set(service_codes) & covered:
            continue
        out.append(curated_match(tree, service_codes))
    return out


def curated_match(tree, service_codes: list[str]) -> dict:
    return {
        "policyId": None,
        "policyVersionId": None,
        "sourceKey": tree.policy_key,
        "title": tree.title,
        "docType": "Payer Policy" if tree.synthetic else "LCD",
        "version": tree.policy_version,
        "effectiveFrom": None,
        "effectiveTo": None,
        "matchReasons": [
            {"type": "hcpcs", "value": c, "detail": "service code listed in curated criteria"}
            for c in tree.services
            if c in service_codes
        ]
        or [{"type": "curated", "value": tree.policy_key, "detail": "curated criteria set"}],
        "score": 0.9,
        "contractor": None,
        "criteriaSetStatus": "approved",
        "curated": True,
        "synthetic": tree.synthetic,
    }


def rrf_merge(lists: list[list[tuple[ChartChunk, float]]], k: int = 60) -> list[tuple[ChartChunk, float]]:
    scores: dict[str, float] = {}
    keep: dict[str, ChartChunk] = {}
    for lst in lists:
        for rank, (c, _s) in enumerate(lst):
            scores[c.chunk_id] = scores.get(c.chunk_id, 0.0) + 1.0 / (k + rank + 1)
            keep[c.chunk_id] = c
    return sorted(((keep[i], s) for i, s in scores.items()), key=lambda x: -x[1])


def _dto(m) -> dict:
    if hasattr(m, "model_dump"):
        return m.model_dump(by_alias=True)
    if hasattr(m, "__dict__"):
        return {k: v for k, v in vars(m).items()}
    return dict(m)


def _llm_available(router, group: str) -> bool:
    try:
        return bool(router.is_available(group))
    except Exception:
        return False
