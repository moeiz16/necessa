from __future__ import annotations

from tests.conftest import PASSWORD, add_member, create_case, signup, signup_with_org, unique_email


async def test_org_settings_validation(client):
    owner = await signup_with_org(client)
    r = await owner.patch(
        "/api/v1/orgs/current", json={"settings": {"slaHoursExpedited": 48, "requireMfa": True}}
    )
    assert r.status_code == 200
    assert r.json()["settings"]["slaHoursExpedited"] == 48 and r.json()["settings"]["slaHoursStandard"] == 168
    r = await owner.patch("/api/v1/orgs/current", json={"settings": {"slaHoursExpedited": 0}})
    assert r.status_code == 422 and r.json()["code"] == "invalid_setting"
    r = await owner.patch("/api/v1/orgs/current", json={"settings": {"bogus": 1}})
    assert r.status_code == 422 and r.json()["code"] == "unknown_setting"
    r = await owner.patch("/api/v1/orgs/current", json={"states": ["ZZ"]})
    assert r.status_code == 422


async def test_invitation_flow_and_rbac(client, make_client):
    owner = await signup_with_org(client)
    coord = await add_member(owner, make_client(), "coordinator")
    assert coord.org["id"] == owner.org["id"]
    me = (await coord.get("/api/v1/auth/me")).json()
    assert me["membership"]["role"] == "coordinator"
    assert "org:admin" not in me["membership"]["permissions"]

    # Coordinators can work cases but cannot administer the org.
    assert (await coord.patch("/api/v1/orgs/current", json={"name": "Hijacked"})).status_code == 403
    assert (await coord.post("/api/v1/orgs/current/api-keys", json={"name": "k"})).status_code == 403
    assert (await coord.get("/api/v1/audit")).status_code == 403
    assert (
        await coord.post("/api/v1/cases", json={"patient": {"fullName": "A B", "dob": "1950-01-01"}})
    ).status_code == 201

    auditor = await add_member(owner, make_client(), "auditor")
    assert (await auditor.get("/api/v1/audit")).status_code == 200
    assert (
        await auditor.post("/api/v1/cases", json={"patient": {"fullName": "A B", "dob": "1950-01-01"}})
    ).status_code == 403

    members = (await owner.get("/api/v1/orgs/current/members")).json()
    assert {m["role"] for m in members} == {"owner", "coordinator", "auditor"}


async def test_invitation_validation(client, make_client):
    owner = await signup_with_org(client)
    email = unique_email("dup")
    first = (
        await owner.post("/api/v1/orgs/current/invitations", json={"email": email, "role": "reviewer"})
    ).json()
    second = (
        await owner.post("/api/v1/orgs/current/invitations", json={"email": email, "role": "reviewer"})
    ).json()
    old_token = first["devLink"].rsplit("/", 1)[1]
    assert (await make_client().get(f"/api/v1/invitations/{old_token}")).status_code == 404  # superseded
    new_token = second["devLink"].rsplit("/", 1)[1]
    info = (await make_client().get(f"/api/v1/invitations/{new_token}")).json()
    assert info["email"] == email and info["accountExists"] is False

    # A different signed-in user cannot accept someone else's invitation.
    stranger = await signup(make_client())
    r = await stranger.post(f"/api/v1/invitations/{new_token}/accept", json={})
    assert r.status_code == 403
    r = await make_client().post(f"/api/v1/invitations/{new_token}/accept", json={})
    assert r.status_code == 422 and r.json()["code"] == "details_required"

    inv_id = second["invitation"]["id"]
    assert (await owner.delete(f"/api/v1/orgs/current/invitations/{inv_id}")).status_code == 204
    assert (await make_client().get(f"/api/v1/invitations/{new_token}")).status_code == 404


async def test_existing_user_accepts_with_password(client, make_client):
    owner = await signup_with_org(client)
    existing = await signup(make_client())
    r = await owner.post(
        "/api/v1/orgs/current/invitations", json={"email": existing.email, "role": "clinician"}
    )
    token = r.json()["devLink"].rsplit("/", 1)[1]
    fresh = make_client()
    r = await fresh.post(f"/api/v1/invitations/{token}/accept", json={"password": "wrong-password-xyz"})
    assert r.status_code == 401 and r.json()["code"] == "login_required"
    r = await fresh.post(f"/api/v1/invitations/{token}/accept", json={"password": PASSWORD})
    assert r.status_code == 200 and r.json()["membership"]["role"] == "clinician"


async def test_last_owner_protection(client, make_client):
    owner = await signup_with_org(client)
    me = (await owner.get("/api/v1/auth/me")).json()
    uid = me["user"]["id"]
    r = await owner.patch(f"/api/v1/orgs/current/members/{uid}", json={"role": "admin"})
    assert r.status_code == 409 and r.json()["code"] == "last_owner"
    admin = await add_member(owner, make_client(), "admin")
    r = await admin.patch(f"/api/v1/orgs/current/members/{uid}", json={"role": "coordinator"})
    assert r.status_code == 403  # only owners may change owners
    r = await admin.delete(f"/api/v1/orgs/current/members/{admin.user['id']}")
    assert r.status_code == 204


async def test_api_keys_scopes_and_revocation(client, make_client):
    owner = await signup_with_org(client)
    await create_case(owner)
    r = await owner.post(
        "/api/v1/orgs/current/api-keys", json={"name": "EHR bridge", "scopes": ["org:admin"]}
    )
    assert r.status_code == 422 and r.json()["code"] == "invalid_scope"
    r = await owner.post(
        "/api/v1/orgs/current/api-keys", json={"name": "EHR bridge", "scopes": ["cases:read", "cases:write"]}
    )
    assert r.status_code == 201
    secret, key_id = r.json()["secret"], r.json()["apiKey"]["id"]
    assert secret.startswith("nk_live_") and r.json()["apiKey"]["prefix"] == secret[:14]

    bot = make_client()
    auth = {"Authorization": f"Bearer {secret}"}
    listed = await bot.get("/api/v1/cases", headers=auth)
    assert listed.status_code == 200 and listed.json()["total"] == 1
    # Bearer requests are not subject to cookie CSRF, but scopes still apply.
    assert (
        await bot.post(
            "/api/v1/cases", headers=auth, json={"patient": {"fullName": "A B", "dob": "1950-01-01"}}
        )
    ).status_code == 201
    assert (await bot.get("/api/v1/audit", headers=auth)).status_code == 403
    assert (await owner.delete(f"/api/v1/orgs/current/api-keys/{key_id}")).status_code == 204
    r = await bot.get("/api/v1/cases", headers=auth)
    assert r.status_code == 401 and r.json()["code"] == "invalid_api_key"


async def test_user_without_org_cannot_reach_tenant_routes(client):
    await signup(client)
    r = await client.get("/api/v1/cases")
    assert r.status_code == 403 and r.json()["code"] == "no_active_org"
