"""Shared FastAPI dependencies: DB session, authenticated request context, RBAC.

Usage in any router (A, B, C):

    from app.core.deps import RequestContext, get_ctx, get_db, require_perm

    @router.get("/things")
    async def list_things(ctx: RequestContext = Depends(require_perm("cases:read")),
                          db: AsyncSession = Depends(get_db)): ...
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from fastapi import Depends, Request
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clientip import resolve_client_ip
from app.core.errors import AppError, forbidden, unauthorized
from app.core.logging import request_id_ctx
from app.core.permissions import permissions_for
from app.core.security import (
    API_KEY_PREFIX,
    AccessClaims,
    decode_access_token,
    hash_token,
    tokens_equal,
)
from app.db.base import utcnow
from app.db.models.platform import ApiKey, Membership, Organization, User, UserSession
from app.db.session import get_db

__all__ = [
    "ACCESS_COOKIE",
    "CSRF_COOKIE",
    "CSRF_HEADER",
    "REFRESH_COOKIE",
    "RequestContext",
    "get_ctx",
    "get_db",
    "get_optional_ctx",
    "get_user_ctx",
    "require_perm",
    "require_superuser",
]

ACCESS_COOKIE = "necessa_at"
REFRESH_COOKIE = "necessa_rt"
CSRF_COOKIE = "necessa_csrf"
CSRF_HEADER = "X-CSRF-Token"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@dataclass
class RequestContext:
    user: User
    org: Organization | None
    membership: Membership | None
    role: str | None
    request_id: str | None
    ip: str | None
    user_agent: str | None
    session_id: uuid.UUID | None = None
    api_key: ApiKey | None = None
    permissions: set[str] = field(default_factory=set)

    @property
    def actor_type(self) -> str:
        return "api_key" if self.api_key else "user"

    @property
    def org_id(self) -> uuid.UUID:
        if not self.org:
            raise AppError(
                400, "no_active_org", "No active organization", "Create or switch to an organization first."
            )
        return self.org.id

    def has(self, perm: str) -> bool:
        return perm in self.permissions


def client_ip(request: Request) -> str | None:
    peer = request.client.host if request.client else None
    return resolve_client_ip(peer, request.headers.get("x-forwarded-for"))


def _extract_credentials(request: Request) -> tuple[str | None, str]:
    """Returns (token, source) where source is 'bearer' | 'cookie' | 'none'."""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip(), "bearer"
    cookie = request.cookies.get(ACCESS_COOKIE)
    if cookie:
        return cookie, "cookie"
    return None, "none"


def _check_csrf(request: Request) -> None:
    if request.method in _SAFE_METHODS:
        return
    cookie = request.cookies.get(CSRF_COOKIE)
    header = request.headers.get(CSRF_HEADER)
    if not cookie or not header or not tokens_equal(cookie, header):
        raise AppError(
            403,
            "csrf_failed",
            "CSRF check failed",
            "Missing or invalid X-CSRF-Token header for a cookie-authenticated request.",
        )


async def _resolve_api_key(db: AsyncSession, token: str, request: Request) -> RequestContext:
    key = (await db.execute(select(ApiKey).where(ApiKey.key_hash == hash_token(token)))).scalar_one_or_none()
    now = utcnow()
    if not key or key.revoked_at or (key.expires_at and key.expires_at < now):
        raise unauthorized("Invalid or revoked API key.", code="invalid_api_key")
    org = await db.get(Organization, key.org_id)
    creator = await db.get(User, key.created_by) if key.created_by else None
    if not org or not creator or not creator.is_active:
        raise unauthorized("API key owner is no longer active.", code="invalid_api_key")
    if not key.last_used_at or now - key.last_used_at > timedelta(minutes=5):
        key.last_used_at = now
    return RequestContext(
        user=creator,
        org=org,
        membership=None,
        role="api_key",
        request_id=request_id_ctx.get(),
        ip=client_ip(request),
        user_agent=request.headers.get("user-agent"),
        api_key=key,
        permissions=set(key.scopes or []),
    )


async def _load_identity(
    db: AsyncSession, claims: AccessClaims
) -> tuple[User | None, bool, Membership | None, Organization | None]:
    """User, session liveness, active membership and org for an access token in ONE statement.

    This runs on every authenticated request, so it matters: one round trip instead of four
    (user, session, membership, org) — on a remote Postgres each of those is a network hop.
    Returns (user, session_ok, membership, org); membership/org are None without an active membership.
    """
    cols: list[Any] = [User]
    if claims.session_id:
        cols.append(UserSession.revoked_at)
        cols.append(UserSession.id)
    if claims.org_id:
        cols += [Membership, Organization]
    stmt = select(*cols).select_from(User).where(User.id == claims.user_id)
    if claims.session_id:
        stmt = stmt.outerjoin(UserSession, UserSession.id == claims.session_id)
    if claims.org_id:
        stmt = stmt.outerjoin(
            Membership,
            and_(
                Membership.org_id == claims.org_id,
                Membership.user_id == User.id,
                Membership.status == "active",
            ),
        ).outerjoin(Organization, Organization.id == Membership.org_id)
    row = (await db.execute(stmt)).first()
    if row is None:
        return None, False, None, None
    user = row[0]
    idx = 1
    session_ok = True
    if claims.session_id:
        revoked_at, sess_id = row[idx], row[idx + 1]
        session_ok = sess_id is not None and revoked_at is None
        idx += 2
    membership = org = None
    if claims.org_id:
        membership, org = row[idx], row[idx + 1]
        if membership is None:
            org = None
    return user, session_ok, membership, org


async def _resolve(request: Request, db: AsyncSession, *, optional: bool) -> RequestContext | None:
    token, source = _extract_credentials(request)
    if not token:
        if optional:
            return None
        raise unauthorized()
    if source == "bearer" and token.startswith(API_KEY_PREFIX):
        return await _resolve_api_key(db, token, request)
    try:
        claims = decode_access_token(token)
    except AppError:
        if optional:
            return None
        raise
    if source == "cookie":
        _check_csrf(request)
    user, session_ok, membership, org = await _load_identity(db, claims)
    if not user or not user.is_active:
        raise unauthorized("Account is disabled or no longer exists.", code="inactive_user")
    if not session_ok:
        raise unauthorized("Session has been revoked.", code="session_revoked")
    role = membership.role if membership else None
    return RequestContext(
        user=user,
        org=org,
        membership=membership,
        role=role,
        request_id=request_id_ctx.get(),
        ip=client_ip(request),
        user_agent=request.headers.get("user-agent"),
        session_id=claims.session_id,
        permissions=set(permissions_for(role)),
    )


async def get_optional_ctx(request: Request, db: AsyncSession = Depends(get_db)) -> RequestContext | None:
    return await _resolve(request, db, optional=True)


async def get_user_ctx(request: Request, db: AsyncSession = Depends(get_db)) -> RequestContext:
    """Authenticated user; an active organization is NOT required (onboarding, profile)."""
    ctx = await _resolve(request, db, optional=False)
    assert ctx is not None
    return ctx


async def get_ctx(ctx: RequestContext = Depends(get_user_ctx)) -> RequestContext:
    """Authenticated user with an active organization membership."""
    if not ctx.org:
        raise AppError(
            403,
            "no_active_org",
            "No active organization",
            "Create an organization or switch to one you belong to.",
        )
    return ctx


def require_perm(perm: str) -> Callable[..., Coroutine[Any, Any, RequestContext]]:
    async def _dep(ctx: RequestContext = Depends(get_ctx)) -> RequestContext:
        if not ctx.has(perm):
            raise forbidden(f"Missing permission '{perm}'.")
        return ctx

    _dep.__name__ = f"require_{perm.replace(':', '_')}"
    return _dep


async def require_superuser(ctx: RequestContext = Depends(get_user_ctx)) -> RequestContext:
    if not ctx.user.is_superuser:
        raise forbidden("Platform administrator access required.")
    return ctx
