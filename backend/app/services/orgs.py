"""Organizations: onboarding, members, invitations, API keys."""

from __future__ import annotations

import re
import secrets
import uuid
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import AppError, conflict, forbidden, not_found
from app.core.permissions import API_KEY_SCOPES
from app.core.security import generate_api_key, hash_token, verify_password
from app.db.base import utcnow
from app.db.models.cases import Case, Patient
from app.db.models.platform import (
    DEFAULT_ORG_SETTINGS,
    ApiKey,
    Invitation,
    Membership,
    Organization,
    User,
)
from app.services.auth import create_user, normalize_email

INVITE_TTL = timedelta(days=7)
_SETTINGS_BOUNDS = {
    "slaHoursStandard": (1, 24 * 30),
    "slaHoursExpedited": (1, 24 * 7),
    "dataRetentionDays": (30, 365 * 10),
}


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return (slug or "org")[:60]


async def _unique_slug(db: AsyncSession, name: str) -> str:
    base = slugify(name)
    slug = base
    while (await db.execute(select(Organization.id).where(Organization.slug == slug))).first():
        slug = f"{base}-{secrets.token_hex(2)}"
    return slug


async def create_org(db: AsyncSession, owner: User, data: dict) -> tuple[Organization, Membership]:
    org = Organization(
        name=data["name"].strip(),
        slug=await _unique_slug(db, data["name"]),
        npi=data.get("npi"),
        specialty=data.get("specialty"),
        practice_type=data.get("practice_type", "clinic"),
        states=data.get("states", []),
        payers=data.get("payers", []),
        timezone=data.get("timezone", "America/New_York"),
        settings=dict(DEFAULT_ORG_SETTINGS),
    )
    db.add(org)
    await db.flush()
    membership = Membership(org_id=org.id, user_id=owner.id, role="owner", status="active")
    db.add(membership)
    owner.preferences = {**(owner.preferences or {}), "lastOrgId": str(org.id)}
    await db.flush()
    return org, membership


def validate_settings_patch(current: dict, patch: dict) -> dict:
    merged = {**DEFAULT_ORG_SETTINGS, **(current or {})}
    for key, value in patch.items():
        if key not in DEFAULT_ORG_SETTINGS:
            raise AppError(422, "unknown_setting", "Unknown setting", f"'{key}' is not a recognised setting.")
        if key in _SETTINGS_BOUNDS:
            lo, hi = _SETTINGS_BOUNDS[key]
            if not isinstance(value, int) or not lo <= value <= hi:
                raise AppError(
                    422, "invalid_setting", "Invalid setting", f"'{key}' must be an integer in [{lo}, {hi}]."
                )
        elif key == "requireMfa" and not isinstance(value, bool):
            raise AppError(422, "invalid_setting", "Invalid setting", "'requireMfa' must be a boolean.")
        elif key == "defaultAsOf" and value not in ("dos", "today"):
            raise AppError(
                422, "invalid_setting", "Invalid setting", "'defaultAsOf' must be 'dos' or 'today'."
            )
        merged[key] = value
    return merged


async def org_counts(db: AsyncSession, org_id: uuid.UUID) -> dict[str, int]:
    members = (
        await db.execute(
            select(func.count())
            .select_from(Membership)
            .where(Membership.org_id == org_id, Membership.status == "active")
        )
    ).scalar_one()
    cases = (
        await db.execute(select(func.count()).select_from(Case).where(Case.org_id == org_id))
    ).scalar_one()
    patients = (
        await db.execute(select(func.count()).select_from(Patient).where(Patient.org_id == org_id))
    ).scalar_one()
    return {"members": members, "cases": cases, "patients": patients}


# ── Members ──────────────────────────────────────────────────────────────────
async def list_members(db: AsyncSession, org_id: uuid.UUID) -> list[tuple[User, Membership]]:
    rows = (
        await db.execute(
            select(User, Membership)
            .join(Membership, Membership.user_id == User.id)
            .where(Membership.org_id == org_id)
            .order_by(Membership.created_at)
        )
    ).all()
    return [(u, m) for u, m in rows]


async def _owner_count(db: AsyncSession, org_id: uuid.UUID) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(Membership)
            .where(Membership.org_id == org_id, Membership.role == "owner", Membership.status == "active")
        )
    ).scalar_one()


async def get_membership(db: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID) -> Membership:
    m = (
        await db.execute(select(Membership).where(Membership.org_id == org_id, Membership.user_id == user_id))
    ).scalar_one_or_none()
    if not m:
        raise not_found("Member")
    return m


async def update_member(
    db: AsyncSession,
    org_id: uuid.UUID,
    actor_role: str,
    user_id: uuid.UUID,
    role: str | None,
    status: str | None,
) -> Membership:
    m = await get_membership(db, org_id, user_id)
    if (role == "owner" or m.role == "owner") and actor_role != "owner":
        raise forbidden("Only an owner can grant or change the owner role.")
    losing_owner = (
        m.role == "owner" and m.status == "active" and ((role and role != "owner") or status == "suspended")
    )
    if losing_owner and await _owner_count(db, org_id) <= 1:
        raise conflict("last_owner", "An organization must keep at least one active owner.")
    if role:
        m.role = role
    if status:
        m.status = status
    return m


async def remove_member(db: AsyncSession, org_id: uuid.UUID, actor_role: str, user_id: uuid.UUID) -> None:
    m = await get_membership(db, org_id, user_id)
    if m.role == "owner":
        if actor_role != "owner":
            raise forbidden("Only an owner can remove an owner.")
        if await _owner_count(db, org_id) <= 1:
            raise conflict("last_owner", "An organization must keep at least one active owner.")
    await db.delete(m)


# ── Invitations ──────────────────────────────────────────────────────────────
def invitation_status(inv: Invitation) -> str:
    if inv.accepted_at:
        return "accepted"
    if inv.revoked_at:
        return "revoked"
    if inv.expires_at < utcnow():
        return "expired"
    return "pending"


async def create_invitation(
    db: AsyncSession, org_id: uuid.UUID, inviter_id: uuid.UUID, actor_role: str, email: str, role: str
) -> tuple[Invitation, str]:
    email = normalize_email(email)
    if role == "owner" and actor_role != "owner":
        raise forbidden("Only an owner can invite another owner.")
    existing_member = (
        await db.execute(
            select(Membership)
            .join(User, User.id == Membership.user_id)
            .where(Membership.org_id == org_id, User.email == email)
        )
    ).scalar_one_or_none()
    if existing_member:
        raise conflict("already_member", "This person is already a member of the organization.")
    pending = (
        (
            await db.execute(
                select(Invitation).where(
                    Invitation.org_id == org_id,
                    Invitation.email == email,
                    Invitation.accepted_at.is_(None),
                    Invitation.revoked_at.is_(None),
                    Invitation.expires_at > utcnow(),
                )
            )
        )
        .scalars()
        .all()
    )
    for inv in pending:  # re-inviting supersedes older links
        inv.revoked_at = utcnow()
    token = secrets.token_urlsafe(32)
    inv = Invitation(
        org_id=org_id,
        email=email,
        role=role,
        token_hash=hash_token(token),
        invited_by=inviter_id,
        expires_at=utcnow() + INVITE_TTL,
    )
    db.add(inv)
    await db.flush()
    return inv, token


def invite_link(token: str) -> str:
    return f"{get_settings().public_app_url.rstrip('/')}/invite/{token}"


async def get_invitation_by_token(db: AsyncSession, token: str) -> tuple[Invitation, Organization]:
    inv = (
        await db.execute(select(Invitation).where(Invitation.token_hash == hash_token(token)))
    ).scalar_one_or_none()
    if not inv or invitation_status(inv) != "pending":
        raise AppError(
            404,
            "invitation_invalid",
            "Invitation not found",
            "This invitation link is invalid, expired, revoked or already used.",
        )
    org = await db.get(Organization, inv.org_id)
    if not org:
        raise not_found("Organization")
    return inv, org


async def accept_invitation(
    db: AsyncSession, token: str, *, current_user: User | None, full_name: str | None, password: str | None
) -> tuple[User, Organization]:
    inv, org = await get_invitation_by_token(db, token)
    user = current_user
    if user is not None:
        if normalize_email(user.email) != inv.email:
            raise forbidden("This invitation was sent to a different email address.")
    else:
        user = (await db.execute(select(User).where(User.email == inv.email))).scalar_one_or_none()
        if user is not None:
            if not password or not verify_password(password, user.password_hash):
                raise AppError(
                    401,
                    "login_required",
                    "Sign in to accept",
                    "An account already exists for this email; provide its password or sign in first.",
                )
        else:
            if not full_name or not password:
                raise AppError(
                    422,
                    "details_required",
                    "Name and password required",
                    "Provide fullName and password to create your account.",
                )
            user = await create_user(db, email=inv.email, password=password, full_name=full_name)
            user.email_verified_at = utcnow()  # possession of the emailed link proves the address
    db.add(Membership(org_id=org.id, user_id=user.id, role=inv.role, status="active"))
    inv.accepted_at = utcnow()
    user.preferences = {**(user.preferences or {}), "lastOrgId": str(org.id)}
    await db.flush()
    return user, org


# ── API keys ─────────────────────────────────────────────────────────────────
async def create_api_key(
    db: AsyncSession,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    name: str,
    scopes: list[str],
    expires_in_days: int | None,
) -> tuple[ApiKey, str]:
    bad = sorted(set(scopes) - API_KEY_SCOPES)
    if bad:
        raise AppError(
            422,
            "invalid_scope",
            "Invalid scope",
            f"Not grantable to API keys: {', '.join(bad)}. Allowed: {', '.join(sorted(API_KEY_SCOPES))}.",
        )
    secret, prefix, key_hash = generate_api_key()
    key = ApiKey(
        org_id=org_id,
        name=name,
        prefix=prefix,
        key_hash=key_hash,
        scopes=sorted(set(scopes)),
        created_by=user_id,
        expires_at=utcnow() + timedelta(days=expires_in_days) if expires_in_days else None,
    )
    db.add(key)
    await db.flush()
    return key, secret
