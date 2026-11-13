from __future__ import annotations

import pyotp

from tests.conftest import PASSWORD, csrf, signup, signup_with_org, unique_email


async def test_signup_onboarding_and_me(client):
    acct = await signup(client)
    me = (await client.get("/api/v1/auth/me")).json()
    assert me["user"]["email"] == acct.email
    assert me["activeOrg"] is None and me["membership"] is None and me["orgs"] == []

    r = await acct.post(
        "/api/v1/orgs", json={"name": "Lakeside Spine", "states": ["tx"], "practiceType": "asc"}
    )
    assert r.status_code == 201, r.text
    assert r.json()["states"] == ["TX"]
    me = (await client.get("/api/v1/auth/me")).json()
    assert me["activeOrg"]["name"] == "Lakeside Spine"
    assert me["membership"]["role"] == "owner"
    assert "org:admin" in me["membership"]["permissions"]
    r = await acct.post("/api/v1/orgs/current/onboarding/complete")
    assert r.json()["onboardingCompletedAt"] is not None


async def test_signup_rejects_duplicate_and_weak_password(client, make_client):
    acct = await signup(client)
    r = await make_client().post(
        "/api/v1/auth/signup", json={"email": acct.email.upper(), "password": PASSWORD, "fullName": "X"}
    )
    assert r.status_code == 409 and r.json()["code"] == "email_taken"
    r = await make_client().post(
        "/api/v1/auth/signup", json={"email": unique_email(), "password": "short", "fullName": "X"}
    )
    assert r.status_code == 422 and r.json()["code"] == "weak_password"
    assert r.headers["content-type"].startswith("application/problem+json")


async def test_login_success_and_generic_failure(client, make_client):
    acct = await signup_with_org(client)
    c2 = make_client()
    bad = await c2.post("/api/v1/auth/login", json={"email": acct.email, "password": "wrong-password-123"})
    assert bad.status_code == 401 and bad.json()["code"] == "invalid_credentials"
    unknown = await c2.post(
        "/api/v1/auth/login", json={"email": unique_email(), "password": "whatever-123456"}
    )
    assert unknown.json()["detail"] == bad.json()["detail"]  # no user enumeration
    ok = await c2.post("/api/v1/auth/login", json={"email": acct.email, "password": PASSWORD})
    assert ok.status_code == 200
    assert ok.json()["activeOrgId"] == acct.org["id"]
    assert (await c2.get("/api/v1/cases")).status_code == 200


async def test_unauthenticated_and_csrf(client):
    assert (await client.get("/api/v1/auth/me")).status_code == 401
    acct = await signup_with_org(client)
    # Cookie-authenticated mutation without the CSRF header is rejected.
    r = await client.patch("/api/v1/users/me", json={"title": "PA Lead"})
    assert r.status_code == 403 and r.json()["code"] == "csrf_failed"
    r = await acct.patch("/api/v1/users/me", json={"title": "PA Lead"})
    assert r.status_code == 200 and r.json()["title"] == "PA Lead"


async def test_refresh_rotation_and_reuse_detection(client, make_client):
    await signup_with_org(client)
    old_rt = client.cookies.get("necessa_rt", path="/api/v1/auth")
    r = await client.post("/api/v1/auth/refresh", headers=csrf(client))
    assert r.status_code == 200
    new_rt = client.cookies.get("necessa_rt", path="/api/v1/auth")
    assert new_rt and new_rt != old_rt

    async def refresh_with(token: str) -> int:
        attacker = make_client()  # empty cookie jar; replay a captured token explicitly
        hdr = {"Cookie": f"necessa_rt={token}; necessa_csrf=x", "X-CSRF-Token": "x"}
        return (await attacker.post("/api/v1/auth/refresh", headers=hdr)).status_code

    # Replaying the superseded token revokes the whole session family ...
    assert await refresh_with(old_rt) == 401
    # ... so even the legitimate latest token and the current access token stop working.
    assert await refresh_with(new_rt) == 401
    assert (await client.get("/api/v1/auth/me")).status_code == 401


async def test_logout_revokes_session(client):
    await signup_with_org(client)
    r = await client.post("/api/v1/auth/logout", headers=csrf(client))
    assert r.status_code == 204
    assert (await client.get("/api/v1/auth/me")).status_code == 401


async def test_password_reset_flow(client, make_client):
    acct = await signup(client)
    r = await make_client().post("/api/v1/auth/password/forgot", json={"email": acct.email})
    assert r.status_code == 202
    token = r.json()["devLink"].split("token=")[1]
    anon = make_client()
    new_pw = "Brand-New-Passphrase-77"
    assert (
        await anon.post("/api/v1/auth/password/reset", json={"token": token, "password": new_pw})
    ).status_code == 204
    # Link is single-use: it's bound to the old password hash.
    again = await anon.post(
        "/api/v1/auth/password/reset", json={"token": token, "password": "Another-Pass-9988"}
    )
    assert again.status_code == 400
    assert (await client.get("/api/v1/auth/me")).status_code == 401  # existing sessions revoked
    ok = await anon.post("/api/v1/auth/login", json={"email": acct.email, "password": new_pw})
    assert ok.status_code == 200


async def test_forgot_password_unknown_email_is_silent(client):
    r = await client.post("/api/v1/auth/password/forgot", json={"email": unique_email()})
    assert r.status_code == 202 and r.json() == {"ok": True}


async def test_mfa_enrollment_login_and_recovery(client, make_client):
    acct = await signup_with_org(client)
    setup = (await acct.post("/api/v1/auth/mfa/setup")).json()
    assert setup["otpauthUrl"].startswith("otpauth://totp/")
    bad = await acct.post("/api/v1/auth/mfa/verify", json={"code": "000000"})
    assert bad.status_code == 400
    r = await acct.post("/api/v1/auth/mfa/verify", json={"code": pyotp.TOTP(setup["secret"]).now()})
    assert r.status_code == 200
    recovery = r.json()["recoveryCodes"]
    assert len(recovery) == 8

    c2 = make_client()
    r = await c2.post("/api/v1/auth/login", json={"email": acct.email, "password": PASSWORD})
    assert r.json()["mfaRequired"] is True and r.json()["user"] is None
    assert (await c2.get("/api/v1/auth/me")).status_code == 401
    r = await c2.post(
        "/api/v1/auth/login",
        json={"email": acct.email, "password": PASSWORD, "mfaCode": pyotp.TOTP(setup["secret"]).now()},
    )
    assert r.status_code == 200 and r.json()["user"]["mfaEnabled"] is True

    c3 = make_client()
    r = await c3.post(
        "/api/v1/auth/login", json={"email": acct.email, "password": PASSWORD, "mfaCode": recovery[0]}
    )
    assert r.status_code == 200
    c4 = make_client()
    r = await c4.post(
        "/api/v1/auth/login", json={"email": acct.email, "password": PASSWORD, "mfaCode": recovery[0]}
    )
    assert r.status_code == 401  # recovery codes are single use


async def test_sessions_list_and_revoke(client, make_client):
    acct = await signup_with_org(client)
    other = make_client()
    await other.post("/api/v1/auth/login", json={"email": acct.email, "password": PASSWORD})
    sessions = (await client.get("/api/v1/auth/sessions")).json()
    assert len(sessions) == 2 and sum(s["current"] for s in sessions) == 1
    other_id = next(s["id"] for s in sessions if not s["current"])
    assert (await acct.delete(f"/api/v1/auth/sessions/{other_id}")).status_code == 204
    assert (await other.get("/api/v1/auth/me")).status_code == 401


async def test_switch_org(client):
    acct = await signup_with_org(client, "First Org")
    second = (await acct.post("/api/v1/orgs", json={"name": "Second Org"})).json()
    first_id = acct.org["id"]
    me = (await acct.post("/api/v1/auth/switch-org", json={"orgId": first_id})).json()
    assert me["activeOrg"]["id"] == first_id and len(me["orgs"]) == 2
    me = (await acct.post("/api/v1/auth/switch-org", json={"orgId": second["id"]})).json()
    assert me["activeOrg"]["id"] == second["id"]
