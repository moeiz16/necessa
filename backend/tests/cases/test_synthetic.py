from datetime import date

from app.ai.compiler.curated import load_curated
from app.ai.synthetic.notes import EXPECTED, build_case, ocr_noise
from app.ai.synthetic.patients import fhir_bundle, make_patient

DOS = date(2026, 12, 1)


def test_patient_is_deterministic_and_obviously_fake():
    a, b = make_patient("seed-1", today=DOS), make_patient("seed-1", today=DOS)
    assert a == b
    assert a.phone.startswith("(555) 01") and a.mrn.startswith("SYN-")
    assert (
        make_patient("seed-2", today=DOS).full_name != a.full_name
        or make_patient("seed-2", today=DOS).mrn != a.mrn
    )


def test_fhir_bundle_shape():
    p = make_patient(3, today=DOS)
    b = fhir_bundle(
        p,
        payer_name="Medicare",
        payer_type="medicare_ffs",
        dx_codes=["G47.33"],
        service_codes=["E0601"],
        documents=[{"note_date": DOS, "title": "Note", "text": "hello"}],
        date_of_service=DOS,
        seed=1,
    )
    types = [e["resource"]["resourceType"] for e in b["entry"]]
    for t in ("Patient", "Coverage", "Condition", "ServiceRequest", "MedicationRequest", "DocumentReference"):
        assert t in types
    assert b["meta"]["tag"][0]["code"] == "synthetic"


def test_counterfactual_labels_and_determinism():
    tree = load_curated()["L33718"]
    p = make_patient(9, today=DOS)
    variants = {"C1": "buried", "C2": "contradicted", "C6": "negated", "C7": "removed"}
    a = build_case([tree], p, seed="x", date_of_service=DOS, variants=variants)
    b = build_case([tree], p, seed="x", date_of_service=DOS, variants=variants)
    assert [d["text"] for d in a.documents] == [d["text"] for d in b.documents]
    plan = a.truth()
    assert plan["L33718:C2"].expected == EXPECTED["contradicted"] == {"NOT_MET"}
    assert plan["L33718:C7"].inserted_text is None
    assert plan["L33718:C6"].expected == {"NOT_MET", "INSUFFICIENT"}
    # OR alternatives (AHI 5-14 path) are not documented by default when the primary path is
    assert plan["L33718:C3"].variant == "removed"
    # OR(C2 contradicted, AND(C3 undocumented, …)) = INSUFFICIENT under Kleene logic: the AHI 5-14 path is unknown  # noqa: E501
    assert a.expected_tree_verdict == "INSUFFICIENT" and a.expected_readiness == "gaps"
    buried = next(d for d in a.documents if d["title"] == "Comprehensive visit note")
    assert plan["L33718:C1"].inserted_text in buried["text"] and len(buried["text"]) > 900
    # PHI is present in raw synthetic notes so de-identification is exercised
    assert p.full_name in a.documents[0]["text"]


def test_wrong_date_window_only_for_lookback_criteria():
    tree = load_curated()["PAYER-SYNHP-MP0101"]
    case = build_case(
        [tree],
        make_patient(1, today=DOS),
        seed="w",
        date_of_service=DOS,
        variants={"C3": "wrong_date_window", "C1": "wrong_date_window"},
    )
    plan = case.truth()
    assert plan["PAYER-SYNHP-MP0101:C3"].variant == "wrong_date_window"
    assert (DOS - plan["PAYER-SYNHP-MP0101:C3"].note_date).days > 183
    assert plan["PAYER-SYNHP-MP0101:C1"].variant == "removed"  # no lookback → falls back


def test_ocr_noise_keeps_digits():
    import random

    s = "AHI 23.4 events per hour, the clinician noted"
    noisy = ocr_noise(s, random.Random(1))  # noqa: S311
    assert "23.4" in noisy
