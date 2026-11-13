"""Exports: Markdown, a minimal dependency-free PDF writer, Word-compatible HTML ("docx-lite"),
FHIR QuestionnaireResponse (DTR-like) and a simplified Da Vinci PAS-style Claim bundle."""

from __future__ import annotations

import html
import re
import textwrap
import uuid
from datetime import UTC, datetime

PAGE_W, PAGE_H, MARGIN, LEADING, FONT_SIZE = 612, 792, 54, 14, 10.5
WRAP = 96


def markdown_to_plain(md: str) -> list[tuple[str, bool]]:
    """Very small markdown → (line, bold) list good enough for letters."""
    out: list[tuple[str, bool]] = []
    for raw in (md or "").splitlines():
        line = raw.rstrip()
        bold = False
        if line.startswith("#"):
            line, bold = (
                line.lstrip("#").strip().upper() if line.startswith("# ") else line.lstrip("#").strip(),
                True,
            )
        line = re.sub(r"\*\*(.+?)\*\*", r"\1", line)
        line = re.sub(r"\[\^(F\d+)\]:", r"[\1]", line)
        line = re.sub(r"\[\^(F\d+)\]", r"[\1]", line)
        line = line.replace("  ", " ").replace("> ", "")
        if line.strip() == "---":
            out.append(("", False))
            continue
        if line.startswith("- "):
            wrapped = textwrap.wrap(line[2:], WRAP - 4) or [""]
            out.append(("  • " + wrapped[0], bold))
            out += [("    " + w, bold) for w in wrapped[1:]]
        else:
            out += [(w, bold) for w in (textwrap.wrap(line, WRAP) or [""])]
    return out


def _pdf_str(s: str) -> str:
    s = s.encode("latin-1", "replace").decode("latin-1")
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def to_pdf(md: str, *, title: str = "Necessa document", footer: str | None = None) -> bytes:
    lines = markdown_to_plain(md)
    per_page = int((PAGE_H - 2 * MARGIN - 20) // LEADING)
    pages = [lines[i : i + per_page] for i in range(0, max(1, len(lines)), per_page)] or [[]]
    objs: list[bytes] = []

    def add(obj: str | bytes) -> int:
        objs.append(obj.encode("latin-1") if isinstance(obj, str) else obj)
        return len(objs)

    font_regular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    font_bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    pages_id_placeholder = len(objs) + 1
    add("PAGES")  # placeholder
    page_ids = []
    for n, page in enumerate(pages, start=1):
        y = PAGE_H - MARGIN
        ops = ["BT"]
        for text, bold in page:
            ops.append(
                f"/F{2 if bold else 1} {FONT_SIZE} Tf 1 0 0 1 {MARGIN} {y:.1f} Tm ({_pdf_str(text)}) Tj"
            )
            y -= LEADING
        foot = footer or title
        ops.append(f"/F1 8 Tf 1 0 0 1 {MARGIN} 30 Tm ({_pdf_str(f'{foot} - page {n} of {len(pages)}')}) Tj")
        ops.append("ET")
        stream = "\n".join(ops).encode("latin-1", "replace")
        content = add(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
        page_ids.append(
            add(
                f"<< /Type /Page /Parent {pages_id_placeholder} 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
                f"/Resources << /Font << /F1 {font_regular} 0 R /F2 {font_bold} 0 R >> >> "
                f"/Contents {content} 0 R >>"
            )
        )
    objs[pages_id_placeholder - 1] = (
        f"<< /Type /Pages /Kids [{' '.join(f'{p} 0 R' for p in page_ids)}] /Count {len(page_ids)} >>"
    ).encode()
    info = add(
        f"<< /Title ({_pdf_str(title)}) /Producer (Necessa) /CreationDate "
        f"(D:{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}Z) >>"
    )
    catalog = add(f"<< /Type /Catalog /Pages {pages_id_placeholder} 0 R >>")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    out += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += (
        f"trailer\n<< /Size {len(objs) + 1} /Root {catalog} 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n"  # noqa: E501
    ).encode()
    return bytes(out)


def to_word_html(md: str, title: str) -> bytes:
    body = []
    for line in (md or "").splitlines():
        esc = html.escape(line)
        esc = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", esc)
        if line.startswith("# "):
            body.append(f"<h1>{esc[2:]}</h1>")
        elif line.startswith("## "):
            body.append(f"<h2>{esc[3:]}</h2>")
        elif line.startswith("- "):
            body.append(f"<li>{esc[2:]}</li>")
        elif line.strip():
            body.append(f"<p>{esc}</p>")
    doc = (
        f"<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'>"  # noqa: E501
        f"<head><meta charset='utf-8'><title>{html.escape(title)}</title>"
        "<style>body{font-family:Calibri,Arial;font-size:11pt}h1{font-size:16pt}h2{font-size:13pt}</style>"
        f"</head><body>{''.join(body)}</body></html>"
    )
    return doc.encode("utf-8")


VERDICT_SYSTEM = "urn:necessa:criterion-verdict"


def questionnaire_response(case: dict, evaluation: dict, criteria: list[dict]) -> dict:
    """DTR-style QuestionnaireResponse: one item per policy criterion with the documented answer + evidence."""  # noqa: E501
    items = []
    for c in criteria:
        answers = [
            {"valueCoding": {"system": VERDICT_SYSTEM, "code": c.get("effectiveVerdict") or c.get("verdict")}}
        ]
        answers += [{"valueString": e.get("quote", "")[:500]} for e in (c.get("evidence") or [])[:3]]
        items.append({"linkId": c.get("criterionId"), "text": c.get("text"), "answer": answers})
    return {
        "resourceType": "QuestionnaireResponse",
        "id": str(uuid.uuid4()),
        "status": "completed",
        "questionnaire": "urn:necessa:criteria:"
        + ",".join(p.get("sourceKey") or "" for p in evaluation.get("policies", [])),
        "subject": {"reference": f"Patient/{case.get('patientId')}", "display": "de-identified"},
        "authored": datetime.now(UTC).isoformat(),
        "meta": {"tag": [{"system": "urn:necessa:readiness", "code": evaluation.get("readiness")}]},
        "item": items,
    }


def pas_claim_bundle(case: dict, evaluation: dict, criteria: list[dict], letters: list[dict]) -> dict:
    """Simplified Da Vinci PAS-style Bundle (Claim use=preauthorization + supporting info). Not for live submission."""  # noqa: E501
    claim_id, qr = str(uuid.uuid4()), questionnaire_response(case, evaluation, criteria)
    supporting = [
        {
            "sequence": 1,
            "category": {"text": "questionnaireResponse"},
            "valueReference": {"reference": f"QuestionnaireResponse/{qr['id']}"},
        }
    ]
    doc_entries = []
    for i, letter in enumerate(letters, start=2):
        did = str(uuid.uuid4())
        doc_entries.append(
            {
                "fullUrl": f"urn:uuid:{did}",
                "resource": {
                    "resourceType": "DocumentReference",
                    "id": did,
                    "status": "current",
                    "type": {"text": letter.get("title")},
                    "content": [
                        {"attachment": {"contentType": "text/markdown", "title": letter.get("title")}}
                    ],
                },
            }
        )
        supporting.append(
            {
                "sequence": i,
                "category": {"text": "attachment"},
                "valueReference": {"reference": f"DocumentReference/{did}"},
            }
        )
    claim = {
        "resourceType": "Claim",
        "id": claim_id,
        "status": "active",
        "use": "preauthorization",
        "type": {
            "coding": [{"system": "http://terminology.hl7.org/CodeSystem/claim-type", "code": "professional"}]
        },
        "patient": {"reference": f"Patient/{case.get('patientId')}"},
        "created": datetime.now(UTC).isoformat(),
        "insurer": {"display": case.get("payerName") or case.get("payerType")},
        "provider": {"display": "Requesting provider"},
        "priority": {"coding": [{"code": "stat" if case.get("priority") == "expedited" else "normal"}]},
        "diagnosis": [
            {
                "sequence": i + 1,
                "diagnosisCodeableConcept": {
                    "coding": [{"system": "http://hl7.org/fhir/sid/icd-10-cm", "code": d}]
                },
            }
            for i, d in enumerate(case.get("dxCodes", []))
        ],
        "item": [
            {
                "sequence": i + 1,
                "productOrService": {"coding": [{"code": s}]},
                "servicedDate": case.get("dateOfService"),
            }
            for i, s in enumerate(case.get("serviceCodes", []))
        ],
        "supportingInfo": supporting,
        "insurance": [
            {"sequence": 1, "focal": True, "coverage": {"display": case.get("payerName") or "coverage"}}
        ],
    }
    return {
        "resourceType": "Bundle",
        "id": str(uuid.uuid4()),
        "type": "collection",
        "timestamp": datetime.now(UTC).isoformat(),
        "entry": [
            {"fullUrl": f"urn:uuid:{claim_id}", "resource": claim},
            {"fullUrl": f"urn:uuid:{qr['id']}", "resource": qr},
            *doc_entries,
        ],
    }
