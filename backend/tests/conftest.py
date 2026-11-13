"""Shared test fixtures.

* Settings are pinned via env vars BEFORE the app is imported (SQLite temp DB, generous rate limits).
* Each test runs in its own event loop, so the engine is disposed after every test.
* Tests isolate by creating fresh users/orgs (unique emails) rather than truncating tables.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

_TMP = Path(tempfile.mkdtemp(prefix="necessa-test-"))
os.environ.update(
    {
        "ENVIRONMENT": "test",
        "DATABASE_URL": f"sqlite+aiosqlite:///{_TMP / 'test.db'}",
        "SECRET_KEY": "test-secret-key-0123456789abcdefghijklmnop",
        "PHI_ENCRYPTION_KEY": "q8QGKZ0XyQm2b5hR3r6T7mFJw0sYk9aHn4LcV1pD2eE=",
        "RATE_LIMIT_PER_MINUTE": "100000",
        "AUTH_RATE_LIMIT_PER_MINUTE": "100000",
        "QDRANT_URL": "",
        "REDIS_URL": "",
        "DEMO_MODE": "false",
        "LOG_LEVEL": "WARNING",
    }
)

import httpx  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402

from app.core.ratelimit import limiter  # noqa: E402
from app.db.session import get_engine  # noqa: E402

PASSWORD = "Correct-Horse-Battery-42"  # noqa: S105 - test fixture credential


async def _create_schema() -> None:
    import app.db.models  # noqa: F401
    from app.db.base import Base

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await engine.dispose()


@pytest.fixture(scope="session", autouse=True)
def _schema() -> None:
    asyncio.run(_create_schema())


@pytest_asyncio.fixture(autouse=True)
async def _isolate() -> AsyncIterator[None]:
    limiter.reset()
    yield
    await get_engine().dispose()


@pytest.fixture
def app():
    from app.main import app as fastapi_app

    return fastapi_app


def _client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver", follow_redirects=False
    )


@pytest_asyncio.fixture
async def client(app) -> AsyncIterator[httpx.AsyncClient]:
    async with _client(app) as c:
        yield c


@pytest_asyncio.fixture
async def make_client(app) -> AsyncIterator:
    """Factory for extra independent clients (separate cookie jars = separate users)."""
    clients: list[httpx.AsyncClient] = []

    def _make() -> httpx.AsyncClient:
        c = _client(app)
        clients.append(c)
        return c

    yield _make
    for c in clients:
        await c.aclose()


def csrf(client: httpx.AsyncClient) -> dict[str, str]:
    token = client.cookies.get("necessa_csrf")
    return {"X-CSRF-Token": token} if token else {}


def unique_email(prefix: str = "user") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}@necessa-test.io"


@dataclass
class Account:
    client: httpx.AsyncClient
    email: str
    user: dict
    org: dict | None = None

    @property
    def headers(self) -> dict[str, str]:
        return csrf(self.client)

    async def get(self, url: str, **kw) -> httpx.Response:
        return await self.client.get(url, **kw)

    async def post(self, url: str, **kw) -> httpx.Response:
        return await self.client.post(url, headers={**self.headers, **kw.pop("headers", {})}, **kw)

    async def patch(self, url: str, **kw) -> httpx.Response:
        return await self.client.patch(url, headers={**self.headers, **kw.pop("headers", {})}, **kw)

    async def delete(self, url: str, **kw) -> httpx.Response:
        return await self.client.delete(url, headers={**self.headers, **kw.pop("headers", {})}, **kw)


async def signup(
    client: httpx.AsyncClient, email: str | None = None, full_name: str = "Test User"
) -> Account:
    email = email or unique_email()
    r = await client.post(
        "/api/v1/auth/signup", json={"email": email, "password": PASSWORD, "fullName": full_name}
    )
    assert r.status_code == 201, r.text
    return Account(client=client, email=email, user=r.json()["user"])


async def signup_with_org(client: httpx.AsyncClient, org_name: str = "Riverbend Orthopedics") -> Account:
    acct = await signup(client)
    r = await acct.post(
        "/api/v1/orgs",
        json={
            "name": org_name,
            "specialty": "Orthopedics",
            "practiceType": "clinic",
            "states": ["OH", "TX"],
            "payers": [{"type": "medicare_ffs", "name": "Medicare Part B"}],
        },
    )
    assert r.status_code == 201, r.text
    acct.org = r.json()
    return acct


async def add_member(owner: Account, new_client: httpx.AsyncClient, role: str) -> Account:
    email = unique_email(role)
    r = await owner.post("/api/v1/orgs/current/invitations", json={"email": email, "role": role})
    assert r.status_code == 201, r.text
    token = r.json()["devLink"].rsplit("/", 1)[1]
    r = await new_client.post(
        f"/api/v1/invitations/{token}/accept",
        json={"fullName": f"{role.title()} Person", "password": PASSWORD},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    return Account(client=new_client, email=email, user=body["user"], org=body["activeOrg"])


CASE_PAYLOAD = {
    "patient": {
        "fullName": "Jordan Avery Doe",
        "dob": "1951-04-12",
        "sex": "female",
        "state": "OH",
        "memberId": "1EG4-TE5-MK72",
        "phone": "614-555-0142",
    },
    "priority": "standard",
    "payerType": "medicare_ffs",
    "payerName": "Medicare Part B (CGS J15)",
    "state": "OH",
    "serviceCodes": ["29881"],
    "dxCodes": ["M23.221", "M17.11"],
    "dateOfService": "2026-12-01",
}


async def create_case(acct: Account, **overrides) -> dict:
    r = await acct.post("/api/v1/cases", json={**CASE_PAYLOAD, **overrides})
    assert r.status_code == 201, r.text
    return r.json()
