"""Field-level encryption for PHI at rest (Fernet / MultiFernet for key rotation).

`PHI_ENCRYPTION_KEY` may hold several comma-separated Fernet keys: the first encrypts,
all decrypt (rotate by prepending a new key, then re-encrypt in the background).
"""

from __future__ import annotations

import base64
import hashlib
import json
from functools import lru_cache
from typing import Any

import structlog
from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from app.core.config import get_settings
from app.core.errors import AppError

log = structlog.get_logger(__name__)


@lru_cache
def get_cipher() -> MultiFernet:
    s = get_settings()
    raw = s.phi_encryption_key.get_secret_value().strip()
    if raw:
        keys = [Fernet(k.strip().encode()) for k in raw.split(",") if k.strip()]
    else:
        if s.is_prod:
            raise RuntimeError("PHI_ENCRYPTION_KEY must be set in production.")
        log.warning(
            "phi_key_derived_from_secret",
            hint="PHI_ENCRYPTION_KEY is empty; deriving a dev-only key from SECRET_KEY. "
            "Set a real Fernet key before storing any real data.",
        )
        digest = hashlib.sha256(b"necessa-phi-v1:" + s.secret_key.get_secret_value().encode()).digest()
        keys = [Fernet(base64.urlsafe_b64encode(digest))]
    return MultiFernet(keys)


def encrypt_str(value: str) -> str:
    return get_cipher().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_str(token: str) -> str:
    try:
        return get_cipher().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:
        raise AppError(500, "decryption_failed", "Stored data could not be decrypted") from exc


def encrypt_json(value: Any) -> str:
    return encrypt_str(json.dumps(value, separators=(",", ":"), sort_keys=True, default=str))


def decrypt_json(token: str | None) -> Any:
    if not token:
        return None
    return json.loads(decrypt_str(token))
