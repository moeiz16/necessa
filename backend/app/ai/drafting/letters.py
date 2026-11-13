"""Letters of medical necessity, PA cover letters, appeal letters and peer-to-peer prep.

Safety properties (each covered by tests):
  * The model only ever sees de-identified *verified facts* (verbatim chart quotes that passed the
    evaluation's verification) and `<<PLACEHOLDERS>>` — never patient identifiers.
  * Post-generation fact audit: sentences containing dates, numbers or codes that don't appear in the
    fact sheet are removed and reported; unknown footnote markers are dropped; coverage-prediction
    language is removed (we never promise or predict a payer decision).
  * Letters are stored with placeholders; PHI is re-hydrated only on reveal/export (audited).
  * Template fallback when no LLM is available, so the product still produces a usable draft.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.agents.case_results import effective_verdict
from app.ai.compiler.prompting import render_prompt
from app.db.models.cases import Case, CaseEvaluation, CriterionResult, Letter, Patient

log = structlog.get_logger(__name__)

PLACEHOLDERS = ("PATIENT_NAME", "PATIENT_DOB", "MEMBER_ID", "PROVIDER_NAME", "PRACTICE_NAME", "CLAIM_NUMBER")
KIND_TITLES = {
    "lmn": "Letter of Medical Necessity",
    "pa_cover": "Prior Authorization Request — Cover Letter",
    "appeal": "Request for Redetermination / Appeal",
    "peer_to_peer_prep": "Peer-to-Peer Review — Preparation Brief",
}
_PREDICTION = re.compile(
    r"\b(will be (?:approved|covered|paid)|guarantee[sd]?|is (?:certainly|definitely) covered|must approve)\b",  # noqa: E501
    re.I,
)
_FACT_TOKEN = re.compile(
    r"\b\d{1,4}(?:[./-]\d{1,4}){0,2}(?:\.\d+)?%?|\b[A-Z]\d{2}(?:\.\w{1,4})?\b|\b[A-Z]\d{4}\b"
)
_DEID_TOKEN = re.compile(r"\[(?:[A-Z]+_)+\d+\]")
_FOOTNOTE = re.compile(r"\[\^(F\d+)\]")


@dataclass
class Fact:
    id: str
    text: str
    criterion_id: str
    criterion_text: str
    note_date: str | None = None
    document_id: str | None = None


@dataclass
class FactSheet:
    facts: list[Fact] = field(default_factory=list)
    gaps: list[dict] = field(default_factory=list)
    policies: list[dict] = field(default_factory=list)
    header: dict = field(default_factory=dict)

    def allowed_tokens(self) -> set[str]:
        blob = " ".join(
            [f.text for f in self.facts]
            + [str(v) for v in self.header.values()]
            + [p.get("sourceKey", "") or "" for p in self.policies]
            + [str(p.get("version") or "") for p in self.policies]
        )
        return set(_FACT_TOKEN.findall(blob))


async def build_fact_sheet(db: AsyncSession, case: Case, ev: CaseEvaluation | None) -> FactSheet:
    sheet = FactSheet(
        header={
            "service_codes": ", ".join(case.service_codes or []),
            "dx_codes": ", ".join(case.dx_codes or []),
            "date_of_service": case.date_of_service.isoformat() if case.date_of_service else "",
            "payer_name": case.payer_name or "",
            "payer_type": case.payer_type,
            "number": case.number,
        }
    )
    if ev is None:
        return sheet
    rows = (
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
    n = 0
    for r in rows:
        if effective_verdict(r) != "MET":
            continue
        for e in (r.evidence or [])[:2]:
            q = (e.get("quote") or "").strip()
            if not q:
                continue
            n += 1
            sheet.facts.append(
                Fact(
                    id=f"F{n}",
                    text=q,
                    criterion_id=r.criterion_id,
                    criterion_text=r.criterion_text,
                    note_date=e.get("noteDate"),
                    document_id=e.get("documentId"),
                )
            )
    sheet.gaps = list(ev.gaps or [])
    sheet.policies = list((ev.model_info or {}).get("policies") or case.policy_refs or [])
    return sheet


def facts_block(sheet: FactSheet) -> str:
    if not sheet.facts:
        return "(no verified facts — do not make clinical claims)"
    return "\n".join(f'[{f.id}] (criterion: {f.criterion_text}) "{f.text}"' for f in sheet.facts)


def gaps_block(sheet: FactSheet) -> str:
    return "\n".join(f"- {g.get('title')}" for g in sheet.gaps) or "(none)"


def policies_label(sheet: FactSheet) -> str:
    return (
        "; ".join(f"{p.get('sourceKey')} {p.get('title')}".strip() for p in sheet.policies)
        or "applicable policy"
    )


# ── post-generation audit ──────────────────────────────────────────────────────────────────────


@dataclass
class DraftAudit:
    text: str
    removed_sentences: list[str] = field(default_factory=list)
    unknown_footnotes: list[str] = field(default_factory=list)
    stripped_tokens: int = 0


def audit_draft(md: str, sheet: FactSheet, *, extra_allowed: set[str] | None = None) -> DraftAudit:
    allowed = sheet.allowed_tokens() | (extra_allowed or set())
    fact_ids = {f.id for f in sheet.facts}
    out_lines: list[str] = []
    removed: list[str] = []
    unknown: list[str] = []
    stripped = len(_DEID_TOKEN.findall(md))
    md = _DEID_TOKEN.sub("", md)
    for line in md.splitlines():
        if line.lstrip().startswith(("#", "|", "[^")) or not line.strip():
            out_lines.append(line)
            continue
        kept: list[str] = []
        for sent in split_sentences(line):
            if not sent:
                continue
            for fid in _FOOTNOTE.findall(sent):
                if fid not in fact_ids:
                    unknown.append(fid)
                    sent = sent.replace(f"[^{fid}]", "")
            if _PREDICTION.search(sent):
                removed.append(sent)
                continue
            body = re.sub(r"<<\w+>>", "", _FOOTNOTE.sub("", sent))
            bad = [t for t in _FACT_TOKEN.findall(body) if t not in allowed and not _is_boilerplate_number(t)]
            if bad:
                removed.append(sent)
                continue
            kept.append(sent)
        if kept:
            out_lines.append(" ".join(kept))
    return DraftAudit(
        text="\n".join(out_lines).strip(),
        removed_sentences=removed,
        unknown_footnotes=unknown,
        stripped_tokens=stripped,
    )


def split_sentences(line: str) -> list[str]:
    """Sentence split that keeps footnote markers with their sentence and never splits decimals (23.4)."""
    out, start = [], 0
    for m in re.finditer(r"[.!?]+(?:\[\^F\d+\])*(?=\s|$)", line):
        out.append(line[start : m.end()].strip())
        start = m.end()
    rest = line[start:].strip()
    if rest:
        out.append(rest)
    return [s for s in out if s]


def _is_boilerplate_number(tok: str) -> bool:
    # list numbering / single digits used in prose ("1.", "2") are not clinical facts
    return bool(re.fullmatch(r"\d", tok))


def footnotes(sheet: FactSheet) -> str:
    lines = ["", "---", "", "**Supporting documentation**", ""]
    for f in sheet.facts:
        when = f" (note dated {f.note_date})" if f.note_date else ""
        lines.append(f'[^{f.id}]: "{f.text}"{when}')
    if sheet.policies:
        lines += ["", "**Policy references**", ""]
        lines += [
            f"- {p.get('sourceKey')}: {p.get('title')}"
            + (f" (version {p['version']})" if p.get("version") else "")
            for p in sheet.policies
        ]
    return "\n".join(lines)


def template_letter(kind: str, sheet: FactSheet, *, denial: dict | None = None) -> str:
    h = sheet.header
    title = KIND_TITLES.get(kind, "Letter")
    lines = [
        f"# {title}",
        "",
        f"**Date:** {date.today().isoformat()}  ",
        f"**To:** {h['payer_name'] or 'Health plan'} — Utilization Management  ",
        "**Re:** <<PATIENT_NAME>> · DOB <<PATIENT_DOB>> · Member ID <<MEMBER_ID>>  ",
        f"**Requested service(s):** {h['service_codes']} · **Diagnosis:** {h['dx_codes']} · "
        f"**Date of service:** {h['date_of_service']}",
        "",
    ]
    if kind == "appeal" and denial:
        lines += [
            "## Reason for appeal",
            "",
            f"We respectfully request reconsideration of the denial received on {denial.get('received_at') or 'the date noted'} "  # noqa: E501
            f"(category: {denial.get('category', 'other').replace('_', ' ')}). The medical record documents the policy "  # noqa: E501
            "criteria as summarized below.",
            "",
        ]
    else:
        lines += [
            "## Clinical summary",
            "",
            f"<<PATIENT_NAME>> is under the care of <<PRACTICE_NAME>>. This letter summarizes documentation supporting "  # noqa: E501
            f"the medical necessity of the requested service under {policies_label(sheet)}.",
            "",
        ]
    lines += ["## Medical necessity — criterion by criterion", ""]
    by_crit: dict[str, list[Fact]] = {}
    for f in sheet.facts:
        by_crit.setdefault(f.criterion_text, []).append(f)
    for crit, facts in by_crit.items():
        refs = "".join(f"[^{f.id}]" for f in facts)
        lines.append(f"- **{crit}** — documented in the medical record.{refs}")
    if not by_crit:
        lines.append(
            "- No criteria are verified as documented yet. Complete the documentation check before sending."
        )
    if kind != "appeal" and sheet.gaps:
        lines += [
            "",
            "> **Internal note (remove before sending):** open documentation gaps — "
            + "; ".join(g.get("title", "") for g in sheet.gaps[:5]),
        ]
    lines += [
        "",
        "## Request",
        "",
        "Based on the documentation above, we request authorization of the service as ordered. Complete records "  # noqa: E501
        "are available upon request.",
        "",
        "Sincerely,",
        "",
        "<<PROVIDER_NAME>>  ",
        "<<PRACTICE_NAME>>",
    ]
    return "\n".join(lines)


async def rehydration_values(db: AsyncSession, case: Case) -> dict[str, str]:
    values = {k: f"[{k.replace('_', ' ').title()}]" for k in PLACEHOLDERS}
    patient = await db.get(Patient, case.patient_id)
    if patient is not None:
        try:
            from app.core.crypto import decrypt_json

            demo = decrypt_json(patient.demographics_enc) or {}
            values.update(
                PATIENT_NAME=demo.get("fullName") or values["PATIENT_NAME"],
                PATIENT_DOB=str(demo.get("dob") or values["PATIENT_DOB"]),
                MEMBER_ID=demo.get("memberId") or values["MEMBER_ID"],
            )
        except Exception:
            log.warning("letters.rehydrate_decrypt_failed")
    try:
        from app.db.models.platform import Organization, User

        org = await db.get(Organization, case.org_id)
        if org is not None:
            values["PRACTICE_NAME"] = org.name
        if case.assignee_id:
            u = await db.get(User, case.assignee_id)
            if u is not None:
                values["PROVIDER_NAME"] = u.full_name
    except Exception:
        log.warning("letters.rehydrate_org_lookup_failed")
    values["CLAIM_NUMBER"] = case.number
    return values


def rehydrate(md: str, values: dict[str, str]) -> str:
    return re.sub(r"<<([A-Z_]+)>>", lambda m: values.get(m.group(1), m.group(0)), md)


def mask(md: str) -> str:
    """Human-readable placeholders for the default (non-revealed) view."""
    return re.sub(r"<<([A-Z_]+)>>", lambda m: f"«{m.group(1).replace('_', ' ').title()}»", md)


# ── generation ─────────────────────────────────────────────────────────────────────────────────


async def generate_letter_text(
    router: Any | None,
    kind: str,
    sheet: FactSheet,
    *,
    org_id: uuid.UUID | None = None,
    denial: dict | None = None,
    mapped: list[dict] | None = None,
    on_token=None,
) -> tuple[str, dict]:
    """Return (markdown_with_placeholders, model_info)."""
    info: dict[str, Any] = {"source": "template"}
    text = None
    if router is not None and _available(router, "drafter"):
        from app.ai.llm.types import DataClass

        h = sheet.header
        if kind == "appeal":
            prompt = render_prompt(
                "letter_appeal",
                received_at=(denial or {}).get("received_at", ""),
                category=(denial or {}).get("category", "other"),
                carc=", ".join((denial or {}).get("carc_codes", [])),
                rarc=", ".join((denial or {}).get("rarc_codes", [])),
                reason_text=(denial or {}).get("reason_text", "")[:1500],
                payer_name=h["payer_name"],
                payer_type=h["payer_type"],
                service_codes=h["service_codes"],
                date_of_service=h["date_of_service"],
                policies=policies_label(sheet),
                deadline=(denial or {}).get("appeal_deadline", ""),
                facts=facts_block(sheet),
                mapped="\n".join(
                    f'- {m.get("text")} (policy: "{m.get("policyQuote", "")}")' for m in (mapped or [])
                )
                or "(none)",
            )
        else:
            prompt = render_prompt(
                "letter_lmn",
                kind=KIND_TITLES.get(kind, kind),
                payer_name=h["payer_name"],
                payer_type=h["payer_type"],
                service_codes=h["service_codes"],
                dx_codes=h["dx_codes"],
                date_of_service=h["date_of_service"],
                policies=policies_label(sheet),
                facts=facts_block(sheet),
                gaps=gaps_block(sheet),
            )
        stream_info: dict[str, Any] = {}
        parts: list[str] = []
        try:
            async for piece in router.stream(
                group="drafter",
                purpose=f"letter.{kind}",
                data_class=DataClass.PHI,
                deidentified=True,
                messages=[{"role": "user", "content": prompt}],
                org_id=org_id,
                info=stream_info,
                temperature=0.3,
            ):
                parts.append(piece)
                if on_token is not None:
                    await on_token(piece)
            text = "".join(parts).strip() or None
            info = {
                "source": "llm",
                "provider": stream_info.get("provider"),
                "model": stream_info.get("model"),
                "promptTokens": stream_info.get("prompt_tokens"),
                "completionTokens": stream_info.get("completion_tokens"),
            }
        except Exception as exc:
            log.warning("letters.llm_failed", kind=kind, error=str(exc)[:200])
            info = {"source": "template", "fallbackReason": type(exc).__name__}
    if not text:
        text = template_letter(kind, sheet, denial=denial)
        if on_token is not None:
            await on_token(text)
    extra = set(_FACT_TOKEN.findall(" ".join(str(v) for v in (denial or {}).values() if isinstance(v, str))))
    extra |= {date.today().isoformat()}
    audited = audit_draft(text, sheet, extra_allowed=extra)
    body = audited.text
    if "[^F" in body or sheet.facts:
        body = body.split("\n---\n")[0].rstrip() + "\n" + footnotes(sheet)
    info["audit"] = {
        "removedSentences": audited.removed_sentences[:10],
        "unknownFootnotes": audited.unknown_footnotes,
        "strippedTokens": audited.stripped_tokens,
    }
    return body, info


async def create_letter(
    db: AsyncSession,
    *,
    case: Case,
    kind: str,
    router: Any | None,
    actor_id: uuid.UUID | None,
    denial: dict | None = None,
    mapped: list[dict] | None = None,
    on_token=None,
    letter_id: uuid.UUID | None = None,
) -> Letter:
    ev = await db.get(CaseEvaluation, case.latest_evaluation_id) if case.latest_evaluation_id else None
    sheet = await build_fact_sheet(db, case, ev)
    body, info = await generate_letter_text(
        router, kind, sheet, org_id=case.org_id, denial=denial, mapped=mapped, on_token=on_token
    )
    version = (
        await db.execute(
            select(func.max(Letter.version)).where(Letter.case_id == case.id, Letter.kind == kind)
        )
    ).scalar() or 0
    letter = await db.get(Letter, letter_id) if letter_id else None
    citations = [
        {
            "id": f.id,
            "criterionId": f.criterion_id,
            "quote": f.text,
            "noteDate": f.note_date,
            "documentId": f.document_id,
        }
        for f in sheet.facts
    ]
    if letter is None:
        letter = Letter(id=letter_id or uuid.uuid4(), org_id=case.org_id, case_id=case.id, kind=kind)
        db.add(letter)
    letter.status = "draft"
    letter.title = f"{KIND_TITLES.get(kind, kind)} — {case.number}"
    letter.content_md = body
    letter.version = version + 1
    letter.citations = citations
    letter.model_info = {
        **info,
        "evaluationId": str(ev.id) if ev else None,
        "gapsAtDraft": len(sheet.gaps),
        "facts": len(sheet.facts),
    }
    letter.created_by = actor_id
    await db.flush()
    from app.services.cases import add_event

    await add_event(
        db,
        case,
        "letter_drafted",
        {"letterId": str(letter.id), "kind": kind, "version": letter.version, "source": info.get("source")},
        actor_id,
    )
    return letter


def letter_api(letter: Letter, *, rendered: str | None = None) -> dict:
    return {
        "id": str(letter.id),
        "caseId": str(letter.case_id),
        "kind": letter.kind,
        "status": letter.status,
        "title": letter.title,
        "contentMd": mask(letter.content_md or ""),
        "template": letter.content_md,
        "rendered": rendered,
        "version": letter.version,
        "citations": letter.citations or [],
        "modelInfo": letter.model_info or {},
        "createdBy": str(letter.created_by) if letter.created_by else None,
        "approvedBy": str(letter.approved_by) if letter.approved_by else None,
        "approvedAt": letter.approved_at.isoformat() if letter.approved_at else None,
        "createdAt": letter.created_at.isoformat() if letter.created_at else None,
        "updatedAt": letter.updated_at.isoformat() if letter.updated_at else None,
    }


def _available(router: Any, group: str) -> bool:
    try:
        return bool(router.is_available(group))
    except Exception:
        return False
