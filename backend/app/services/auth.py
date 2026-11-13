"""Authentication flows: signup, login (+MFA), refresh rotation with reuse detection, password reset."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from datetime import timedelta

import structlog
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.crypto import decrypt_str, encrypt_str
from app.core.errors import AppError, conflict, unauthorized
from app.core.security import (
    create_access_token,
    create_purpose_token,
    decode_purpose_token,
    generate_recovery_codes,
    hash_password,
    hash_token,
    needs_rehash,
    new_refresh_token,
    new_totp_secret,
    parse_refresh_token,
    tokens_equal,
    totp_uri,
    validate_password_strength,
    verify_password,
    verify_totp,
)
from app.db.base import utcnow
from app.db.models.platform import Membership, Organization, User, UserSession
from app.services.audit import audit

log = structlog.get_logger(__name__)

AVATAR_COLORS = ("#0F766E", "#1D4ED8", "#7C3AED", "#B45309", "#BE123C", "#047857", "#4338CA", "#0E7490")
RESET_TTL = timedelta(minutes=30)


@dataclass
class IssuedTokens:
    access_token: str
    refresh_token: str
    session: UserSession


def normalize_email(email: str) -> str:
    return email.strip().lower()


async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
    return (await db.execute(select(User).where(User.email == normalize_email(email)))).scalar_one_or_none()


async def user_orgs(db: AsyncSession, user_id: uuid.UUID) -> list[tuple[Organization, Membership]]:
    rows = (
        await db.execute(
            select(Organization, Membership)
            .join(Membership, Membership.org_id == Organization.id)
            .where(Membership.user_id == user_id, Membership.status == "active")
            .order_by(Membership.created_at)
        )
    ).all()
    return [(o, m) for o, m in rows]


async def create_user(
    db: AsyncSession, *, email: str, password: str | None, full_name: str, is_superuser: bool = False
) -> User:
    email = normalize_email(email)
    if await get_user_by_email(db, email):
        raise conflict("email_taken", "An account with this email already exists.")
    if password is not None:
        validate_password_strength(password)
    user = User(
        email=email,
        full_name=full_name.strip(),
        password_hash=hash_password(password) if password else None,
        is_superuser=is_superuser,
        avatar_color=AVATAR_COLORS[int(hashlib.sha256(email.encode()).hexdigest(), 16) % len(AVATAR_COLORS)],
        preferences={"theme": "system", "density": "comfortable"},
    )
    db.add(user)
    await db.flush()
    return user


async def issue_session(
    db: AsyncSession, user: User, *, org_id: uuid.UUID | None, ip: str | None, user_agent: str | None
) -> IssuedTokens:
    s = get_settings()
    sess = UserSession(
        user_id=user.id,
        refresh_token_hash="pending",  # noqa: S106 - placeholder, replaced below once the id exists
        active_org_id=org_id,
        ip=ip,
        user_agent=(user_agent or "")[:400] or None,
        expires_at=utcnow() + timedelta(days=s.refresh_token_ttl_days),
    )
    db.add(sess)
    await db.flush()
    refresh = new_refresh_token(sess.id)
    sess.refresh_token_hash = hash_token(refresh)
    return IssuedTokens(create_access_token(user.id, org_id, sess.id), refresh, sess)


async def pick_active_org(db: AsyncSession, user: User) -> uuid.UUID | None:
    orgs = await user_orgs(db, user.id)
    if not orgs:
        return None
    last = (user.preferences or {}).get("lastOrgId")
    for org, _m in orgs:
        if str(org.id) == last:
            return org.id
    return orgs[0][0].id


async def authenticate(
    db: AsyncSession,
    *,
    email: str,
    password: str,
    mfa_code: str | None,
    ip: str | None,
    user_agent: str | None,
) -> tuple[User | None, bool]:
    """Returns (user, mfa_required). Raises 401 on bad credentials (generic message)."""
    user = await get_user_by_email(db, email)
    ok = verify_password(password, user.password_hash if user else None)
    if not user or not ok or not user.is_active:
        await audit(
            db,
            None,
            action="auth.login_failed",
            resource_type="user",
            resource_id=user.id if user else None,
            actor_id=user.id if user else None,
            actor_type="user",
            ip=ip,
            user_agent=user_agent,
            metadata={"reason": "bad_credentials" if user else "unknown_email"},
        )
        await db.commit()  # keep the failed-attempt record even though the request errors
        raise unauthorized("Incorrect email or password.", code="invalid_credentials")
    if user.mfa_enabled:
        if not mfa_code:
            return user, True
        if not _check_mfa(user, mfa_code):
            await audit(
                db,
                None,
                action="auth.mfa_failed",
                resource_type="user",
                resource_id=user.id,
                actor_id=user.id,
                ip=ip,
                user_agent=user_agent,
            )
            await db.commit()
            raise unauthorized("Invalid verification code.", code="invalid_mfa_code")
    if user.password_hash and needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    user.last_login_at = utcnow()
    return user, False


def _check_mfa(user: User, code: str) -> bool:
    if user.mfa_secret_enc and verify_totp(decrypt_str(user.mfa_secret_enc), code):
        return True
    hashed = hash_token(code.strip().lower())
    codes = list(user.mfa_recovery_codes or [])
    for stored in codes:
        if tokens_equal(stored, hashed):
            codes.remove(stored)
            user.mfa_recovery_codes = codes
            return True
    return False


async def rotate_refresh(
    db: AsyncSession, refresh_token: str, *, ip: str | None, user_agent: str | None
) -> tuple[IssuedTokens, User]:
    """Rotate a refresh token. Presenting a superseded token revokes the whole family (theft signal)."""
    session_id = parse_refresh_token(refresh_token)
    sess = await db.get(UserSession, session_id)
    now = utcnow()
    if not sess or sess.revoked_at or sess.expires_at < now:
        raise unauthorized("Session expired. Please sign in again.", code="session_expired")
    if not tokens_equal(sess.refresh_token_hash, hash_token(refresh_token)):
        sess.revoked_at, sess.revoked_reason = now, "refresh_reuse"
        await audit(
            db,
            None,
            action="auth.refresh_reuse_detected",
            resource_type="session",
            resource_id=sess.id,
            actor_id=sess.user_id,
            ip=ip,
            user_agent=user_agent,
        )
        await db.commit()  # persist the revocation even though we raise
        log.warning("refresh_token_reuse_detected", session_id=str(sess.id))
        raise unauthorized(
            "Session invalidated for security reasons. Please sign in again.", code="refresh_reuse_detected"
        )
    user = await db.get(User, sess.user_id)
    if not user or not user.is_active:
        raise unauthorized("Account disabled.", code="inactive_user")
    org_id = sess.active_org_id
    if org_id:
        member = (
            await db.execute(
                select(Membership).where(
                    Membership.org_id == org_id, Membership.user_id == user.id, Membership.status == "active"
                )
            )
        ).scalar_one_or_none()
        if not member:
            org_id = sess.active_org_id = await pick_active_org(db, user)
    new_refresh = new_refresh_token(sess.id)
    sess.refresh_token_hash = hash_token(new_refresh)
    sess.rotation_count = (sess.rotation_count or 0) + 1
    sess.last_used_at = now
    if ip:
        sess.ip = ip
    return IssuedTokens(create_access_token(user.id, org_id, sess.id), new_refresh, sess), user


async def revoke_session(db: AsyncSession, session_id: uuid.UUID, reason: str = "logout") -> None:
    await db.execute(
        update(UserSession)
        .where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=utcnow(), revoked_reason=reason)
    )


async def revoke_all_sessions(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    except_id: uuid.UUID | None = None,
    reason: str = "password_changed",
) -> None:
    stmt = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
    if except_id:
        stmt = stmt.where(UserSession.id != except_id)
    await db.execute(stmt.values(revoked_at=utcnow(), revoked_reason=reason))


def _pw_fingerprint(user: User) -> str:
    return hashlib.sha256((user.password_hash or "none").encode()).hexdigest()[:16]


def make_reset_token(user: User) -> str:
    # Bound to the current password hash: the link stops working once the password changes.
    return create_purpose_token(str(user.id), "pwreset", RESET_TTL, {"pwv": _pw_fingerprint(user)})


async def reset_password(db: AsyncSession, token: str, new_password: str) -> User:
    data = decode_purpose_token(token, "pwreset")
    user = await db.get(User, uuid.UUID(data["sub"]))
    if not user or data.get("pwv") != _pw_fingerprint(user):
        raise AppError(400, "invalid_token", "Invalid or expired link")
    validate_password_strength(new_password)
    user.password_hash = hash_password(new_password)
    await revoke_all_sessions(db, user.id, reason="password_reset")
    return user


async def change_password(
    db: AsyncSession, user: User, current: str, new: str, keep_session: uuid.UUID | None
) -> None:
    if not verify_password(current, user.password_hash):
        raise AppError(400, "invalid_password", "Current password is incorrect")
    validate_password_strength(new)
    user.password_hash = hash_password(new)
    await revoke_all_sessions(db, user.id, except_id=keep_session)


def start_mfa_setup(user: User) -> tuple[str, str]:
    secret = new_totp_secret()
    user.mfa_secret_enc = encrypt_str(secret)
    user.mfa_enabled = False
    return secret, totp_uri(secret, user.email)


def confirm_mfa(user: User, code: str) -> list[str]:
    if not user.mfa_secret_enc or not verify_totp(decrypt_str(user.mfa_secret_enc), code):
        raise AppError(400, "invalid_mfa_code", "Invalid verification code")
    codes, hashes = generate_recovery_codes()
    user.mfa_enabled = True
    user.mfa_recovery_codes = hashes
    return codes


def disable_mfa(user: User, code: str) -> None:
    if not user.mfa_enabled or not _check_mfa(user, code):
        raise AppError(400, "invalid_mfa_code", "Invalid verification code")
    user.mfa_enabled = False
    user.mfa_secret_enc = None
    user.mfa_recovery_codes = []
