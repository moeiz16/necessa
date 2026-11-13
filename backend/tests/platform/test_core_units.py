"""Unit tests for core primitives (no HTTP)."""

from __future__ import annotations

import asyncio
import uuid

import pytest

from app.core.crypto import decrypt_json, encrypt_json
from app.core.errors import AppError
from app.core.events import EventBus
from app.core.logging import redact_processor
from app.core.permissions import permissions_for, role_has
from app.core.security import (
    create_access_token,
    decode_access_token,
    generate_api_key,
    hash_password,
    parse_refresh_token,
    validate_password_strength,
    verify_password,
)
from app.services.cases import TRANSITIONS, mask_name
from app.services.documents import _fallback_deid, sniff_mime


def test_password_hashing_and_policy():
    h = hash_password("Correct-Horse-Battery-42")
    assert h.startswith("$argon2id$") and verify_password("Correct-Horse-Battery-42", h)
    assert not verify_password("nope", h) and not verify_password("x", None)
    with pytest.raises(AppError):
        validate_password_strength("aaaaaaaaaaaaaaaa")


def test_access_token_roundtrip_and_tamper():
    uid, oid, sid = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    claims = decode_access_token(create_access_token(uid, oid, sid))
    assert (claims.user_id, claims.org_id, claims.session_id) == (uid, oid, sid)
    token = create_access_token(uid, None, None)
    with pytest.raises(AppError):
        decode_access_token(token[:-2] + ("A" if token[-2] != "A" else "B") + token[-1])
    with pytest.raises(AppError):
        parse_refresh_token("not-a-token")


def test_api_key_format():
    secret, prefix, digest = generate_api_key()
    assert secret.startswith("nk_live_") and secret.startswith(prefix) and len(digest) == 64


def test_phi_encryption_roundtrip():
    token = encrypt_json({"fullName": "Jordan Doe", "dob": "1951-04-12"})
    assert "Jordan" not in token
    assert decrypt_json(token)["fullName"] == "Jordan Doe"


def test_permissions_matrix():
    assert role_has("auditor", "audit:read") and not role_has("auditor", "cases:write")
    assert "letters:approve" in permissions_for("clinician")
    assert permissions_for(None) == []


def test_state_machine_is_closed_under_known_statuses():
    from app.db.models.cases import CASE_STATUSES

    for src, targets in TRANSITIONS.items():
        assert src in CASE_STATUSES and targets <= set(CASE_STATUSES)
    assert all("closed" in t for s, t in TRANSITIONS.items() if s != "closed")


def test_log_redaction():
    out = redact_processor(
        None,
        "info",
        {
            "event": "login for jane.doe@clinic.org with 123-45-6789",
            "password": "hunter2",
            "authorization": "Bearer abc.def",
            "ok": "fine",
            "nested": {"api_key": "k"},
        },
    )
    assert out["password"] == "[redacted]" and out["authorization"] == "[redacted]"  # noqa: S105
    assert "jane.doe@" not in out["event"] and "123-45-6789" not in out["event"]
    assert out["nested"]["api_key"] == "[redacted]" and out["ok"] == "fine"


def test_fallback_deidentification():
    text, counts = _fallback_deid(
        "Jordan Doe, MRN: AB12345, call 614-555-0142 or jd@mail.com; SSN 123-45-6789. Saw Dr. Smith.",
        {"name": "Jordan Doe"},
    )
    for s in ("Jordan", "AB12345", "614-555-0142", "jd@mail.com", "123-45-6789"):
        assert s not in text
    assert "Dr. Smith" in text and counts["NAME"] >= 1


def test_mime_sniffing_and_masking():
    assert sniff_mime(b"%PDF-1.7 ...", "a.pdf", None) == "application/pdf"
    assert sniff_mime(b'{"resourceType":"Bundle"}', "b.json", None) == "application/fhir+json"
    with pytest.raises(AppError):
        sniff_mime(b"\x7fELF....", "x", None)
    assert mask_name("Jordan Avery Doe") == "J. D." and mask_name("Cher") == "C."


async def test_event_bus_fanout_and_recent():
    bus = EventBus()
    received: list[tuple[str, dict]] = []

    async def consume():
        stream = bus.subscribe("case:1")
        try:
            async for item in stream:
                received.append(item)
                if len(received) == 2:
                    return
        finally:
            await stream.aclose()  # type: ignore[attr-defined]

    task = asyncio.create_task(consume())
    await asyncio.sleep(0)
    await bus.publish("case:1", "criterion.verdict", {"n": 1})
    await bus.publish("case:1", "evaluation.completed", {"n": 2})
    await asyncio.wait_for(task, 1)
    assert [e for e, _ in received] == ["criterion.verdict", "evaluation.completed"]
    assert len(bus.recent("case:1")) == 2 and bus.subscriber_count("case:1") == 0
