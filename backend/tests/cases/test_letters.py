"""Letter drafting safety: verified facts only, audit removes invented facts, no PHI to the model."""

from __future__ import annotations

from app.ai.drafting.letters import (
    Fact,
    FactSheet,
    audit_draft,
    generate_letter_text,
    mask,
    rehydrate,
    template_letter,
)


def sheet() -> FactSheet:
    return FactSheet(
        facts=[
            Fact(
                "F1",
                "Completed 8 weeks of physical therapy (2x weekly) and meloxicam 15 mg daily",
                "K:C2",
                "Conservative therapy",
            ),
            Fact(
                "F2",
                "MRI right knee: complex tear of the posterior horn of the medial meniscus",
                "K:C3",
                "MRI",
            ),
        ],
        gaps=[{"title": "Functional limitation"}],
        policies=[{"sourceKey": "PAYER-SYNHP-MP0101", "title": "Knee Arthroscopy", "version": 3}],
        header={
            "service_codes": "29881",
            "dx_codes": "S83.241A",
            "date_of_service": "2026-12-01",
            "payer_name": "Synthetic Health Plan",
            "payer_type": "commercial",
            "number": "NC-2026-00001",
        },
    )


def test_audit_removes_unsupported_facts_and_predictions():
    md = (
        "The patient completed 8 weeks of physical therapy.[^F1] "
        "The patient also had 14 weeks of chiropractic care in 2019. "
        "This request will be approved. MRI confirms a tear.[^F2] Unknown ref.[^F7]"
    )
    out = audit_draft(md, sheet())
    assert "14 weeks" not in out.text and "2019" not in out.text
    assert "will be approved" not in out.text
    assert "8 weeks" in out.text and "[^F2]" in out.text and "[^F7]" not in out.text
    assert len(out.removed_sentences) == 2 and out.unknown_footnotes == ["F7"]


def test_template_letter_has_placeholders_and_footnotes():
    md = template_letter("lmn", sheet())
    assert "<<PATIENT_NAME>>" in md and "[^F1]" in md
    assert "Functional limitation" in md  # internal gap note


async def test_generate_letter_with_fake_router_streams_and_audits():
    class Router:
        def is_available(self, group):
            return True

        async def stream(self, **kw):
            prompt = kw["messages"][0]["content"]
            assert "Avery" not in prompt and "<<PATIENT_NAME>>" in prompt  # no PHI, placeholders only
            for piece in [
                "# LMN\n\nDear reviewer, <<PATIENT_NAME>> completed 8 weeks of physical therapy.[^F1] ",
                "She also had surgery on 03/03/2021 [NAME_1]. Coverage is guaranteed.",
            ]:
                yield piece

    tokens: list[str] = []

    async def on_token(t):
        tokens.append(t)

    body, info = await generate_letter_text(Router(), "lmn", sheet(), on_token=on_token)
    assert info["source"] == "llm" and tokens
    assert "03/03/2021" not in body and "[NAME_1]" not in body and "guaranteed" not in body
    assert "Supporting documentation" in body and "[^F1]:" in body


async def test_template_fallback_without_router():
    body, info = await generate_letter_text(
        None, "appeal", sheet(), denial={"received_at": "2026-11-10", "category": "medical_necessity"}
    )
    assert info["source"] == "template" and "Reason for appeal" in body


def test_rehydrate_and_mask_roundtrip():
    from app.api.v1.case_ai import unmask

    md = "Re: <<PATIENT_NAME>> · DOB <<PATIENT_DOB>>"
    assert (
        rehydrate(md, {"PATIENT_NAME": "Avery Sampleton", "PATIENT_DOB": "1956-03-14"})
        == "Re: Avery Sampleton · DOB 1956-03-14"
    )
    masked = mask(md)
    assert "«Patient Name»" in masked and unmask(masked) == md
