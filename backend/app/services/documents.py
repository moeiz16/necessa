"""Chart document intake: validate → extract text → de-identify → scan for injection → store encrypted.

Uses the RAG guardrails when present (`app.ai.guardrails.phi.Deidentifier`,
`app.ai.guardrails.injection.scan_injection`) and falls back to conservative built-ins so intake never breaks.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import structlog
from selectolax.lexbor import LexborHTMLParser as HTMLParser
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.crypto import decrypt_str, encrypt_str
from app.core.errors import AppError
from app.db.models.cases import Case, CaseDocument, Patient
from app.services.cases import add_event, patient_identifiers

log = structlog.get_logger(__name__)

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_PDF_PAGES = 300
MAX_STORED_BUNDLE_BYTES = 2 * 1024 * 1024
TEXT_MIMES = {"text/plain", "text/markdown", "text/x-markdown"}
JSON_MIMES = {"application/json", "application/fhir+json"}
PDF_MIME = "application/pdf"
_BLOCKED_MAGIC = (b"MZ", b"\x7fELF", b"PK\x03\x04", b"\xca\xfe\xba\xbe", b"#!")


@dataclass
class Extracted:
    text: str
    mime: str
    page_count: int | None = None
    note_date: date | None = None
    needs_ocr: bool = False
    meta: dict[str, Any] = field(default_factory=dict)
    fhir_patient: dict[str, Any] | None = None


# ── Validation & extraction ─────────────────────────────────────────────────
def sniff_mime(data: bytes, filename: str, declared: str | None) -> str:
    head = data[:8]
    if any(head.startswith(m) for m in _BLOCKED_MAGIC):
        raise AppError(
            415,
            "unsupported_file",
            "Unsupported file type",
            "Executables, archives and scripts are not accepted.",
        )
    if head.startswith(b"%PDF-"):
        return PDF_MIME
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AppError(
            415,
            "unsupported_file",
            "Unsupported file type",
            "Upload a PDF, plain text/markdown note, or a FHIR R4 JSON bundle.",
        ) from exc
    stripped = text.lstrip("﻿ \t\r\n")
    if stripped.startswith("{"):
        return "application/fhir+json"
    if filename.lower().endswith(".pdf") or (declared or "").lower() == PDF_MIME:
        raise AppError(
            415,
            "mime_mismatch",
            "File content does not match its type",
            "The file is named/declared as PDF but is not a PDF.",
        )
    return "text/markdown" if filename.lower().endswith((".md", ".markdown")) else "text/plain"


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\x00", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def extract_pdf(data: bytes) -> Extracted:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise AppError(422, "pdf_encrypted", "Encrypted PDF", "Remove the password before uploading.")
        pages = reader.pages
        if len(pages) > MAX_PDF_PAGES:
            raise AppError(413, "pdf_too_long", "PDF too long", f"Limit is {MAX_PDF_PAGES} pages.")
        texts = [f"[Page {i + 1}]\n{(p.extract_text() or '').strip()}" for i, p in enumerate(pages)]
    except PdfReadError as exc:
        raise AppError(422, "pdf_unreadable", "Unreadable PDF", "The PDF appears to be corrupted.") from exc
    body = clean_text("\n\n".join(texts))
    chars = len(re.sub(r"\[Page \d+\]|\s", "", body))
    needs_ocr = chars < 40 * max(len(pages), 1)  # scanned/fax PDFs have (almost) no text layer
    return Extracted(
        text=body, mime=PDF_MIME, page_count=len(pages), needs_ocr=needs_ocr, meta={"textChars": chars}
    )


def _html_text(div: str | None) -> str:
    if not div:
        return ""
    return clean_text(HTMLParser(div).text(separator="\n"))


def _codeable(c: dict | None) -> str:
    if not c:
        return ""
    if c.get("text"):
        return c["text"]
    codings = c.get("coding") or []
    return "; ".join(filter(None, (f"{x.get('display') or ''} ({x.get('code')})".strip() for x in codings)))


def _date_of(res: dict) -> str | None:
    for key in ("date", "effectiveDateTime", "issued", "authoredOn", "onsetDateTime", "recordedDate"):
        if res.get(key):
            return str(res[key])[:10]
    period = res.get("performedPeriod") or res.get("effectivePeriod") or {}
    if period.get("start"):
        return str(period["start"])[:10]
    if res.get("performedDateTime"):
        return str(res["performedDateTime"])[:10]
    return None


def _attachment_text(att: dict) -> str:
    if att.get("data") and (att.get("contentType") or "text/plain").startswith("text"):
        try:
            return base64.b64decode(att["data"]).decode("utf-8", "replace")
        except (ValueError, TypeError):
            return ""
    return ""


def extract_fhir(data: bytes) -> Extracted:
    try:
        bundle = json.loads(data.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise AppError(422, "invalid_json", "Invalid JSON", "The FHIR bundle could not be parsed.") from exc
    if bundle.get("resourceType") != "Bundle":
        raise AppError(422, "not_a_bundle", "Not a FHIR Bundle", "Expected resourceType 'Bundle' (FHIR R4).")
    resources = [e.get("resource") or {} for e in bundle.get("entry") or []]
    patient = next((r for r in resources if r.get("resourceType") == "Patient"), None)
    sections: list[tuple[str, str, str]] = []  # (date, header, body)
    counts: dict[str, int] = {}
    for r in resources:
        rtype = r.get("resourceType")
        when = _date_of(r) or ""
        body = ""
        if rtype == "DocumentReference":
            parts = [_attachment_text(c.get("attachment") or {}) for c in r.get("content") or []]
            body = "\n".join(p for p in parts if p) or _html_text((r.get("text") or {}).get("div"))
            header = f"Clinical note — {_codeable(r.get('type')) or 'Document'}"
        elif rtype == "DiagnosticReport":
            parts = [_attachment_text(f) for f in r.get("presentedForm") or []]
            body = (
                "\n".join(p for p in parts if p)
                or r.get("conclusion")
                or _html_text((r.get("text") or {}).get("div"))
            )
            header = f"Diagnostic report — {_codeable(r.get('code')) or 'Report'}"
        elif rtype == "Observation":
            val = r.get("valueQuantity") or {}
            value = (
                f"{val.get('value')} {val.get('unit') or ''}".strip()
                if val
                else r.get("valueString") or _codeable(r.get("valueCodeableConcept"))
            )
            body = f"{_codeable(r.get('code'))}: {value}".strip(": ")
            header = "Observation"
        elif rtype == "Procedure":
            body = f"{_codeable(r.get('code'))} (status: {r.get('status', 'unknown')})"
            header = "Procedure"
        elif rtype == "Condition":
            body = (
                f"{_codeable(r.get('code'))} (clinical status: {_codeable(r.get('clinicalStatus')) or 'n/a'})"
            )
            header = "Condition"
        elif rtype == "MedicationRequest":
            body = f"{_codeable(r.get('medicationCodeableConcept'))} — {r.get('status', '')}".strip(" —")
            header = "Medication"
        else:
            continue
        if body.strip():
            counts[rtype] = counts.get(rtype, 0) + 1
            sections.append((when, header, clean_text(body)))
    sections.sort(key=lambda s: s[0])
    text = "\n\n".join(f"## {h}{f' ({d})' if d else ''}\n{b}" for d, h, b in sections)
    latest = max((s[0] for s in sections if s[0]), default=None)
    pt = None
    if patient:
        name = (patient.get("name") or [{}])[0]
        pt = {
            "full_name": " ".join([*(name.get("given") or []), name.get("family") or ""]).strip()
            or "Unknown",
            "dob": patient.get("birthDate"),
            "sex": patient.get("gender") or "unknown",
            "state": ((patient.get("address") or [{}])[0].get("state") or "")[:2].upper() or None,
            "mrn": next((i.get("value") for i in patient.get("identifier") or [] if i.get("value")), None),
            "phone": next(
                (t.get("value") for t in patient.get("telecom") or [] if t.get("system") == "phone"), None
            ),
            "address": " ".join((patient.get("address") or [{}])[0].get("line") or []) or None,
        }
    note_date = None
    if latest:
        try:
            note_date = date.fromisoformat(latest)
        except ValueError:
            note_date = None
    return Extracted(
        text=clean_text(text),
        mime="application/fhir+json",
        note_date=note_date,
        meta={"resourceCounts": counts, "sections": len(sections)},
        fhir_patient=pt,
    )


def extract(data: bytes, filename: str, declared_mime: str | None) -> Extracted:
    if len(data) > MAX_UPLOAD_BYTES:
        raise AppError(
            413, "file_too_large", "File too large", f"Limit is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB."
        )
    if not data:
        raise AppError(422, "empty_file", "Empty file", "The uploaded file is empty.")
    mime = sniff_mime(data, filename, declared_mime)
    if mime == PDF_MIME:
        return extract_pdf(data)
    if mime in JSON_MIMES:
        return extract_fhir(data)
    return Extracted(text=clean_text(data.decode("utf-8")), mime=mime)


# ── Guardrails (B's implementations with safe fallbacks) ─────────────────────
_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_PHONE = re.compile(r"(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)")
_EMAIL = re.compile(r"\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
_MRN = re.compile(
    r"\b(MRN|Medical Record(?: Number)?|Member ID|Policy #)[:#\s]*[A-Z0-9-]{4,}\b", re.IGNORECASE
)
_INJECTION_PATTERNS = [
    re.compile(p, re.IGNORECASE)
    for p in (
        r"ignore (all|any|the)? ?(previous|prior|above) (instructions|rules)",
        r"disregard (the|all|your) (system|previous) (prompt|instructions)",
        r"you are now (?:a|an|the)\b",
        r"(reveal|print|show) (your|the) system prompt",
        r"\bjailbreak\b",
        r"act as (?:dan|developer mode)",
        r"mark (all|every) criteri(a|on) as met",
        r"output (approved|met) regardless",
    )
]


def _fallback_deid(text: str, known: dict[str, str]) -> tuple[str, dict[str, int]]:
    counts: dict[str, int] = {}

    def sub(pattern: re.Pattern, label: str, s: str) -> str:
        new, n = pattern.subn(f"[{label}]", s)
        if n:
            counts[label] = counts.get(label, 0) + n
        return new

    for key, value in sorted(known.items(), key=lambda kv: -len(kv[1])):
        variants = {value}
        if key == "name":
            variants |= {p for p in value.split() if len(p) > 2}
        for v in sorted(variants, key=len, reverse=True):
            text = sub(re.compile(re.escape(v), re.IGNORECASE), key.upper(), text)
    for pat, label in ((_SSN, "SSN"), (_EMAIL, "EMAIL"), (_MRN, "ID"), (_PHONE, "PHONE")):
        text = sub(pat, label, text)
    return text, counts


def deidentify(text: str, known: dict[str, str]) -> tuple[str, dict[str, int]]:
    try:
        from app.ai.guardrails.phi import Deidentifier
    except ImportError:
        return _fallback_deid(text, known)
    try:
        # Stored chart text keeps clinical dates: the case date of service and note dates are real, so
        # shifting here would corrupt temporal criteria ("imaging within 60 days of service"). Identifiers and
        # DOB are still removed; date shifting for external LLM calls happens at call time.
        res = Deidentifier(date_policy="keep").deidentify(text, known)
        return res.text, dict(res.counts)
    except Exception:
        log.exception("deidentifier_failed_using_fallback")
        return _fallback_deid(text, known)


async def injection_scan(text: str, source: str) -> tuple[float, str, list[str]]:
    try:
        from app.ai.guardrails.injection import scan_injection
    except ImportError:
        scan_injection = None  # type: ignore[assignment]
    if scan_injection is not None:
        try:
            v = await scan_injection(text, source=source, use_llm=False)
            return float(v.score), v.label, list(v.reasons)
        except Exception:
            log.exception("injection_scan_failed_using_fallback")
    hits = [p.pattern for p in _INJECTION_PATTERNS if p.search(text)]
    score = min(1.0, 0.45 * len(hits))
    label = "malicious" if score >= 0.9 else "suspicious" if hits else "clean"
    return score, label, hits


# ── Persistence ──────────────────────────────────────────────────────────────
async def store_document(
    db: AsyncSession,
    case: Case,
    patient: Patient,
    *,
    kind: str,
    filename: str,
    raw: bytes,
    extracted: Extracted,
    note_date: date | None,
    uploaded_by: uuid.UUID | None,
) -> CaseDocument:
    known = patient_identifiers(patient)
    if extracted.fhir_patient:
        fp = extracted.fhir_patient
        known.update(
            {
                k: str(v)
                for k, v in {
                    "name": fp.get("full_name"),
                    "dob": fp.get("dob"),
                    "mrn": fp.get("mrn"),
                    "phone": fp.get("phone"),
                    "address": fp.get("address"),
                }.items()
                if v
            }
        )
    text_deid, phi_counts = deidentify(extracted.text, known) if extracted.text else ("", {})
    score, label, reasons = (
        await injection_scan(text_deid, source=f"upload:{kind}") if text_deid else (0.0, "clean", [])
    )
    meta = {
        **extracted.meta,
        "phiReplacements": phi_counts,
        "deidPolicy": "identifiers_removed_dates_kept",
        "injection": {"label": label, "reasons": reasons[:5]},
    }
    if extracted.needs_ocr:
        meta["needsOcr"] = True
    doc = CaseDocument(
        org_id=case.org_id,
        case_id=case.id,
        kind=kind,
        filename=filename[:255],
        mime=extracted.mime,
        size_bytes=len(raw),
        sha256=hashlib.sha256(raw).hexdigest(),
        page_count=extracted.page_count,
        text_enc=encrypt_str(extracted.text) if extracted.text else None,
        text_deid=text_deid or None,
        ocr_used=False,
        injection_score=score,
        quarantined=label == "malicious",
        note_date=note_date or extracted.note_date,
        meta=meta,
        uploaded_by=uploaded_by,
    )
    db.add(doc)
    if kind == "fhir_bundle" and not patient.fhir_bundle_enc and len(raw) <= MAX_STORED_BUNDLE_BYTES:
        patient.fhir_bundle_enc = encrypt_str(raw.decode("utf-8"))
    await db.flush()
    await add_event(
        db,
        case,
        "document_added",
        {
            "documentId": str(doc.id),
            "kind": kind,
            "filename": doc.filename,
            "quarantined": doc.quarantined,
            "phiReplacements": sum(phi_counts.values()),
        },
        uploaded_by,
    )
    if doc.quarantined:
        log.warning("document_quarantined", document_id=str(doc.id), score=score)
    return doc


def document_text(doc: CaseDocument, reveal: bool) -> str | None:
    if reveal:
        return decrypt_str(doc.text_enc) if doc.text_enc else None
    return doc.text_deid
