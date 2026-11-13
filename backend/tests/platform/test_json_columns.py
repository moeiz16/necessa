"""JSON columns accept the value types real evaluation payloads contain (dates, enums, UUIDs)."""

from __future__ import annotations

import enum
import uuid
from datetime import UTC, date, datetime

from app.db.session import _json_dumps


class _Verdict(str, enum.Enum):
    MET = "MET"


def test_json_serializer_handles_domain_types():
    payload = {
        "noteDate": date(2026, 11, 2),
        "at": datetime(2026, 11, 2, 9, 30, tzinfo=UTC),
        "id": uuid.UUID("12345678-1234-5678-1234-567812345678"),
        "verdict": _Verdict.MET,
        1: "non-string key",
    }
    out = _json_dumps(payload)
    assert '"noteDate":"2026-11-02"' in out
    assert '"verdict":"MET"' in out
    assert '"id":"12345678-1234-5678-1234-567812345678"' in out
    assert '"1":"non-string key"' in out
