"""Authentication endpoints (cookie-based browser sessions + bearer support)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import (
    ACCESS_COOKIE,
    CSRF_COOKIE,
    CSRF_HEADER,
    REFRESH_COOKIE,
    RequestContext,
    client_ip,
    get_db,
    get_user_ctx,
)
from app.core.errors import AppError, forbidden, not_found, unauthorized
from app.core.permissions import permissions_for
from app.core.security import create_access_token, new_csrf_token, parse_refresh_token, tokens_equal
from app.db.base import utcnow
from app.db.models.platform import Membership, Organization, User, UserSession
from app.schemas.platform import (
    ForgotPasswordIn,
    LoginIn,
    LoginOut,
    MeOut,
    MfaCodeIn,
    MfaSetupOut,
    MfaVerifyOut,
    OrgOut,
    OrgSummary,
    ResetPasswordIn,
    SessionOut,
    SignupIn,
    SignupOut,
    SwitchOrgIn,
    UserOut,
)
from app.services import auth as auth_svc
from app.services.audit import audit

router = APIRouter(prefix="/auth", tags=["auth"])


# ── Cookie helpers ───────────────────────────────────────────────────────────
def set_auth_cookies(
    response: Response, tokens: auth_svc.IssuedTokens | None = None, *, access_token: str | None = None
) -> str:
    s = get_settings()
    common = {"secure": s.cookie_secure, "samesite": "lax", "domain": s.cookie_domain}
    access = tokens.access_token if tokens else access_token
    if access:
        response.set_cookie(
            ACCESS_COOKIE, access, max_age=s.access_token_ttl_minutes * 60, httponly=True, path="/", **common
        )
    if tokens:
        response.set_cookie(
            REFRESH_COOKIE,
            tokens.refresh_token,
            max_age=s.refresh_token_ttl_days * 86400,
            httponly=True,
            path=f"{s.api_prefix}/auth",
            **common,
        )
    csrf = new_csrf_token()
    response.set_cookie(
        CSRF_COOKIE, csrf, max_age=s.refresh_token_ttl_days * 86400, httponly=False, path="/", **common
    )
    return csrf


def clear_auth_cookies(response: Response) -> None:
    s = get_settings()
    response.delete_cookie(ACCESS_COOKIE, path="/", domain=s.cookie_domain)
    response.delete_cookie(REFRESH_COOKIE, path=f"{s.api_prefix}/auth", domain=s.cookie_domain)
    response.delete_cookie(CSRF_COOKIE, path="/", domain=s.cookie_domain)


def _require_csrf(request: Request) -> None:
    cookie, header = request.cookies.get(CSRF_COOKIE), request.headers.get(CSRF_HEADER)
    if not cookie or not header or not tokens_equal(cookie, header):
        raise AppError(403, "csrf_failed", "CSRF check failed", "Missing or invalid X-CSRF-Token header.")


# ── Payload builders ─────────────────────────────────────────────────────────
def org_out(org: Organization, counts: dict[str, int] | None = None) -> OrgOut:
    data = OrgOut.model_validate(org)
    data.counts = counts
    return data


async def me_payload(db: AsyncSession, user: User, active_org_id: uuid.UUID | None) -> MeOut:
    orgs = await auth_svc.user_orgs(db, user.id)
    active: Organization | None = None
    membership: Membership | None = None
    for o, m in orgs:
        if o.id == active_org_id:
            active, membership = o, m
    return MeOut(
        user=UserOut.model_validate(user),
        active_org=org_out(active) if active else None,
        membership={"role": membership.role, "permissions": permissions_for(membership.role)}
        if membership
        else None,
        orgs=[OrgSummary(id=o.id, name=o.name, slug=o.slug, role=m.role) for o, m in orgs],
    )


# ── Endpoints ────────────────────────────────────────────────────────────────
@router.post("/signup", response_model=SignupOut, status_code=status.HTTP_201_CREATED)
async def signup(body: SignupIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    user = await auth_svc.create_user(db, email=body.email, password=body.password, full_name=body.full_name)
    user.last_login_at = utcnow()
    tokens = await auth_svc.issue_session(
        db, user, org_id=None, ip=client_ip(request), user_agent=request.headers.get("user-agent")
    )
    await audit(
        db,
        None,
        action="auth.signup",
        resource_type="user",
        resource_id=user.id,
        actor_id=user.id,
        ip=client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )
    set_auth_cookies(response, tokens)
    return SignupOut(user=UserOut.model_validate(user), needs_onboarding=True)


@router.post("/login", response_model=LoginOut)
async def login(body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    ip, ua = client_ip(request), request.headers.get("user-agent")
    user, mfa_required = await auth_svc.authenticate(
        db, email=body.email, password=body.password, mfa_code=body.mfa_code, ip=ip, user_agent=ua
    )
    if mfa_required:
        return LoginOut(user=None, mfa_required=True)
    assert user is not None
    org_id = await auth_svc.pick_active_org(db, user)
    tokens = await auth_svc.issue_session(db, user, org_id=org_id, ip=ip, user_agent=ua)
    await audit(
        db,
        None,
        action="auth.login",
        resource_type="user",
        resource_id=user.id,
        actor_id=user.id,
        org_id=org_id,
        ip=ip,
        user_agent=ua,
        metadata={"mfa": user.mfa_enabled},
    )
    set_auth_cookies(response, tokens)
    orgs = await auth_svc.user_orgs(db, user.id)
    return LoginOut(
        user=UserOut.model_validate(user),
        orgs=[OrgSummary(id=o.id, name=o.name, slug=o.slug, role=m.role) for o, m in orgs],
        active_org_id=org_id,
    )


@router.post("/refresh")
async def refresh(request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> dict:
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise unauthorized("No refresh token.", code="no_refresh_token")
    _require_csrf(request)
    tokens, _user = await auth_svc.rotate_refresh(
        db, token, ip=client_ip(request), user_agent=request.headers.get("user-agent")
    )
    set_auth_cookies(response, tokens)
    return {"ok": True}


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> Response:
    token = request.cookies.get(REFRESH_COOKIE)
    if token:
        _require_csrf(request)
        try:
            sid = parse_refresh_token(token)
        except AppError:
            sid = None
        if sid:
            sess = await db.get(UserSession, sid)
            if sess:
                await auth_svc.revoke_session(db, sid)
                await audit(
                    db,
                    None,
                    action="auth.logout",
                    resource_type="session",
                    resource_id=sid,
                    actor_id=sess.user_id,
                    ip=client_ip(request),
                )
    resp = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_auth_cookies(resp)
    return resp


@router.get("/me", response_model=MeOut)
async def me(ctx: RequestContext = Depends(get_user_ctx), db: AsyncSession = Depends(get_db)):
    return await me_payload(db, ctx.user, ctx.org.id if ctx.org else None)


@router.post("/switch-org", response_model=MeOut)
async def switch_org(
    body: SwitchOrgIn,
    response: Response,
    ctx: RequestContext = Depends(get_user_ctx),
    db: AsyncSession = Depends(get_db),
):
    member = (
        await db.execute(
            select(Membership).where(
                Membership.org_id == body.org_id,
                Membership.user_id == ctx.user.id,
                Membership.status == "active",
            )
        )
    ).scalar_one_or_none()
    if not member:
        raise not_found("Organization")
    if ctx.session_id:
        sess = await db.get(UserSession, ctx.session_id)
        if sess:
            sess.active_org_id = body.org_id
    ctx.user.preferences = {**(ctx.user.preferences or {}), "lastOrgId": str(body.org_id)}
    set_auth_cookies(response, access_token=create_access_token(ctx.user.id, body.org_id, ctx.session_id))
    await audit(
        db,
        ctx,
        action="auth.switch_org",
        resource_type="organization",
        resource_id=body.org_id,
        org_id=body.org_id,
    )
    return await me_payload(db, ctx.user, body.org_id)


@router.post("/password/forgot", status_code=status.HTTP_202_ACCEPTED)
async def forgot_password(
    body: ForgotPasswordIn, request: Request, db: AsyncSession = Depends(get_db)
) -> dict:
    s = get_settings()
    user = await auth_svc.get_user_by_email(db, body.email)
    out: dict = {"ok": True}
    if user and user.is_active:
        token = auth_svc.make_reset_token(user)
        await audit(
            db,
            None,
            action="auth.password_reset_requested",
            resource_type="user",
            resource_id=user.id,
            actor_id=user.id,
            ip=client_ip(request),
        )
        if s.environment in ("dev", "test"):  # no email provider on the free stack: surface the link in dev
            out["devLink"] = f"{s.public_app_url.rstrip('/')}/reset-password?token={token}"
    return out


@router.post("/password/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(
    body: ResetPasswordIn, request: Request, db: AsyncSession = Depends(get_db)
) -> Response:
    user = await auth_svc.reset_password(db, body.token, body.password)
    await audit(
        db,
        None,
        action="auth.password_reset",
        resource_type="user",
        resource_id=user.id,
        actor_id=user.id,
        ip=client_ip(request),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/mfa/setup", response_model=MfaSetupOut)
async def mfa_setup(ctx: RequestContext = Depends(get_user_ctx), db: AsyncSession = Depends(get_db)):
    if ctx.user.mfa_enabled:
        raise AppError(409, "mfa_already_enabled", "MFA already enabled", "Disable MFA before re-enrolling.")
    secret, url = auth_svc.start_mfa_setup(ctx.user)
    await audit(db, ctx, action="auth.mfa_setup_started", resource_type="user", resource_id=ctx.user.id)
    return MfaSetupOut(secret=secret, otpauth_url=url)


@router.post("/mfa/verify", response_model=MfaVerifyOut)
async def mfa_verify(
    body: MfaCodeIn, ctx: RequestContext = Depends(get_user_ctx), db: AsyncSession = Depends(get_db)
):
    codes = auth_svc.confirm_mfa(ctx.user, body.code)
    await audit(db, ctx, action="auth.mfa_enabled", resource_type="user", resource_id=ctx.user.id)
    return MfaVerifyOut(enabled=True, recovery_codes=codes)


@router.post("/mfa/disable", status_code=status.HTTP_204_NO_CONTENT)
async def mfa_disable(
    body: MfaCodeIn, ctx: RequestContext = Depends(get_user_ctx), db: AsyncSession = Depends(get_db)
) -> Response:
    if ctx.org and (ctx.org.settings or {}).get("requireMfa"):
        raise forbidden("Your organization requires MFA.")
    auth_svc.disable_mfa(ctx.user, body.code)
    await audit(db, ctx, action="auth.mfa_disabled", resource_type="user", resource_id=ctx.user.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/sessions", response_model=list[SessionOut])
async def list_sessions(ctx: RequestContext = Depends(get_user_ctx), db: AsyncSession = Depends(get_db)):
    rows = (
        (
            await db.execute(
                select(UserSession)
                .where(
                    UserSession.user_id == ctx.user.id,
                    UserSession.revoked_at.is_(None),
                    UserSession.expires_at > utcnow(),
                )
                .order_by(UserSession.last_used_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [
        SessionOut(
            id=s.id,
            user_agent=s.user_agent,
            ip=s.ip,
            created_at=s.created_at,
            last_used_at=s.last_used_at,
            current=s.id == ctx.session_id,
        )
        for s in rows
    ]


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_session(
    session_id: uuid.UUID, ctx: RequestContext = Depends(get_user_ctx), db: AsyncSession = Depends(get_db)
) -> Response:
    sess = await db.get(UserSession, session_id)
    if not sess or sess.user_id != ctx.user.id:
        raise not_found("Session")
    await auth_svc.revoke_session(db, session_id, reason="user_revoked")
    await audit(db, ctx, action="auth.session_revoked", resource_type="session", resource_id=session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/csrf")
async def csrf(response: Response) -> dict:
    return {"csrfToken": set_auth_cookies(response)}
