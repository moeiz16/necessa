import type { Permission, Role } from "@/lib/api/types";

/** Mirrors backend app/core/permissions.py (docs/API_CONTRACT.md §2). */
export const PERMISSIONS: Record<Permission, Role[]> = {
  "cases:read": ["owner", "admin", "coordinator", "clinician", "reviewer", "rcm_manager", "auditor"],
  "cases:write": ["owner", "admin", "coordinator", "clinician", "rcm_manager"],
  "cases:review": ["owner", "admin", "clinician", "reviewer"],
  "letters:approve": ["owner", "admin", "clinician"],
  "policies:read": ["owner", "admin", "coordinator", "clinician", "reviewer", "rcm_manager", "auditor"],
  "knowledge:admin": ["owner", "admin"],
  "criteria:review": ["owner", "admin", "reviewer", "clinician"],
  "analytics:read": ["owner", "admin", "rcm_manager", "auditor", "coordinator"],
  "audit:read": ["owner", "admin", "auditor"],
  "org:admin": ["owner", "admin"],
  "evals:read": ["owner", "admin"],
  "phi:reveal": ["owner", "admin", "coordinator", "clinician"],
  "assistant:use": ["owner", "admin", "coordinator", "clinician", "reviewer", "rcm_manager", "auditor"],
};

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => PERMISSIONS[p].includes(role));
}
