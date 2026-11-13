"""Credential primitives: password hashing, JWTs, refresh tokens, CSRF, API keys, TOTP."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import get_settings
from app.core.errors import AppError, unauthorized

_hasher = PasswordHasher(time_cost=2, memory_cost=19_456, parallelism=1)  # OWASP 2023 argon2id minimums
_DUMMY_HASH = _hasher.hash("timing-equaliser-not-a-real-password")
JWT_ALG = "HS256"
API_KEY_PREFIX = "nk_live_"
_COMMON = {"password1234", "123456789012", "qwertyuiopas", "letmein12345", "necessa12345", "passwordpassword"}


# ── Passwords ────────────────────────────────────────────────────────────────
def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    """Constant-ish time: always runs one argon2 verification even for unknown users."""
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def validate_password_strength(password: str) -> None:
    s = get_settings()
    problems = []
    if len(password) < s.password_min_length:
        problems.append(f"Use at least {s.password_min_length} characters.")
    if len(set(password)) < 5:
        problems.append("Use a less repetitive password.")
    if password.lower() in _COMMON:
        problems.append("This password is too common.")
    if problems:
        raise AppError(
            422,
            "weak_password",
            "Password does not meet requirements",
            " ".join(problems),
            errors=[{"field": "password", "message": p} for p in problems],
        )


# ── Token hashing (HMAC with server secret, so a DB leak doesn't reveal usable tokens) ──
def hash_token(token: str) -> str:
    key = get_settings().secret_key.get_secret_value().encode()
    return hmac.new(key, token.encode(), hashlib.sha256).hexdigest()


def tokens_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


# ── Access tokens ────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class AccessClaims:
    user_id: uuid.UUID
    org_id: uuid.UUID | None
    session_id: uuid.UUID | None
    jti: str


def create_access_token(user_id: uuid.UUID, org_id: uuid.UUID | None, session_id: uuid.UUID | None) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "org": str(org_id) if org_id else None,
        "sid": str(session_id) if session_id else None,
        "typ": "access",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=s.access_token_ttl_minutes)).timestamp()),
        "jti": secrets.token_hex(8),
        "iss": "necessa",
    }
    return jwt.encode(payload, s.secret_key.get_secret_value(), algorithm=JWT_ALG)


def decode_access_token(token: str) -> AccessClaims:
    try:
        data = jwt.decode(
            token,
            get_settings().secret_key.get_secret_value(),
            algorithms=[JWT_ALG],
            issuer="necessa",
            options={"require": ["exp", "sub", "typ"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise unauthorized("Access token expired.", code="token_expired") from exc
    except jwt.PyJWTError as exc:
        raise unauthorized("Invalid access token.", code="invalid_token") from exc
    if data.get("typ") != "access":
        raise unauthorized("Invalid token type.", code="invalid_token")
    return AccessClaims(
        user_id=uuid.UUID(data["sub"]),
        org_id=uuid.UUID(data["org"]) if data.get("org") else None,
        session_id=uuid.UUID(data["sid"]) if data.get("sid") else None,
        jti=data.get("jti", ""),
    )


def create_purpose_token(subject: str, purpose: str, ttl: timedelta, extra: dict | None = None) -> str:
    """Short-lived signed token for password resets etc. (stateless; bound to `extra`)."""
    now = datetime.now(UTC)
    payload = {
        "sub": subject,
        "typ": purpose,
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
        "iss": "necessa",
        **(extra or {}),
    }
    return jwt.encode(payload, get_settings().secret_key.get_secret_value(), algorithm=JWT_ALG)


def decode_purpose_token(token: str, purpose: str) -> dict:
    try:
        data = jwt.decode(
            token, get_settings().secret_key.get_secret_value(), algorithms=[JWT_ALG], issuer="necessa"
        )
    except jwt.PyJWTError as exc:
        raise AppError(400, "invalid_token", "Invalid or expired link") from exc
    if data.get("typ") != purpose:
        raise AppError(400, "invalid_token", "Invalid or expired link")
    return data


# ── Refresh tokens (format: "<session_id>.<secret>") ─────────────────────────
def new_refresh_token(session_id: uuid.UUID) -> str:
    return f"{session_id}.{secrets.token_urlsafe(32)}"


def parse_refresh_token(token: str) -> uuid.UUID:
    try:
        sid, secret = token.split(".", 1)
        if len(secret) < 20:
            raise ValueError
        return uuid.UUID(sid)
    except ValueError as exc:
        raise unauthorized("Invalid refresh token.", code="invalid_refresh") from exc


# ── CSRF (double submit) ─────────────────────────────────────────────────────
def new_csrf_token() -> str:
    return secrets.token_urlsafe(24)


# ── API keys ─────────────────────────────────────────────────────────────────
def generate_api_key() -> tuple[str, str, str]:
    """Returns (secret, display_prefix, hash). The secret is shown to the user exactly once."""
    secret = API_KEY_PREFIX + secrets.token_urlsafe(30)
    return secret, secret[: len(API_KEY_PREFIX) + 6], hash_token(secret)


# ── TOTP MFA ─────────────────────────────────────────────────────────────────
def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name="Necessa")


def verify_totp(secret: str, code: str) -> bool:
    code = (code or "").replace(" ", "")
    return code.isdigit() and pyotp.TOTP(secret).verify(code, valid_window=1)


def generate_recovery_codes(n: int = 8) -> tuple[list[str], list[str]]:
    codes = [f"{secrets.token_hex(3)}-{secrets.token_hex(3)}" for _ in range(n)]
    return codes, [hash_token(c) for c in codes]
