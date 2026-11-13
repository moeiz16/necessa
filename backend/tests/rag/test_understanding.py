from datetime import date

import pytest

from app.ai.cache import entity_signature
from app.ai.retrieval.intents import classify_rules
from app.ai.retrieval.understanding import understand


def test_entity_extraction():
    a = understand(
        "Is M17.11 covered for 29881 under LCD L33718 in Texas as of 2026-03-01? Also E0601 and NCD 240.4"
    )
    assert a.lcd_ids == ["33718"] and a.ncd_sections == ["240.4"]
    assert "29881" in a.cpt and "E0601" in a.hcpcs and a.icd10 == ["M17.11"]
    assert a.states == ["TX"] and a.as_of == date(2026, 3, 1)


def test_abbreviations_expand_only_uppercase_and_lay_terms_map():
    a = understand("Does the PT requirement apply? pt reports pain")
    assert "physical therapy" in a.expanded
    b = understand("my mom needs a sleep apnea machine")
    assert b.lay_terms and "E0601" in b.synonym_expansion


def test_ambiguous_state_abbreviations_need_context():
    assert understand("Is it OK to bill").states == []
    assert understand("coverage in OH for 64561").states == ["OH"]


@pytest.mark.parametrize(
    "q,intent",
    [
        ("What is LCD L33718?", "exact_lookup"),
        ("E0601", "exact_lookup"),
        ("Which LCDs list 64561 in Ohio?", "structured_fact"),
        ("Top 5 gap criteria across my cases this month", "analytics"),
        ("What changed in L33718 since last year?", "version_compare"),
        ("Claim denied for missing conservative therapy documentation", "denial_mapping"),
        ("Is M17.11 covered for 29881 in Texas and what documentation is needed?", "multi_hop"),
        ("nerve zapper for overactive bladder", "lay_language"),
        ("Should I prescribe gabapentin for this patient?", "out_of_scope"),
        ("What conservative therapy is required before knee arthroscopy?", "conceptual"),
    ],
)
def test_rule_intents(q, intent):
    assert classify_rules(understand(q)).intent == intent


def test_semantic_cache_signature_distinguishes_contrast():
    a = entity_signature(
        "MRI knee with contrast criteria", codes=["73722"], payer_type=None, states=None, as_of=None
    )
    b = entity_signature(
        "MRI knee without contrast criteria", codes=["73722"], payer_type=None, states=None, as_of=None
    )
    assert a != b
    c = entity_signature(
        "criteria for MRI knee with contrast", codes=["73722"], payer_type=None, states=None, as_of=None
    )
    assert a == c
