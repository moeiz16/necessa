"""Role → permission map (RBAC). Single source of truth for the API and the frontend (`/auth/me`)."""

from __future__ import annotations

ROLES: tuple[str, ...] = ("owner", "admin", "coordinator", "clinician", "reviewer", "rcm_manager", "auditor")
ROLE_LABELS = {
    "owner": "Owner",
    "admin": "Admin",
    "coordinator": "PA Coordinator",
    "clinician": "Clinician",
    "reviewer": "Reviewer",
    "rcm_manager": "RCM Manager",
    "auditor": "Auditor",
}

_ALL = set(ROLES)

PERMISSIONS: dict[str, set[str]] = {
    "cases:read": _ALL,
    "cases:write": {"owner", "admin", "coordinator", "clinician", "rcm_manager"},
    "cases:review": {"owner", "admin", "clinician", "reviewer"},
    "letters:approve": {"owner", "admin", "clinician"},
    "policies:read": _ALL,
    "assistant:use": _ALL,
    "knowledge:admin": {"owner", "admin"},
    "criteria:review": {"owner", "admin", "reviewer", "clinician"},
    "analytics:read": {"owner", "admin", "rcm_manager", "auditor", "coordinator"},
    "audit:read": {"owner", "admin", "auditor"},
    "org:admin": {"owner", "admin"},
    "evals:read": {"owner", "admin"},
    "phi:reveal": {"owner", "admin", "coordinator", "clinician"},
}

# Scopes an API key may be granted (never org:admin / phi:reveal).
API_KEY_SCOPES: frozenset[str] = frozenset(
    {"cases:read", "cases:write", "policies:read", "assistant:use", "analytics:read"}
)


def permissions_for(role: str | None) -> list[str]:
    if not role:
        return []
    return sorted(p for p, roles in PERMISSIONS.items() if role in roles)


def role_has(role: str | None, perm: str) -> bool:
    return bool(role) and role in PERMISSIONS.get(perm, set())
