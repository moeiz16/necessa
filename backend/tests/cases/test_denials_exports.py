import json
from datetime import date
from io import BytesIO

from app.ai.drafting.denials import appeal_deadline, categorize, extract_codes, map_reason_to_criteria
from app.ai.drafting.exports import pas_claim_bundle, questionnaire_response, to_pdf, to_word_html


def test_carc_rarc_extraction():
    text = "Claim adjusted CO-50 and PR 204. RARC N115, M127, MA130. Diagnosis M17.11 is not a RARC."
    carc, rarc = extract_codes(text)
    assert carc == ["CO-50", "PR-204"]
    assert rarc == ["N115", "M127", "MA130"]
    assert extract_codes("reason code 197 applied")[0] == ["197"]


def test_categorize_and_deadlines():
    assert categorize("", ["CO-50"]) == "medical_necessity"
    assert categorize("", ["CO-197"]) == "prior_authorization"
    assert categorize("missing documentation of therapy", []) == "documentation"
    assert categorize("filed late", []) == "timely_filing"
    assert appeal_deadline(date(2026, 1, 1), "medicare_ffs") == date(2026, 5, 1)
    assert appeal_deadline(None, "commercial") is None


def test_reason_mapping_prefers_unmet_criteria():
    crit = [
        {
            "criterionId": "K:C4",
            "text": "No advanced osteoarthritis Kellgren-Lawrence grade 3 or 4",
            "verdict": "NOT_MET",
        },
        {"criterionId": "K:C1", "text": "Mechanical symptoms such as locking", "verdict": "MET"},
    ]
    out = map_reason_to_criteria("Radiographs show advanced osteoarthritis Kellgren-Lawrence grade 4", crit)
    assert out[0]["criterionId"] == "K:C4" and out[0]["confidence"] > 0.5


def test_pdf_is_valid_and_contains_text():
    from pypdf import PdfReader

    md = "# Letter of Medical Necessity\n\n**Re:** test (with parens) \\ slash\n\n- point one\n" + "\n".join(
        f"Line {i} of a long letter body." for i in range(120)
    )
    pdf = to_pdf(md, title="Test")
    assert pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF")
    reader = PdfReader(BytesIO(pdf))
    assert len(reader.pages) >= 2
    assert "LETTER OF MEDICAL NECESSITY" in reader.pages[0].extract_text()


def test_word_html_and_fhir():
    assert b"<h1>T</h1>" in to_word_html("# T\n\nbody", "T")
    case = {
        "patientId": "p1",
        "payerName": "Plan",
        "priority": "expedited",
        "dxCodes": ["G47.33"],
        "serviceCodes": ["E0601"],
        "dateOfService": "2026-12-01",
    }
    ev = {"readiness": "ready", "policies": [{"sourceKey": "L33718"}]}
    crit = [
        {"criterionId": "L33718:C1", "text": "x", "effectiveVerdict": "MET", "evidence": [{"quote": "q"}]}
    ]
    qr = questionnaire_response(case, ev, crit)
    assert (
        qr["resourceType"] == "QuestionnaireResponse"
        and qr["item"][0]["answer"][0]["valueCoding"]["code"] == "MET"
    )
    bundle = pas_claim_bundle(case, ev, crit, [{"title": "LMN"}])
    claim = bundle["entry"][0]["resource"]
    assert claim["use"] == "preauthorization" and claim["priority"]["coding"][0]["code"] == "stat"
    json.dumps(bundle)
