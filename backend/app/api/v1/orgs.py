"""Organizations, onboarding, members, invitations and API keys."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.auth import me_payload, org_out, set_auth_cookies
from app.core.config import get_settings
from app.core.deps import (
    RequestContext,
    client_ip,
    get_db,
    get_optional_ctx,
    get_user_ctx,
    require_perm,
)
from app.core.errors import not_found
from app.core.security import create_access_token
from app.db.base import utcnow
from app.db.models.platform import ApiKey, Invitation, User, UserSession
from app.schemas.platform import (
    ApiKeyCreatedOut,
    ApiKeyCreateIn,
    ApiKeyOut,
    InvitationAcceptIn,
    InvitationCreatedOut,
    InvitationCreateIn,
    InvitationOut,
    InvitationPublicOut,
    MemberOut,
    MemberUpdateIn,
    MeOut,
    OrgCreateIn,
    OrgOut,
    OrgUpdateIn,
)
from app.services import auth as auth_svc
from app.services import orgs as org_svc
from app.services.audit import audit
from app.services.notifications import notify

router = APIRouter(tags=["organizations"])


def _invitation_out(inv: Invitation) -> InvitationOut:
    return InvitationOut(
        id=inv.id,
        email=inv.email,
        role=inv.role,
        invited_by=inv.invited_by,
        expires_at=inv.expires_at,
        accepted_at=inv.accepted_at,
        revoked_at=inv.revoked_at,
        created_at=inv.created_at,
        status=org_svc.invitation_status(inv),
    )


async def _activate_org(
    db: AsyncSession, response: Response, user: User, session_id: uuid.UUID | None, org_id: uuid.UUID
) -> None:
    if session_id:
        sess = await db.get(UserSession, session_id)
        if sess:
            sess.active_org_id = org_id
    set_auth_cookies(response, access_token=create_access_token(user.id, org_id, session_id))


# ── Organization ─────────────────────────────────────────────────────────────
@router.post("/orgs", response_model=OrgOut, status_code=status.HTTP_201_CREATED)
async def create_org(
    body: OrgCreateIn,
    response: Response,
    ctx: RequestContext = Depends(get_user_ctx),
    db: AsyncSession = Depends(get_db),
):
    org, _m = await org_svc.create_org(db, ctx.user, body.model_dump(mode="json"))
    await _activate_org(db, response, ctx.user, ctx.session_id, org.id)
    await audit(
        db,
        ctx,
        action="org.created",
        resource_type="organization",
        resource_id=org.id,
        org_id=org.id,
        metadata={"practiceType": org.practice_type, "states": org.states},
    )
    return org_out(org, await org_svc.org_counts(db, org.id))


@router.get("/orgs/current", response_model=OrgOut)
async def get_current_org(
    ctx: RequestContext = Depends(require_perm("cases:read")), db: AsyncSession = Depends(get_db)
):
    return org_out(ctx.org, await org_svc.org_counts(db, ctx.org_id))  # type: ignore[arg-type]


@router.patch("/orgs/current", response_model=OrgOut)
async def update_current_org(
    body: OrgUpdateIn,
    ctx: RequestContext = Depends(require_perm("org:admin")),
    db: AsyncSession = Depends(get_db),
):
    org = ctx.org
    assert org is not None
    patch = body.model_dump(exclude_none=True, mode="json")
    if "settings" in patch:
        org.settings = org_svc.validate_settings_patch(org.settings, patch.pop("settings"))
    for field, value in patch.items():
        setattr(org, field, value)
    await audit(
        db,
        ctx,
        action="org.updated",
        resource_type="organization",
        resource_id=org.id,
        metadata={"fields": sorted(body.model_dump(exclude_none=True))},
    )
    return org_out(org, await org_svc.org_counts(db, org.id))


@router.post("/orgs/current/onboarding/complete", response_model=OrgOut)
async def complete_onboarding(
    ctx: RequestContext = Depends(require_perm("org:admin")), db: AsyncSession = Depends(get_db)
):
    org = ctx.org
    assert org is not None
    if not org.onboarding_completed_at:
        org.onboarding_completed_at = utcnow()
        await audit(
            db, ctx, action="org.onboarding_completed", resource_type="organization", resource_id=org.id
        )
    return org_out(org, await org_svc.org_counts(db, org.id))


# ── Members ──────────────────────────────────────────────────────────────────
@router.get("/orgs/current/members", response_model=list[MemberOut])
async def list_members(
    ctx: RequestContext = Depends(require_perm("cases:read")), db: AsyncSession = Depends(get_db)
):
    rows = await org_svc.list_members(db, ctx.org_id)
    return [
        MemberOut(
            id=u.id,
            full_name=u.full_name,
            email=u.email,
            role=m.role,
            status=m.status,
            last_login_at=u.last_login_at,
            mfa_enabled=u.mfa_enabled,
            avatar_color=u.avatar_color,
            joined_at=m.created_at,
        )
        for u, m in rows
    ]


@router.patch("/orgs/current/members/{user_id}", response_model=MemberOut)
async def update_member(
    user_id: uuid.UUID,
    body: MemberUpdateIn,
    ctx: RequestContext = Depends(require_perm("org:admin")),
    db: AsyncSession = Depends(get_db),
):
    m = await org_svc.update_member(db, ctx.org_id, ctx.role or "", user_id, body.role, body.status)
    user = await db.get(User, user_id)
    assert user is not None
    await audit(
        db,
        ctx,
        action="org.member_updated",
        resource_type="user",
        resource_id=user_id,
        metadata=body.model_dump(exclude_none=True),
    )
    return MemberOut(
        id=user.id,
        full_name=user.full_name,
        email=user.email,
        role=m.role,
        status=m.status,
        last_login_at=user.last_login_at,
        mfa_enabled=user.mfa_enabled,
        avatar_color=user.avatar_color,
        joined_at=m.created_at,
    )


@router.delete("/orgs/current/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    user_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("org:admin")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    await org_svc.remove_member(db, ctx.org_id, ctx.role or "", user_id)
    await audit(db, ctx, action="org.member_removed", resource_type="user", resource_id=user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Invitations ──────────────────────────────────────────────────────────────
@router.get("/orgs/current/invitations", response_model=list[InvitationOut])
async def list_invitations(
    ctx: RequestContext = Depends(require_perm("org:admin")), db: AsyncSession = Depends(get_db)
):
    rows = (
        (
            await db.execute(
                select(Invitation)
                .where(Invitation.org_id == ctx.org_id)
                .order_by(Invitation.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [_invitation_out(i) for i in rows]


@router.post(
    "/orgs/current/invitations", response_model=InvitationCreatedOut, status_code=status.HTTP_201_CREATED
)
async def create_invitation(
    body: InvitationCreateIn,
    ctx: RequestContext = Depends(require_perm("org:admin")),
    db: AsyncSession = Depends(get_db),
):
    inv, token = await org_svc.create_invitation(
        db, ctx.org_id, ctx.user.id, ctx.role or "", body.email, body.role
    )
    await audit(
        db,
        ctx,
        action="org.invitation_created",
        resource_type="invitation",
        resource_id=inv.id,
        metadata={"role": body.role},
    )
    dev = get_settings().environment in ("dev", "test")
    return InvitationCreatedOut(
        invitation=_invitation_out(inv), dev_link=org_svc.invite_link(token) if dev else None
    )


@router.delete("/orgs/current/invitations/{invitation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_invitation(
    invitation_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("org:admin")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    inv = await db.get(Invitation, invitation_id)
    if not inv or inv.org_id != ctx.org_id:
        raise not_found("Invitation")
    if not inv.revoked_at and not inv.accepted_at:
        inv.revoked_at = utcnow()
        await audit(db, ctx, action="org.invitation_revoked", resource_type="invitation", resource_id=inv.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/invitations/{token}", response_model=InvitationPublicOut, tags=["public"])
async def get_invitation(token: str, db: AsyncSession = Depends(get_db)):
    inv, org = await org_svc.get_invitation_by_token(db, token)
    exists = (await db.execute(select(User.id).where(User.email == inv.email))).first() is not None
    return InvitationPublicOut(
        org_name=org.name, email=inv.email, role=inv.role, expires_at=inv.expires_at, account_exists=exists
    )


@router.post("/invitations/{token}/accept", response_model=MeOut, tags=["public"])
async def accept_invitation(
    token: str,
    body: InvitationAcceptIn,
    request: Request,
    response: Response,
    ctx: RequestContext | None = Depends(get_optional_ctx),
    db: AsyncSession = Depends(get_db),
):
    user, org = await org_svc.accept_invitation(
        db, token, current_user=ctx.user if ctx else None, full_name=body.full_name, password=body.password
    )
    if ctx:
        await _activate_org(db, response, user, ctx.session_id, org.id)
    else:
        user.last_login_at = utcnow()
        tokens = await auth_svc.issue_session(
            db, user, org_id=org.id, ip=client_ip(request), user_agent=request.headers.get("user-agent")
        )
        set_auth_cookies(response, tokens)
    await audit(
        db,
        None,
        action="org.invitation_accepted",
        resource_type="organization",
        resource_id=org.id,
        org_id=org.id,
        actor_id=user.id,
        ip=client_ip(request),
    )
    await notify(
        db,
        org_id=org.id,
        type="member_joined",
        title=f"{user.full_name} joined {org.name}",
        link="/settings/team",
        roles=["owner", "admin"],
    )
    return await me_payload(db, user, org.id)


# ── API keys ─────────────────────────────────────────────────────────────────
@router.get("/orgs/current/api-keys", response_model=list[ApiKeyOut])
async def list_api_keys(
    ctx: RequestContext = Depends(require_perm("org:admin")), db: AsyncSession = Depends(get_db)
):
    rows = (
        (
            await db.execute(
                select(ApiKey).where(ApiKey.org_id == ctx.org_id).order_by(ApiKey.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [ApiKeyOut.model_validate(k) for k in rows]


@router.post("/orgs/current/api-keys", response_model=ApiKeyCreatedOut, status_code=status.HTTP_201_CREATED)
async def create_api_key(
    body: ApiKeyCreateIn,
    ctx: RequestContext = Depends(require_perm("org:admin")),
    db: AsyncSession = Depends(get_db),
):
    key, secret = await org_svc.create_api_key(
        db, ctx.org_id, ctx.user.id, body.name, body.scopes, body.expires_in_days
    )
    await audit(
        db,
        ctx,
        action="org.api_key_created",
        resource_type="api_key",
        resource_id=key.id,
        metadata={"scopes": key.scopes, "prefix": key.prefix},
    )
    return ApiKeyCreatedOut(api_key=ApiKeyOut.model_validate(key), secret=secret)


@router.delete("/orgs/current/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_key(
    key_id: uuid.UUID,
    ctx: RequestContext = Depends(require_perm("org:admin")),
    db: AsyncSession = Depends(get_db),
) -> Response:
    key = await db.get(ApiKey, key_id)
    if not key or key.org_id != ctx.org_id:
        raise not_found("API key")
    if not key.revoked_at:
        key.revoked_at = utcnow()
        await audit(db, ctx, action="org.api_key_revoked", resource_type="api_key", resource_id=key.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
