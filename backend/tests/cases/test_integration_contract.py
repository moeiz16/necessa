"""Contract checks for endpoints the web app relies on: pre-case suggestions and audited PHI reveal."""

from __future__ import annotations

import uuid

import pytest

from tests.conftest import create_case, signup_with_org

pytestmark = pytest.mark.asyncio


async def test_draft_policy_suggestions_before_case_exists(client):
    acct = await signup_with_org(client)
    r = await acct.post(
        "/api/v1/cases/policy-suggestions",
        json={"serviceCodes": ["E0601"], "dxCodes": ["G47.33"], "state": "oh", "payerType": "medicare_ffs"},
    )
    assert r.status_code == 200, r.text
    matches = r.json()["matches"]
    # Curated PAP criteria apply to Medicare PAP requests even before the knowledge base is ingested.
    assert any(m.get("sourceKey") == "L33718" for m in matches)


async def test_draft_policy_suggestions_validates_input(client):
    acct = await signup_with_org(client)
    r = await acct.post("/api/v1/cases/policy-suggestions", json={"state": "OHIO"})
    assert r.status_code == 422


async def test_case_detail_reveal_is_permissioned_and_audited(client):
    acct = await signup_with_org(client)
    case = await create_case(acct)
    masked = (await acct.get(f"/api/v1/cases/{case['id']}")).json()
    assert masked.get("patientRevealed") is None

    revealed = await acct.get(
        f"/api/v1/cases/{case['id']}", params={"reveal": "true", "reason": "Preparing PA submission"}
    )
    assert revealed.status_code == 200, revealed.text
    assert set(revealed.json()["patientRevealed"]) == {"fullName", "dob", "memberId", "mrn"}

    log = await acct.get("/api/v1/audit", params={"action": "phi.patient_revealed"})
    assert log.status_code == 200
    entry = next(e for e in log.json()["items"] if e["action"] == "phi.patient_revealed")
    assert entry["metadata"]["reason"] == "Preparing PA submission"


async def test_unknown_case_reveal_is_404(client):
    acct = await signup_with_org(client)
    r = await acct.get(f"/api/v1/cases/{uuid.uuid4()}", params={"reveal": "true"})
    assert r.status_code == 404
