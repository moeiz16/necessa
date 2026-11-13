"use client";

/* In-browser mock of the Necessa API (docs/API_CONTRACT.md). Used when demo mode is on. */

import { ApiError, type RequestOptions } from "@/lib/api/client";
import type {
  AnalyticsOverview,
  ApiKey,
  Case,
  CaseDocument,
  CaseSummary,
  CoverageGraph,
  CriterionResult,
  Denial,
  Evaluation,
  Job,
  Letter,
  Me,
  NextAction,
  Org,
  Page,
  PolicyDiff,
  PolicyMatch,
  Permission,
  PolicySummary,
  Role,
  SqlResult,
  Verdict,
} from "@/lib/api/types";
import { permissionsFor } from "@/lib/permissions";
import { sleep } from "@/lib/utils";
import { masked } from "./seed-cases";
import { buildAnalytics, buildModelUsage, buildTeam, MODEL_GROUPS } from "./seed-ops";
import { addEvent, appendAudit, getDB, nextId, notify, saveDB, seed, type DemoDB } from "./store";
import { evaluateTree } from "./seed-cases";

type Ctx = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  form?: FormData;
  db: DemoDB;
};
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

const routes: { method: string; parts: string[]; handler: Handler }[] = [];
function route(method: string, pattern: string, handler: Handler) {
  routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
}

function fail(status: number, title: string, detail?: string, code?: string): never {
  throw new ApiError({ title, status, detail, code });
}

function me(db: DemoDB) {
  if (!db.session) fail(401, "Not authenticated", "Sign in to continue.", "auth.required");
  const user = db.users.find((u) => u.id === db.session!.userId);
  if (!user) fail(401, "Not authenticated");
  const orgId = db.session!.orgId;
  const membership = orgId ? db.memberships.find((m) => m.orgId === orgId && m.userId === user.id) : undefined;
  const org = orgId ? db.orgs.find((o) => o.id === orgId) ?? null : null;
  return { user, org, role: membership?.role ?? null };
}

function requireOrg(db: DemoDB) {
  const m = me(db);
  if (!m.org || !m.role) fail(409, "No active organization", "Create or join an organization first.", "org.required");
  return m as { user: DemoDB["users"][number]; org: Org; role: Role };
}

function requirePerm(db: DemoDB, perm: Permission) {
  const m = requireOrg(db);
  if (!permissionsFor(m.role).includes(perm)) {
    fail(403, "Insufficient permissions", `Your role (${m.role}) cannot perform this action.`, "auth.forbidden");
  }
  return m;
}

function mePayload(db: DemoDB): Me {
  const { user, org, role } = me(db);
  const { password: _p, ...u } = user;
  return {
    user: u,
    activeOrg: org,
    membership: role ? { role, permissions: permissionsFor(role) } : null,
    orgs: db.memberships
      .filter((m) => m.userId === user.id)
      .map((m) => {
        const o = db.orgs.find((x) => x.id === m.orgId)!;
        return { id: o.id, name: o.name, slug: o.slug, role: m.role };
      }),
  };
}

function paginate<T>(items: T[], query: URLSearchParams): Page<T> {
  const limit = Math.min(200, Number(query.get("limit") || 50));
  const offset = Number(query.get("cursor") || 0);
  const slice = items.slice(offset, offset + limit);
  return { items: slice, nextCursor: offset + limit < items.length ? String(offset + limit) : null, total: items.length };
}

const summarize = (c: Case): CaseSummary => ({
  id: c.id,
  number: c.number,
  title: c.title,
  status: c.status,
  priority: c.priority,
  payerType: c.payerType,
  payerName: c.payerName,
  state: c.state,
  serviceCodes: c.serviceCodes,
  dxCodes: c.dxCodes,
  dateOfService: c.dateOfService,
  readiness: c.readiness,
  readinessScore: c.readinessScore,
  dueAt: c.dueAt,
  assignee: c.assignee,
  patient: c.patient,
  updatedAt: c.updatedAt,
});

const orgOf = (c: { orgId?: string }) => c.orgId ?? "org-riverbend";
function orgCases(db: DemoDB) {
  const orgId = db.session?.orgId;
  return db.cases.filter((c) => orgOf(c) === orgId);
}

function getCase(db: DemoDB, id: string) {
  const c = orgCases(db).find((x) => x.id === id);
  if (!c) fail(404, "Case not found", `No case with id ${id}.`, "case.not_found");
  return c;
}

function touch(c: Case) {
  c.updatedAt = new Date().toISOString();
}

/* ── Policy resolution (deterministic, mirrors backend resolve_policies) ── */
export function resolvePolicies(
  db: DemoDB,
  input: { serviceCodes: string[]; dxCodes: string[]; state?: string | null; payerType?: string; dateOfService?: string },
): PolicyMatch[] {
  const out: PolicyMatch[] = [];
  for (const p of db.policies) {
    if (p.docType !== "LCD") continue;
    const codes = Object.values(db.policyCodes[p.id] ?? []);
    const linkedCodes = p.linked.flatMap((l) => db.policyCodes[l.policyId] ?? []);
    const all = [...codes, ...linkedCodes];
    const hcpcsHit = input.serviceCodes.filter((s) => all.some((c) => c.codeSystem === "HCPCS" && c.code === s));
    if (!hcpcsHit.length) continue;
    const dxHit = input.dxCodes.filter((d) => all.some((c) => c.codeSystem === "ICD10_COVERED" && c.code === d));
    const stateOk = !input.state || p.states.includes(input.state);
    const reasons: PolicyMatch["matchReasons"] = [
      ...hcpcsHit.map((v) => ({ type: "hcpcs" as const, value: v, detail: "Listed in the related Billing & Coding article" })),
      ...dxHit.map((v) => ({ type: "icd10" as const, value: v, detail: "Covered diagnosis" })),
    ];
    if (input.state) reasons.push({ type: "state", value: input.state, detail: stateOk ? `${p.contractors[0]?.name ?? "MAC"} jurisdiction` : "Outside this contractor's jurisdiction" });
    const set = db.criteriaSets.find((s) => s.policyVersionId === p.currentVersionId);
    out.push({
      policyId: p.id,
      policyVersionId: p.currentVersionId,
      sourceKey: p.sourceKey,
      title: p.title,
      docType: p.docType,
      version: p.version,
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo ?? null,
      matchReasons: reasons,
      score: Math.min(0.99, 0.55 + hcpcsHit.length * 0.2 + dxHit.length * 0.12 + (stateOk ? 0.1 : -0.3)),
      contractor: p.contractors[0] ?? null,
      criteriaSetStatus: set ? (set.status === "approved" ? "approved" : "needs_review") : null,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

function nextActions(db: DemoDB, c: Case): NextAction[] {
  const ev = db.evaluations.find((e) => e.id === c.latestEvaluationId);
  const docs = db.documents.filter((d) => d.caseId === c.id);
  const out: NextAction[] = [];
  if (!docs.length) out.push({ type: "upload_document", title: "Add clinical documentation", detail: "Upload the most recent progress note, imaging and therapy records.", priority: "high" });
  if (!ev) out.push({ type: "evaluate", title: "Run a medical-necessity check", detail: "Necessa will resolve the applicable policy and check each criterion.", priority: docs.length ? "high" : "medium" });
  if (ev) {
    for (const g of ev.gaps) out.push({ type: "fix_gap", title: g.title, detail: g.suggestedFix, criterionId: g.criterionId, priority: g.severity === "blocker" ? "high" : "medium" });
    if (ev.status === "awaiting_review") out.push({ type: "review", title: "Complete clinical review", detail: "Confirm or override AI verdicts before submission.", priority: "medium" });
    if (ev.readiness === "ready" && !db.letters.some((l) => l.caseId === c.id && l.kind !== "appeal"))
      out.push({ type: "draft_letter", title: "Draft a letter of medical necessity", detail: "All criteria are met — generate a cited letter for clinician sign-off.", priority: "medium" });
    if (ev.readiness === "ready" && c.status === "ready") out.push({ type: "submit", title: "Submit to payer", detail: "The packet is complete. Record the submission once sent.", priority: "low" });
  }
  if (c.status === "denied") out.push({ type: "appeal", title: "Start an appeal", detail: "Map the denial reason to policy criteria and draft a redetermination request.", priority: "high" });
  return out;
}

/* ── Routes ─────────────────────────────────────────────────────────────── */
// Auth
route("POST", "/auth/login", ({ db, body }) => {
  const email = String(body.email || "").trim().toLowerCase();
  const user = db.users.find((u) => u.email === email);
  if (!user) fail(401, "Invalid email or password", "Use one of the demo accounts listed below, or choose “Explore the demo”.", "auth.invalid");
  if (user.mfaEnabled) {
    if (!body.mfaCode) return { mfaRequired: true };
    if (String(body.mfaCode) !== "123456") fail(401, "Invalid verification code", "In the demo, the code is 123456.", "auth.mfa_invalid");
  }
  const membership = db.memberships.find((m) => m.userId === user.id);
  db.session = { userId: user.id, orgId: membership?.orgId ?? null };
  user.preferences = user.preferences ?? {};
  appendAudit("auth.login", "session", null, { mfa: user.mfaEnabled });
  saveDB();
  return mePayload(db);
});
route("POST", "/auth/signup", ({ db, body }) => {
  const email = String(body.email || "").trim().toLowerCase();
  if (db.users.some((u) => u.email === email)) fail(409, "Email already registered", "Sign in instead, or use a different email.", "auth.email_taken");
  if (String(body.password || "").length < 12) throw new ApiError({ title: "Validation failed", status: 422, errors: [{ field: "password", msg: "Use at least 12 characters." }] });
  const id = nextId("u");
  db.users.push({
    id,
    email,
    fullName: String(body.fullName || email.split("@")[0]),
    title: null,
    avatarColor: "#3e4bdb",
    mfaEnabled: false,
    preferences: { theme: "system", density: "comfortable" },
    createdAt: new Date().toISOString(),
    password: String(body.password),
  });
  db.session = { userId: id, orgId: null };
  saveDB();
  return { ...mePayload(db), needsOnboarding: true };
});
route("POST", "/auth/logout", ({ db }) => {
  db.session = null;
  saveDB();
  return undefined;
});
route("POST", "/auth/refresh", () => ({ ok: true }));
route("GET", "/auth/csrf", () => ({ csrfToken: "demo-csrf" }));
route("GET", "/auth/me", ({ db }) => mePayload(db));
route("POST", "/auth/switch-org", ({ db, body }) => {
  const { user } = me(db);
  const orgId = String(body.orgId);
  if (!db.memberships.some((m) => m.userId === user.id && m.orgId === orgId)) fail(403, "Not a member of that organization");
  db.session!.orgId = orgId;
  saveDB();
  return mePayload(db);
});
route("POST", "/auth/password/forgot", () => ({ ok: true, devLink: "/reset-password?token=demo-reset-token" }));
route("POST", "/auth/password/reset", ({ body }) => {
  if (String(body.password || "").length < 12) throw new ApiError({ title: "Validation failed", status: 422, errors: [{ field: "password", msg: "Use at least 12 characters." }] });
  return undefined;
});
route("POST", "/auth/mfa/setup", ({ db }) => {
  const { user } = me(db);
  const secret = "JBSWY3DPEHPK3PXP";
  return { secret, otpauthUrl: `otpauth://totp/Necessa:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Necessa` };
});
route("POST", "/auth/mfa/verify", ({ db, body }) => {
  if (!/^\d{6}$/.test(String(body.code || ""))) fail(400, "Invalid code", "Enter the 6-digit code from your authenticator app.", "auth.mfa_invalid");
  const { user } = me(db);
  user.mfaEnabled = true;
  appendAudit("auth.mfa.enable", "user", user.id);
  saveDB();
  return { enabled: true, recoveryCodes: ["7K2Q-9MPD", "X4TB-R8LN", "C9WF-2HJE", "M3VS-6YQA", "P8ZD-1KRT", "H5NC-4UGB"] };
});
route("POST", "/auth/mfa/disable", ({ db }) => {
  const { user } = me(db);
  user.mfaEnabled = false;
  appendAudit("auth.mfa.disable", "user", user.id);
  saveDB();
  return undefined;
});
route("GET", "/auth/sessions", ({ db }) => db.sessions);
route("DELETE", "/auth/sessions/:id", ({ db, params }) => {
  db.sessions = db.sessions.filter((s) => s.id !== params.id);
  saveDB();
  return undefined;
});
route("PATCH", "/users/me", ({ db, body }) => {
  const { user } = me(db);
  if (typeof body.fullName === "string") user.fullName = body.fullName;
  if (typeof body.title === "string") user.title = body.title;
  if (body.preferences && typeof body.preferences === "object") user.preferences = { ...user.preferences, ...(body.preferences as object) };
  const m = db.members.find((x) => x.id === user.id);
  if (m) m.fullName = user.fullName;
  saveDB();
  const { password: _p, ...u } = user;
  return u;
});
route("POST", "/users/me/password", ({ body }) => {
  if (String(body.newPassword || "").length < 12) throw new ApiError({ title: "Validation failed", status: 422, errors: [{ field: "newPassword", msg: "Use at least 12 characters." }] });
  return undefined;
});

// Orgs
route("POST", "/orgs", ({ db, body }) => {
  const { user } = me(db);
  const id = nextId("org");
  const org: Org = {
    id,
    name: String(body.name || "My practice"),
    slug: String(body.name || "practice").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    npi: (body.npi as string) || null,
    specialty: (body.specialty as string) || null,
    practiceType: (body.practiceType as Org["practiceType"]) || "clinic",
    states: (body.states as string[]) || [],
    payers: (body.payers as Org["payers"]) || [],
    timezone: (body.timezone as string) || "America/Chicago",
    settings: { slaHoursStandard: 168, slaHoursExpedited: 72, dataRetentionDays: 365, requireMfa: false, defaultAsOf: "dos" },
    onboardingCompletedAt: null,
    counts: { members: 1, cases: 0, openCases: 0 },
    createdAt: new Date().toISOString(),
  };
  db.orgs.push(org);
  db.memberships.push({ orgId: id, userId: user.id, role: "owner", status: "active" });
  db.session!.orgId = id;
  saveDB();
  return org;
});
route("GET", "/orgs/current", ({ db }) => {
  const { org } = requireOrg(db);
  const mine = orgCases(db);
  const open = mine.filter((c) => !["approved", "closed"].includes(c.status)).length;
  return { ...org, counts: { members: db.memberships.filter((m) => m.orgId === org.id).length, cases: mine.length, openCases: open } };
});
route("PATCH", "/orgs/current", ({ db, body }) => {
  const { org } = requirePerm(db, "org:admin");
  Object.assign(org, body, { settings: { ...org.settings, ...((body.settings as object) ?? {}) } });
  appendAudit("org.update", "organization", org.id, { fields: Object.keys(body) });
  saveDB();
  return org;
});
route("POST", "/orgs/current/onboarding/complete", ({ db }) => {
  const { org } = requireOrg(db);
  org.onboardingCompletedAt = new Date().toISOString();
  saveDB();
  return org;
});
route("GET", "/orgs/current/members", ({ db }) => {
  requireOrg(db);
  return db.members;
});
route("PATCH", "/orgs/current/members/:userId", ({ db, params, body }) => {
  requirePerm(db, "org:admin");
  const m = db.members.find((x) => x.id === params.userId);
  if (!m) fail(404, "Member not found");
  if (body.role) m.role = body.role as Role;
  if (body.status) m.status = body.status as "active" | "suspended";
  const ms = db.memberships.find((x) => x.userId === params.userId);
  if (ms && body.role) ms.role = body.role as Role;
  appendAudit("org.member.update", "membership", params.userId!, body);
  saveDB();
  return m;
});
route("DELETE", "/orgs/current/members/:userId", ({ db, params }) => {
  const { user } = requirePerm(db, "org:admin");
  if (params.userId === user.id) fail(400, "You can't remove yourself");
  db.members = db.members.filter((x) => x.id !== params.userId);
  appendAudit("org.member.remove", "membership", params.userId!);
  saveDB();
  return undefined;
});
route("GET", "/orgs/current/invitations", ({ db }) => db.invitations.filter((i) => !i.acceptedAt));
route("POST", "/orgs/current/invitations", ({ db, body }) => {
  const { org, user } = requirePerm(db, "org:admin");
  const token = `inv-${Math.random().toString(36).slice(2, 10)}`;
  const inv = {
    id: nextId("inv"),
    orgId: org.id,
    token,
    email: String(body.email).toLowerCase(),
    role: body.role as Role,
    invitedBy: { id: user.id, fullName: user.fullName },
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    acceptedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.invitations.unshift(inv);
  appendAudit("org.member.invite", "invitation", inv.id, { email: inv.email, role: inv.role });
  saveDB();
  return { invitation: inv, devLink: `/invite/${token}` };
});
route("DELETE", "/orgs/current/invitations/:id", ({ db, params }) => {
  db.invitations = db.invitations.filter((i) => i.id !== params.id);
  saveDB();
  return undefined;
});
route("GET", "/invitations/:token", ({ db, params }) => {
  const inv = db.invitations.find((i) => i.token === params.token);
  if (!inv) fail(404, "Invitation not found", "This invitation link is invalid or has expired.");
  const org = db.orgs.find((o) => o.id === inv.orgId)!;
  return { orgName: org.name, email: inv.email, role: inv.role, expiresAt: inv.expiresAt };
});
route("POST", "/invitations/:token/accept", ({ db, params, body }) => {
  const inv = db.invitations.find((i) => i.token === params.token);
  if (!inv) fail(404, "Invitation not found");
  let user = db.users.find((u) => u.email === inv.email);
  if (!user) {
    user = {
      id: nextId("u"),
      email: inv.email,
      fullName: String(body.fullName || inv.email.split("@")[0]),
      title: null,
      avatarColor: "#0f7a55",
      mfaEnabled: false,
      preferences: { theme: "system" },
      createdAt: new Date().toISOString(),
      password: String(body.password || "demo"),
    };
    db.users.push(user);
  }
  db.memberships.push({ orgId: inv.orgId, userId: user.id, role: inv.role, status: "active" });
  db.members.push({ id: user.id, fullName: user.fullName, email: user.email, role: inv.role, status: "active", lastLoginAt: new Date().toISOString(), mfaEnabled: false, avatarColor: user.avatarColor });
  inv.acceptedAt = new Date().toISOString();
  db.session = { userId: user.id, orgId: inv.orgId };
  saveDB();
  return mePayload(db);
});
route("GET", "/orgs/current/api-keys", ({ db }) => db.apiKeys.filter((k) => !k.revokedAt));
route("POST", "/orgs/current/api-keys", ({ db, body }) => {
  requirePerm(db, "org:admin");
  const rand = Array.from({ length: 32 }, () => "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 57)]).join("");
  const key: ApiKey = {
    id: nextId("key"),
    name: String(body.name || "Untitled key"),
    prefix: `nk_live_${rand.slice(0, 4)}`,
    scopes: (body.scopes as string[]) || ["cases:read"],
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    revokedAt: null,
  };
  db.apiKeys.unshift(key);
  appendAudit("org.api_key.create", "api_key", key.id, { name: key.name });
  saveDB();
  return { apiKey: key, secret: `nk_live_${rand}` };
});
route("DELETE", "/orgs/current/api-keys/:id", ({ db, params }) => {
  const k = db.apiKeys.find((x) => x.id === params.id);
  if (k) k.revokedAt = new Date().toISOString();
  appendAudit("org.api_key.revoke", "api_key", params.id!);
  saveDB();
  return undefined;
});
route("POST", "/orgs/current/demo-data", ({ db }) => {
  const { org } = requirePerm(db, "org:admin");
  const fresh = seed();
  const taken = new Set(db.cases.map((c) => c.id));
  const suffix = org.id === "org-riverbend" ? "" : `-${org.id}`;
  const rename = (id: string) => (taken.has(id) && suffix ? `${id}${suffix}` : id);
  if (org.id === "org-riverbend") {
    db.cases = db.cases.filter((c) => orgOf(c) !== org.id);
  }
  const idMap = new Map(fresh.cases.map((c) => [c.id, rename(c.id)]));
  const evMap = new Map(fresh.evaluations.map((e) => [e.id, suffix ? `${e.id}${suffix}` : e.id]));
  db.cases.push(...fresh.cases.map((c) => ({ ...c, id: idMap.get(c.id)!, orgId: org.id, latestEvaluationId: c.latestEvaluationId ? evMap.get(c.latestEvaluationId) ?? null : null })));
  db.documents.push(...fresh.documents.filter((d) => !db.documents.some((x) => x.id === d.id && x.caseId === idMap.get(d.caseId))).map((d) => ({ ...d, caseId: idMap.get(d.caseId)! })));
  db.evaluations.push(...fresh.evaluations.filter((e) => !db.evaluations.some((x) => x.id === evMap.get(e.id))).map((e) => ({ ...e, id: evMap.get(e.id)!, caseId: idMap.get(e.caseId)! })));
  db.events.push(...fresh.events.map((e) => ({ ...e, id: `${e.id}${suffix}`, caseId: idMap.get(e.caseId)! })));
  db.letters.push(...fresh.letters.filter((l) => !db.letters.some((x) => x.id === `${l.id}${suffix}`)).map((l) => ({ ...l, id: `${l.id}${suffix}`, caseId: idMap.get(l.caseId)! })));
  db.denials.push(...fresh.denials.filter((d) => !db.denials.some((x) => x.id === `${d.id}${suffix}`)).map((d) => ({ ...d, id: `${d.id}${suffix}`, caseId: idMap.get(d.caseId)! })));
  for (const p of fresh.patients) if (!db.patients.some((x) => x.id === p.id)) db.patients.push(p);
  for (const m of fresh.members) if (!db.members.some((x) => x.id === m.id)) db.members.push(m);
  appendAudit("org.demo_data.load", "organization", org.id, { cases: fresh.cases.length });
  saveDB();
  return job("demo.seed", "succeeded", { cases: fresh.cases.length });
});

// Cases
route("GET", "/cases/stats", ({ db }) => {
  const by = (k: keyof Case) =>
    orgCases(db).reduce<Record<string, number>>((acc, c) => {
      const v = String(c[k]);
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {});
  return { byStatus: by("status"), byReadiness: by("readiness"), total: orgCases(db).length };
});
route("GET", "/cases", ({ db, query }) => {
  const { user } = requireOrg(db);
  let items = [...orgCases(db)];
  const status = query.getAll("status").flatMap((s) => s.split(","));
  if (status.length) items = items.filter((c) => status.includes(c.status));
  const readiness = query.get("readiness");
  if (readiness) items = items.filter((c) => readiness.split(",").includes(c.readiness));
  const priority = query.get("priority");
  if (priority) items = items.filter((c) => c.priority === priority);
  const payerType = query.get("payerType");
  if (payerType) items = items.filter((c) => c.payerType === payerType);
  const assignee = query.get("assignee");
  if (assignee === "me") items = items.filter((c) => c.assignee?.id === user.id);
  else if (assignee === "none") items = items.filter((c) => !c.assignee);
  else if (assignee) items = items.filter((c) => c.assignee?.id === assignee);
  const dueBefore = query.get("dueBefore");
  if (dueBefore) items = items.filter((c) => c.dueAt && c.dueAt <= dueBefore);
  const q = query.get("q")?.toLowerCase();
  if (q)
    items = items.filter((c) =>
      [c.number, c.title, c.payerName, c.patient.displayName, ...c.serviceCodes, ...c.dxCodes].join(" ").toLowerCase().includes(q),
    );
  const sort = query.get("sort") || "-updatedAt";
  const desc = sort.startsWith("-");
  const key = sort.replace(/^-/, "") as keyof Case;
  items.sort((a, b) => {
    const av = (a[key] ?? "") as string | number;
    const bv = (b[key] ?? "") as string | number;
    if (key === "dueAt") {
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
    }
    return (av > bv ? 1 : av < bv ? -1 : 0) * (desc ? -1 : 1);
  });
  return paginate(items.map(summarize), query);
});
route("POST", "/cases/policy-suggestions", ({ db, body }) => ({
  matches: resolvePolicies(db, {
    serviceCodes: (body.serviceCodes as string[]) ?? [],
    dxCodes: (body.dxCodes as string[]) ?? [],
    state: body.state as string,
    payerType: body.payerType as string,
    dateOfService: body.dateOfService as string,
  }),
}));
route("POST", "/cases", ({ db, body }) => {
  const { user } = requirePerm(db, "cases:write");
  let patientId = body.patientId as string | undefined;
  if (!patientId) {
    const p = (body.patient ?? {}) as Record<string, string>;
    patientId = nextId("pt");
    db.patients.push({ id: patientId, fullName: p.fullName || "Unnamed Patient", dob: p.dob || "1950-01-01", sex: (p.sex as "F" | "M") || "F", state: p.state || String(body.state || "TX"), memberId: p.memberId || "—", mrn: `RB-${Math.floor(Math.random() * 900000 + 100000)}` });
  }
  const pt = db.patients.find((p) => p.id === patientId)!;
  const n = Math.max(0, ...db.cases.map((c) => Number(c.number.slice(-5)))) + 1;
  const priority = (body.priority as Case["priority"]) || "standard";
  const org = db.orgs.find((o) => o.id === db.session!.orgId)!;
  const slaH = priority === "expedited" ? org.settings.slaHoursExpedited : org.settings.slaHoursStandard;
  const matches = resolvePolicies(db, { serviceCodes: (body.serviceCodes as string[]) ?? [], dxCodes: (body.dxCodes as string[]) ?? [], state: String(body.state || pt.state) });
  const c: Case & { orgId?: string } = {
    orgId: db.session!.orgId!,
    id: nextId("case"),
    number: `NC-2026-${String(n).padStart(5, "0")}`,
    title: String(body.title || "New prior authorization"),
    status: "draft",
    priority,
    payerType: (body.payerType as Case["payerType"]) || "medicare_ffs",
    payerName: String(body.payerName || "Medicare Part B"),
    state: String(body.state || pt.state),
    serviceCodes: (body.serviceCodes as string[]) ?? [],
    dxCodes: (body.dxCodes as string[]) ?? [],
    dateOfService: String(body.dateOfService || new Date().toISOString().slice(0, 10)),
    readiness: "unknown",
    readinessScore: null,
    dueAt: new Date(Date.now() + slaH * 3600_000).toISOString(),
    assignee: body.assigneeId ? db.members.filter((m) => m.id === body.assigneeId).map((m) => ({ id: m.id, fullName: m.fullName, avatarColor: m.avatarColor }))[0] ?? null : { id: user.id, fullName: user.fullName, avatarColor: user.avatarColor },
    patient: { id: pt.id, displayName: masked(pt.fullName), birthYear: Number(pt.dob.slice(0, 4)), sex: pt.sex },
    updatedAt: new Date().toISOString(),
    placeOfService: (body.placeOfService as string) || null,
    policyRefs: matches.slice(0, 1).map((m) => ({ policyId: m.policyId, policyVersionId: m.policyVersionId, sourceKey: m.sourceKey, title: m.title, version: m.version })),
    latestEvaluationId: null,
    outcome: null,
    outcomeAt: null,
    submittedAt: null,
    tags: (body.tags as string[]) ?? [],
    documentsCount: 0,
    createdBy: { id: user.id, fullName: user.fullName, avatarColor: user.avatarColor },
    createdAt: new Date().toISOString(),
  };
  db.cases.unshift(c);
  addEvent(c.id, "created", { title: c.title });
  appendAudit("case.create", "case", c.id, { number: c.number });
  saveDB();
  return c;
});
route("GET", "/cases/:id", ({ db, params, query }) => {
  const c = getCase(db, params.id!);
  if (query.get("reveal") === "true") {
    const pt = db.patients.find((p) => p.id === c.patient.id);
    appendAudit("patient.reveal_phi", "patient", c.patient.id, { caseId: c.id });
    saveDB();
    return { ...c, documentsCount: db.documents.filter((d) => d.caseId === c.id).length, patientRevealed: pt ? { fullName: pt.fullName, dob: pt.dob, memberId: pt.memberId, mrn: pt.mrn } : null };
  }
  return { ...c, documentsCount: db.documents.filter((d) => d.caseId === c.id).length };
});
route("PATCH", "/cases/:id", ({ db, params, body }) => {
  requirePerm(db, "cases:write");
  const c = getCase(db, params.id!);
  if (body.status && body.status !== c.status) {
    addEvent(c.id, "status_changed", { from: c.status, to: body.status });
    if (body.status === "submitted") c.submittedAt = new Date().toISOString();
  }
  if ("assigneeId" in body) {
    const m = db.members.find((x) => x.id === body.assigneeId);
    c.assignee = m ? { id: m.id, fullName: m.fullName, avatarColor: m.avatarColor } : null;
    addEvent(c.id, "assigned", { to: m?.fullName ?? "Unassigned" });
  }
  const { assigneeId: _a, ...rest } = body;
  Object.assign(c, rest);
  touch(c);
  saveDB();
  return c;
});
route("DELETE", "/cases/:id", ({ db, params }) => {
  const c = getCase(db, params.id!);
  c.status = "closed";
  addEvent(c.id, "status_changed", { to: "closed" });
  appendAudit("case.close", "case", c.id);
  saveDB();
  return undefined;
});
route("GET", "/cases/:id/documents", ({ db, params }) =>
  db.documents.filter((d) => d.caseId === params.id).map(({ text: _t, ...d }) => d),
);
route("GET", "/cases/:id/documents/:docId", ({ db, params, query }) => {
  const d = db.documents.find((x) => x.id === params.docId && x.caseId === params.id);
  if (!d) fail(404, "Document not found");
  if (query.get("reveal") === "true") {
    const c = getCase(db, params.id!);
    const pt = db.patients.find((p) => p.id === c.patient.id);
    appendAudit("document.reveal_phi", "case_document", d.id, { caseId: c.id });
    saveDB();
    const text = (d.text ?? "")
      .replaceAll("[PATIENT_NAME]", pt?.fullName ?? "")
      .replaceAll("[DOB]", pt ? new Date(pt.dob).toLocaleDateString("en-US") : "")
      .replaceAll("[MRN]", pt?.mrn ?? "")
      .replaceAll("[MEMBER_ID]", pt?.memberId ?? "");
    return { ...d, text, revealed: true };
  }
  return d;
});
function addDocument(db: DemoDB, caseId: string, kind: CaseDocument["kind"], filename: string, text: string, size: number, noteDate?: string | null) {
  const c = getCase(db, caseId);
  const pt = db.patients.find((p) => p.id === c.patient.id);
  let deid = text;
  let redactions = 0;
  if (pt) {
    for (const [needle, token] of [
      [pt.fullName, "[PATIENT_NAME]"],
      [pt.mrn, "[MRN]"],
      [pt.memberId, "[MEMBER_ID]"],
    ] as const) {
      if (needle && deid.includes(needle)) {
        redactions += deid.split(needle).length - 1;
        deid = deid.replaceAll(needle, token);
      }
    }
  }
  deid = deid.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => (redactions++, "[SSN]")).replace(/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, () => (redactions++, "[PHONE]"));
  const suspicious = /ignore (all )?(previous|prior) instructions|disregard the (system|above)|mark (every|all) criteri/i.test(text);
  const u = me(db).user;
  const doc: CaseDocument = {
    id: nextId("doc"),
    caseId,
    kind,
    filename,
    mime: filename.endsWith(".pdf") ? "application/pdf" : "text/plain",
    sizeBytes: size,
    pageCount: Math.max(1, Math.round(text.length / 1800)),
    ocrUsed: false,
    injectionScore: suspicious ? 0.88 : 0.03,
    quarantined: suspicious,
    noteDate: noteDate || new Date().toISOString().slice(0, 10),
    uploadedBy: { id: u.id, fullName: u.fullName, avatarColor: u.avatarColor },
    createdAt: new Date().toISOString(),
    text: deid,
    redactions,
  };
  db.documents.push(doc);
  c.documentsCount += 1;
  touch(c);
  addEvent(caseId, "document_added", { filename, redactions, quarantined: suspicious });
  appendAudit("document.upload", "case_document", doc.id, { kind, redactions, quarantined: suspicious });
  if (suspicious) {
    appendAudit("guardrail.injection.quarantine", "case_document", doc.id, { score: doc.injectionScore });
    notify({ type: "security", title: "Document quarantined", body: `${filename} contained instruction-like text and was excluded from evidence.`, link: `/cases/${caseId}?tab=documents` });
  }
  saveDB();
  const { text: _t, ...rest } = doc;
  return rest;
}
route("POST", "/cases/:id/documents/text", ({ db, params, body }) =>
  addDocument(db, params.id!, (body.kind as CaseDocument["kind"]) || "clinical_note", `${String(body.title || "pasted-note").replace(/\s+/g, "-").toLowerCase()}.txt`, String(body.text || ""), String(body.text || "").length, body.noteDate as string),
);
route("POST", "/cases/:id/documents", async ({ db, params, form }) => {
  const file = form?.get("file");
  if (!(file instanceof File)) fail(422, "No file provided");
  const text = file.type.startsWith("text/") || file.name.endsWith(".txt") || file.name.endsWith(".json") ? await file.text() : `Extracted text from ${file.name}\n\n[Binary document stored encrypted. Text extraction runs on the server; this demo stores the file name only.]`;
  return addDocument(db, params.id!, (form?.get("kind") as CaseDocument["kind"]) || "clinical_note", file.name, text, file.size, (form?.get("noteDate") as string) || null);
});
route("DELETE", "/cases/:id/documents/:docId", ({ db, params }) => {
  db.documents = db.documents.filter((d) => d.id !== params.docId);
  const c = getCase(db, params.id!);
  c.documentsCount = Math.max(0, c.documentsCount - 1);
  addEvent(c.id, "document_removed", { documentId: params.docId });
  saveDB();
  return undefined;
});
route("GET", "/cases/:id/timeline", ({ db, params }) =>
  db.events.filter((e) => e.caseId === params.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
);
route("POST", "/cases/:id/comments", ({ db, params, body }) => {
  getCase(db, params.id!);
  addEvent(params.id!, "comment", { body: String(body.body || "") });
  saveDB();
  return db.events[db.events.length - 1];
});
route("POST", "/cases/:id/outcome", ({ db, params, body }) => {
  const c = getCase(db, params.id!);
  c.outcome = body.outcome as Case["outcome"];
  c.outcomeAt = new Date().toISOString();
  c.status = c.outcome === "approved" ? "approved" : c.outcome === "denied" ? "denied" : "closed";
  addEvent(c.id, "outcome_recorded", { outcome: c.outcome, note: body.note });
  appendAudit("case.outcome", "case", c.id, { outcome: c.outcome });
  saveDB();
  return c;
});
route("GET", "/patients", ({ db }) =>
  db.patients.map((p) => ({ id: p.id, displayName: masked(p.fullName), birthYear: Number(p.dob.slice(0, 4)), sex: p.sex, state: p.state })),
);

// Case AI
route("POST", "/cases/:id/policy-suggestions", ({ db, params }) => {
  const c = getCase(db, params.id!);
  return { matches: resolvePolicies(db, { serviceCodes: c.serviceCodes, dxCodes: c.dxCodes, state: c.state }) };
});
route("POST", "/cases/:id/evaluate", ({ db, params }) => {
  requirePerm(db, "cases:write");
  const c = getCase(db, params.id!);
  const evaluationId = nextId("eval");
  db.pending = db.pending.filter((p) => !(p.caseId === c.id && p.kind === "evaluation"));
  db.pending.push({ kind: "evaluation", caseId: c.id, id: evaluationId });
  c.status = "evaluating";
  touch(c);
  addEvent(c.id, "evaluation_started", {});
  appendAudit("case.evaluate", "case", c.id);
  saveDB();
  const j = job("case.evaluate", "running", {});
  return { evaluationId, jobId: j.id };
});
route("GET", "/cases/:id/evaluations", ({ db, params }) =>
  db.evaluations
    .filter((e) => e.caseId === params.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((e) => ({ id: e.id, status: e.status, readiness: e.readiness, readinessScore: e.readinessScore, startedAt: e.startedAt, finishedAt: e.finishedAt, degraded: e.degraded })),
);
route("GET", "/cases/:id/evaluations/:evalId", ({ db, params }) => {
  const e = db.evaluations.find((x) => x.id === params.evalId && x.caseId === params.id);
  if (!e) fail(404, "Evaluation not found");
  return e;
});
function recompute(db: DemoDB, e: Evaluation) {
  const c = getCase(db, e.caseId);
  const set = db.criteriaSets.find((s) => s.policyVersionId === e.policies[0]?.policyVersionId);
  const verdicts: Record<string, Verdict> = Object.fromEntries(e.criteria.map((r) => [r.criterionId, r.effectiveVerdict]));
  if (set) e.tree = evaluateTree(set.tree, verdicts);
  const met = e.criteria.filter((r) => r.effectiveVerdict === "MET").length;
  e.readinessScore = Math.round((met / Math.max(1, e.criteria.length)) * 100) / 100;
  e.readiness = e.tree?.verdict === "MET" ? "ready" : e.criteria.some((r) => r.effectiveVerdict === "NOT_MET") ? "not_supported" : "gaps";
  e.gaps = e.gaps.filter((g) => verdicts[g.criterionId] !== "MET");
  c.readiness = e.readiness;
  c.readinessScore = e.readinessScore;
}
route("PATCH", "/cases/:id/criteria/:resultId", ({ db, params, body }) => {
  const { user } = requirePerm(db, "cases:review");
  const e = db.evaluations.find((x) => x.caseId === params.id && x.criteria.some((r) => r.id === params.resultId));
  if (!e) fail(404, "Criterion result not found");
  const r = e.criteria.find((x) => x.id === params.resultId) as CriterionResult;
  const reason = String(body.overrideReason || "").trim();
  if (body.overrideVerdict === null) {
    r.override = null;
    r.effectiveVerdict = r.verdict;
  } else {
    if (reason.length < 8) throw new ApiError({ title: "Validation failed", status: 422, errors: [{ field: "overrideReason", msg: "Explain the override (at least 8 characters)." }] });
    r.override = { verdict: body.overrideVerdict as Verdict, reason, by: { id: user.id, fullName: user.fullName, avatarColor: user.avatarColor }, at: new Date().toISOString() };
    r.effectiveVerdict = body.overrideVerdict as Verdict;
  }
  recompute(db, e);
  addEvent(params.id!, "verdict_overridden", { criterionId: r.criterionId, to: r.effectiveVerdict, reason });
  appendAudit("case.criterion.override", "case", params.id!, { criterionId: r.criterionId, from: r.verdict, to: r.effectiveVerdict });
  saveDB();
  return r;
});
route("POST", "/cases/:id/evaluations/:evalId/complete-review", ({ db, params }) => {
  requirePerm(db, "cases:review");
  const e = db.evaluations.find((x) => x.id === params.evalId);
  if (!e) fail(404, "Evaluation not found");
  e.status = "completed";
  const c = getCase(db, params.id!);
  c.status = e.readiness === "ready" ? "ready" : "needs_review";
  addEvent(c.id, "review_completed", { readiness: e.readiness });
  appendAudit("case.review.complete", "case", c.id, { readiness: e.readiness });
  saveDB();
  return e;
});
route("GET", "/cases/:id/next-actions", ({ db, params }) => nextActions(db, getCase(db, params.id!)));
route("GET", "/cases/:id/letters", ({ db, params }) => db.letters.filter((l) => l.caseId === params.id));
route("POST", "/cases/:id/letters", ({ db, params, body }) => {
  requirePerm(db, "cases:write");
  const c = getCase(db, params.id!);
  const kind = (body.kind as Letter["kind"]) || "lmn";
  const letter: Letter = {
    id: nextId("let"),
    caseId: c.id,
    kind,
    status: "draft",
    title: `${kind === "appeal" ? "Redetermination request" : kind === "pa_cover" ? "Prior authorization cover letter" : kind === "peer_to_peer_prep" ? "Peer-to-peer preparation brief" : "Letter of Medical Necessity"} — ${c.title}`,
    contentMd: "",
    version: 1,
    citations: [],
    modelInfo: { drafter: "groq/llama-3.3-70b-versatile", verifier: "gemini/gemini-2.5-flash" },
    createdBy: me(db).user,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.letters.unshift(letter);
  db.pending.push({ kind: "letter", caseId: c.id, id: letter.id });
  addEvent(c.id, "letter_drafted", { kind });
  saveDB();
  return { letterId: letter.id, jobId: job("letter.draft", "running", {}).id };
});
route("GET", "/cases/:id/letters/:letterId", ({ db, params }) => {
  const l = db.letters.find((x) => x.id === params.letterId);
  if (!l) fail(404, "Letter not found");
  return l;
});
route("PATCH", "/cases/:id/letters/:letterId", ({ db, params, body }) => {
  const l = db.letters.find((x) => x.id === params.letterId);
  if (!l) fail(404, "Letter not found");
  if (body.status === "approved") {
    const { user } = requirePerm(db, "letters:approve");
    l.approvedBy = { id: user.id, fullName: user.fullName, avatarColor: user.avatarColor };
    l.approvedAt = new Date().toISOString();
    addEvent(params.id!, "letter_approved", { letterId: l.id });
    appendAudit("letter.approve", "letter", l.id, { version: l.version });
  }
  if (typeof body.contentMd === "string" && body.contentMd !== l.contentMd) {
    l.contentMd = body.contentMd;
    l.version += 1;
  }
  if (body.status) l.status = body.status as Letter["status"];
  l.updatedAt = new Date().toISOString();
  saveDB();
  return l;
});
route("GET", "/cases/:id/denials", ({ db, params }) => db.denials.filter((d) => d.caseId === params.id));
route("POST", "/cases/:id/denials", ({ db, params, body }) => {
  const c = getCase(db, params.id!);
  const text = String(body.text || "");
  const carc = ((body.carcCodes as string[]) ?? []).length ? (body.carcCodes as string[]) : (text.match(/CARC\s*(\d+)/gi) ?? []).map((m) => m.replace(/\D/g, ""));
  const rarc = (text.match(/\b[MN]\d{2,3}\b/g) ?? []).slice(0, 3);
  const ev = db.evaluations.find((e) => e.id === c.latestEvaluationId);
  const words = text.toLowerCase();
  const mapped = (ev?.criteria ?? [])
    .map((r) => {
      const overlap = r.text.toLowerCase().split(/\W+/).filter((w) => w.length > 4 && words.includes(w)).length;
      return { criterionId: r.criterionId, text: r.text, confidence: Math.min(0.97, 0.35 + overlap * 0.18) };
    })
    .filter((m) => m.confidence > 0.5)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
  const denial: Denial = {
    id: nextId("den"),
    caseId: c.id,
    caseNumber: c.number,
    caseTitle: c.title,
    payerName: c.payerName,
    documentId: (body.documentId as string) || null,
    receivedAt: String(body.receivedAt || new Date().toISOString().slice(0, 10)),
    reasonText: text || "Denial reason not provided.",
    carcCodes: carc.length ? carc : ["50"],
    rarcCodes: rarc,
    category: /document/i.test(text) ? "documentation" : /code|modifier/i.test(text) ? "coding" : /eligib/i.test(text) ? "eligibility" : "medical_necessity",
    mappedCriteria: mapped,
    appealDeadline: new Date(Date.now() + 120 * 86400_000).toISOString().slice(0, 10),
    appealLetterId: null,
    status: "new",
    analysis: { summary: mapped.length ? `Denial language maps most closely to ${mapped.map((m) => m.criterionId).join(", ")}.` : "No confident criterion mapping — review manually.", strategy: ["Gather records addressing the mapped criteria", "Quote the policy language verbatim", "Request redetermination within 120 days"] },
    createdAt: new Date().toISOString(),
  };
  db.denials.unshift(denial);
  c.status = "denied";
  c.outcome = "denied";
  addEvent(c.id, "denial_recorded", { carc: denial.carcCodes });
  appendAudit("denial.record", "denial", denial.id, { carc: denial.carcCodes });
  notify({ type: "denial", title: `Denial recorded: ${c.number}`, body: denial.analysis?.summary ?? "", link: `/cases/${c.id}?tab=denials` });
  saveDB();
  return denial;
});
route("PATCH", "/cases/:id/denials/:denialId", ({ db, params, body }) => {
  const d = db.denials.find((x) => x.id === params.denialId);
  if (!d) fail(404, "Denial not found");
  Object.assign(d, body);
  if (body.status === "appealed") {
    const c = getCase(db, params.id!);
    c.status = "appealing";
  }
  saveDB();
  return d;
});
route("GET", "/cases/:id/export/fhir", ({ db, params }) => {
  const c = getCase(db, params.id!);
  const e = db.evaluations.find((x) => x.id === c.latestEvaluationId);
  return {
    resourceType: "QuestionnaireResponse",
    status: "completed",
    subject: { reference: `Patient/${c.patient.id}` },
    authored: new Date().toISOString(),
    questionnaire: `urn:necessa:criteria:${c.policyRefs[0]?.sourceKey ?? "unknown"}`,
    item: (e?.criteria ?? []).map((r) => ({ linkId: r.criterionId, text: r.text, answer: [{ valueCoding: { system: "urn:necessa:verdict", code: r.effectiveVerdict } }] })),
  };
});

// Knowledge
function toSummary(db: DemoDB, p: DemoDB["policies"][number], snippet?: string, score?: number): PolicySummary {
  return {
    id: p.id,
    sourceKey: p.sourceKey,
    title: p.title,
    docType: p.docType,
    status: p.status,
    version: p.version,
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo,
    contractors: p.contractors,
    states: p.states,
    codeCount: p.codeCount,
    hasCriteria: db.criteriaSets.some((s) => s.policyVersionId === p.currentVersionId && s.status === "approved"),
    snippet: snippet ?? null,
    score: score ?? null,
  };
}
route("GET", "/policies", ({ db, query }) => {
  let items = [...db.policies];
  const docType = query.get("docType");
  if (docType) items = items.filter((p) => docType.split(",").includes(p.docType));
  const state = query.get("state");
  if (state) items = items.filter((p) => p.states.includes(state) || p.docType === "NCD");
  const status = query.get("status");
  if (status) items = items.filter((p) => p.status === status);
  const asOf = query.get("asOf");
  if (asOf) items = items.filter((p) => p.effectiveFrom <= asOf && (!p.effectiveTo || p.effectiveTo >= asOf));
  const contractorId = query.get("contractorId");
  if (contractorId) items = items.filter((p) => p.contractors.some((c) => String(c.id) === contractorId));
  const code = query.get("code")?.toUpperCase();
  if (code) items = items.filter((p) => (db.policyCodes[p.id] ?? []).some((c) => c.code === code));
  const q = query.get("q")?.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/).filter((t) => t.length > 1);
    const scored = items
      .map((p) => {
        const hay = `${p.sourceKey} ${p.title} ${p.sections.map((s) => s.text).join(" ")}`.toLowerCase();
        const exact = p.sourceKey.toLowerCase() === q ? 5 : 0;
        const hits = terms.reduce((a, t) => a + (hay.split(t).length - 1), 0);
        const titleHits = terms.filter((t) => p.title.toLowerCase().includes(t)).length * 3;
        const sec = p.sections.find((s) => terms.some((t) => s.text.toLowerCase().includes(t)));
        let snippet: string | undefined;
        if (sec) {
          const t = terms.find((x) => sec.text.toLowerCase().includes(x))!;
          const i = sec.text.toLowerCase().indexOf(t);
          snippet = `${i > 60 ? "…" : ""}${sec.text.slice(Math.max(0, i - 60), i + 160)}…`;
        }
        return { p, s: exact + hits * 0.2 + titleHits, snippet };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    const max = scored[0]?.s ?? 1;
    return paginate(scored.map((x) => toSummary(db, x.p, x.snippet, Math.round((x.s / max) * 100) / 100)), query);
  }
  items.sort((a, b) => (a.docType === b.docType ? a.sourceKey.localeCompare(b.sourceKey) : a.docType.localeCompare(b.docType)));
  return paginate(items.map((p) => toSummary(db, p)), query);
});
route("GET", "/policies/:id", ({ db, params }) => {
  const p = db.policies.find((x) => x.id === params.id || x.sourceKey === params.id);
  if (!p) fail(404, "Policy not found");
  return { ...p, hasCriteria: db.criteriaSets.some((s) => s.policyVersionId === p.currentVersionId && s.status === "approved") };
});
route("GET", "/policies/:id/versions/:vid", ({ db, params }) => {
  const p = db.policies.find((x) => x.id === params.id);
  if (!p) fail(404, "Policy not found");
  const v = p.versions.find((x) => x.id === params.vid);
  return { ...v, sections: p.sections };
});
route("GET", "/policies/:id/diff", ({ db, params, query }) => {
  const p = db.policies.find((x) => x.id === params.id);
  if (!p) fail(404, "Policy not found");
  const from = Number(query.get("from") || p.version - 1);
  const to = Number(query.get("to") || p.version);
  const diff: PolicyDiff = {
    from,
    to,
    sections: p.sections.map((s, i) => {
      if (i === 0) {
        const sentences = s.text.split(/(?<=\.)\s+/);
        const last = sentences.pop() ?? "";
        return {
          sectionKey: s.sectionKey,
          title: s.title,
          status: "changed" as const,
          hunks: [
            { op: "equal" as const, text: sentences.join(" ") + " " },
            { op: "delete" as const, text: "Advanced imaging should be reviewed when clinically indicated. " },
            { op: "insert" as const, text: last },
          ],
        };
      }
      if (s.sectionKey === "doc_reqs")
        return {
          sectionKey: s.sectionKey,
          title: s.title,
          status: "changed" as const,
          hunks: [
            { op: "equal" as const, text: s.text.split(".")[0] + ". " },
            { op: "insert" as const, text: s.text.split(".").slice(1).join(".").trim() },
          ],
        };
      return { sectionKey: s.sectionKey, title: s.title, status: "same" as const, hunks: [{ op: "equal" as const, text: s.text }] };
    }),
  };
  return diff;
});
route("GET", "/policies/:id/codes", ({ db, params, query }) => {
  const system = query.get("system");
  const codes = (db.policyCodes[params.id!] ?? []).filter((c) => !system || c.codeSystem === system);
  return paginate(codes, query);
});
route("GET", "/policies/:id/criteria", ({ db, params }) => {
  const p = db.policies.find((x) => x.id === params.id);
  const s = p && db.criteriaSets.find((x) => x.policyVersionId === p.currentVersionId);
  if (!s) fail(404, "No compiled criteria", "Criteria have not been compiled for this policy version yet.");
  return s;
});
route("GET", "/codes/search", ({ db, query }) => {
  const q = (query.get("q") || "").trim().toLowerCase();
  const system = query.get("system");
  let items = db.codes.filter((c) => !system || c.system === system);
  if (q) {
    items = items
      .map((c) => ({ c, s: c.code.toLowerCase() === q ? 10 : c.code.toLowerCase().startsWith(q) ? 6 : c.shortDesc.toLowerCase().includes(q) ? 3 : q.split(/\s+/).filter((t) => c.shortDesc.toLowerCase().includes(t)).length }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }
  return items.slice(0, 20);
});
route("GET", "/codes/:system/:code", ({ db, params }) => {
  const c = db.codes.find((x) => x.code === params.code);
  if (!c) fail(404, "Code not found");
  const policies = db.policies.filter((p) => (db.policyCodes[p.id] ?? []).some((x) => x.code === c.code)).map((p) => toSummary(db, p));
  return { ...c, policies };
});
route("GET", "/codes/:system/:code/graph", ({ db, params, query }) => {
  const code = params.code!;
  const stateFilter = query.get("state");
  const graph: CoverageGraph = { nodes: [{ id: `code:${code}`, type: "code", label: code, meta: { desc: db.codes.find((c) => c.code === code)?.shortDesc } }], edges: [] };
  const seen = new Set<string>([`code:${code}`]);
  const add = (n: CoverageGraph["nodes"][number]) => {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      graph.nodes.push(n);
    }
  };
  const direct = db.policies.filter((p) => (db.policyCodes[p.id] ?? []).some((x) => x.code === code));
  for (const p of direct) {
    const pid = `${p.docType === "LCD" ? "lcd" : p.docType === "NCD" ? "ncd" : "article"}:${p.sourceKey}`;
    add({ id: pid, type: p.docType === "LCD" ? "lcd" : p.docType === "NCD" ? "ncd" : "article", label: p.sourceKey, meta: { title: p.title, version: p.version } });
    graph.edges.push({ source: `code:${code}`, target: pid, type: "listed_in" });
    for (const l of p.linked) {
      const lp = db.policies.find((x) => x.id === l.policyId);
      if (!lp) continue;
      const lid = `${lp.docType === "LCD" ? "lcd" : lp.docType === "NCD" ? "ncd" : "article"}:${lp.sourceKey}`;
      add({ id: lid, type: lp.docType === "LCD" ? "lcd" : lp.docType === "NCD" ? "ncd" : "article", label: lp.sourceKey, meta: { title: lp.title, version: lp.version } });
      graph.edges.push({ source: pid, target: lid, type: l.relation });
    }
  }
  for (const n of [...graph.nodes]) {
    if (n.type !== "lcd") continue;
    const p = db.policies.find((x) => x.sourceKey === n.label)!;
    for (const c of p.contractors) {
      const cid = `contractor:${c.id}`;
      add({ id: cid, type: "contractor", label: c.name.replace(/, (LLC|Inc\.)/, "").replace(/ \(.*\)/, ""), meta: { name: c.name } });
      graph.edges.push({ source: n.id, target: cid, type: "issued_by" });
      for (const s of p.states.filter((x) => !stateFilter || x === stateFilter).slice(0, stateFilter ? 1 : 6)) {
        add({ id: `state:${s}`, type: "state", label: s });
        graph.edges.push({ source: cid, target: `state:${s}`, type: "serves" });
      }
    }
  }
  return graph;
});
route("GET", "/knowledge/stats", ({ db }) => ({
  policies: db.policies.reduce<Record<string, number>>((a, p) => ((a[p.docType] = (a[p.docType] ?? 0) + 1), a), { LCD: 953 - 13, Article: 2053 - 12, NCD: 357 - 4 }),
  versions: 7_624,
  chunks: db.indexVersions.find((i) => i.status === "active" && i.alias === "policy_chunks")?.points ?? 0,
  codes: 79_544,
  lastIngestion: db.ingestionRuns[0]?.finishedAt ?? null,
  activeIndex: db.indexVersions.find((i) => i.status === "active" && i.alias === "policy_chunks")?.physicalName ?? null,
  freshnessHours: 33,
}));
route("POST", "/search/retrieve", async ({ body }) => {
  const { buildRetrieval } = await import("./streams");
  return buildRetrieval(String(body.query || ""));
});

// Assistant
route("GET", "/assistant/conversations", ({ db, query }) =>
  paginate(
    [...db.conversations].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt)).map(({ messages: _m, ...c }) => c),
    query,
  ),
);
route("POST", "/assistant/conversations", ({ db, body }) => {
  const c = { id: nextId("conv"), title: String(body.title || "New conversation"), pinned: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
  db.conversations.unshift(c);
  saveDB();
  return c;
});
route("GET", "/assistant/conversations/:id", ({ db, params }) => {
  const c = db.conversations.find((x) => x.id === params.id);
  if (!c) fail(404, "Conversation not found");
  return c;
});
route("PATCH", "/assistant/conversations/:id", ({ db, params, body }) => {
  const c = db.conversations.find((x) => x.id === params.id);
  if (!c) fail(404, "Conversation not found");
  if (typeof body.title === "string") c.title = body.title;
  if (typeof body.pinned === "boolean") c.pinned = body.pinned;
  saveDB();
  return c;
});
route("DELETE", "/assistant/conversations/:id", ({ db, params }) => {
  db.conversations = db.conversations.filter((x) => x.id !== params.id);
  saveDB();
  return undefined;
});
route("POST", "/assistant/messages/:messageId/feedback", ({ db, params, body }) => {
  for (const c of db.conversations) {
    const m = c.messages?.find((x) => x.id === params.messageId);
    if (m) m.feedback = body.rating as 1 | -1;
  }
  saveDB();
  return { ok: true };
});
route("GET", "/assistant/suggestions", ({ query }) => {
  const ctx = query.get("context") || "dashboard";
  if (ctx.startsWith("case:"))
    return [
      { label: "What's missing for this case?", prompt: "Which criteria are not yet supported for this case and what documentation would close them?" },
      { label: "Summarize the policy", prompt: "Summarize the coverage indications of the matched policy in 3 bullets." },
      { label: "Prep a peer-to-peer", prompt: "Give me talking points for a peer-to-peer call on this case." },
    ];
  return [
    { label: "ESI conservative care", prompt: "How many weeks of conservative care does Novitas require before a lumbar ESI?" },
    { label: "CPAP adherence rule", prompt: "What counts as CPAP adherence for continued coverage after 12 weeks?" },
    { label: "Policies for 64483 in TX", prompt: "Which LCDs list 64483 for Texas?" },
    { label: "Top gaps this month", prompt: "What were our top 5 gap criteria this month?" },
    { label: "Is M17.11 covered for TKA?", prompt: "Is M17.11 a covered diagnosis for total knee arthroplasty in Arizona, and what documentation is needed?" },
  ];
});
route("POST", "/analytics/ask", async ({ body }) => {
  const { buildSql } = await import("./streams");
  return buildSql(String(body.question || "")) satisfies SqlResult;
});

// Analytics & activity
route("GET", "/analytics/overview", ({ db, query }) => {
  const a = buildAnalytics(Number((query.get("range") || "30d").replace("d", ""))) satisfies AnalyticsOverview;
  const mine = orgCases(db);
  if (mine.length >= 10) return a;
  const zero = Object.fromEntries(Object.keys(a.kpis).map((k) => [k, 0])) as AnalyticsOverview["kpis"];
  zero.openCases = mine.filter((c) => !["approved", "closed"].includes(c.status)).length;
  return { ...a, kpis: zero, trends: { casesByDay: a.trends.casesByDay.map((d) => ({ ...d, count: 0 })), readinessByWeek: [] }, topGapCriteria: [], denialReasons: [], payerMix: [] };
});
route("GET", "/analytics/team", () => buildTeam());
route("GET", "/activity", ({ db }) =>
  [...db.events.filter((e) => orgCases(db).some((c) => c.id === e.caseId))]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 25)
    .map((e) => {
      const c = db.cases.find((x) => x.id === e.caseId);
      const verbs: Record<string, string> = {
        created: "opened",
        document_added: "added a document to",
        evaluation_started: "started an evaluation on",
        evaluation_completed: "finished evaluating",
        comment: "commented on",
        verdict_overridden: "overrode a verdict on",
        letter_drafted: "drafted a letter for",
        letter_approved: "approved a letter for",
        denial_recorded: "recorded a denial on",
        status_changed: "updated the status of",
        policy_resolved: "matched a policy for",
        review_completed: "completed review of",
        outcome_recorded: "recorded the outcome of",
        assigned: "reassigned",
      };
      return { id: e.id, actor: e.actor, verb: verbs[e.type] ?? e.type.replace(/_/g, " "), target: c ? `${c.number} · ${c.title}` : e.caseId, link: `/cases/${e.caseId}`, createdAt: e.createdAt };
    }),
);

// Notifications, audit, jobs, feedback
route("GET", "/notifications", ({ db }) => db.notifications);
route("POST", "/notifications/read-all", ({ db }) => {
  db.notifications.forEach((n) => (n.readAt = n.readAt ?? new Date().toISOString()));
  saveDB();
  return undefined;
});
route("POST", "/notifications/:id/read", ({ db, params }) => {
  const n = db.notifications.find((x) => x.id === params.id);
  if (n) n.readAt = new Date().toISOString();
  saveDB();
  return undefined;
});
route("GET", "/audit/verify", ({ db }) => {
  requirePerm(db, "audit:read");
  appendAudit("audit.verify", "audit_log", null, { checked: db.audit.length });
  saveDB();
  return { valid: true, checked: 18_388 + db.audit.length, brokenAt: null };
});
route("GET", "/audit", ({ db, query }) => {
  requirePerm(db, "audit:read");
  let items = db.audit;
  const action = query.get("action");
  if (action) items = items.filter((a) => a.action.includes(action));
  const rt = query.get("resourceType");
  if (rt) items = items.filter((a) => a.resourceType === rt);
  const actor = query.get("actor");
  if (actor) items = items.filter((a) => (actor === "system" ? !a.actor : a.actor?.id === actor));
  const rid = query.get("resourceId");
  if (rid) {
    const docIds = new Set(db.documents.filter((d) => d.caseId === rid).map((d) => d.id));
    const letterIds = new Set(db.letters.filter((l) => l.caseId === rid).map((l) => l.id));
    items = items.filter((a) => a.resourceId === rid || docIds.has(a.resourceId ?? "") || letterIds.has(a.resourceId ?? "") || a.metadata.caseId === rid);
  }
  return paginate(items, query);
});
route("GET", "/jobs", ({ db }) => db.jobs);
route("GET", "/jobs/:id", ({ db, params }) => db.jobs.find((j) => j.id === params.id) ?? fail(404, "Job not found"));
route("POST", "/feedback", () => ({ ok: true }));
route("GET", "/health", () => ({ status: "ok", demo: true }));
route("GET", "/health/ready", () => ({ status: "ok", checks: { db: "ok", qdrant: "ok", redis: "ok", providers: "configured" } }));

function job(type: string, status: Job["status"], result: Record<string, unknown>): Job {
  const db = getDB();
  const j: Job = { id: nextId("job"), type, status, progress: status === "succeeded" ? 1 : 0.05, message: null, result, error: null, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: status === "succeeded" ? new Date().toISOString() : null };
  db.jobs.unshift(j);
  return j;
}

// Admin
route("GET", "/admin/ingestion/runs", ({ db }) => db.ingestionRuns);
route("POST", "/admin/ingestion/runs", ({ db, body }) => {
  requirePerm(db, "knowledge:admin");
  const run = { id: nextId("ing"), source: (body.source as "mcd") || "mcd", scope: { scope: body.scope || "focus", refresh: "manual" }, status: "running" as const, stats: { documentsSeen: 0, changed: 0, chunksEmbedded: 0 }, startedAt: new Date().toISOString(), finishedAt: null };
  db.ingestionRuns.unshift(run);
  appendAudit("knowledge.ingest.start", "ingestion_run", run.id, run.scope);
  saveDB();
  setTimeout(() => {
    const d = getDB();
    const r = d.ingestionRuns.find((x) => x.id === run.id);
    if (r) {
      r.status = "succeeded";
      r.stats = { documentsSeen: 3363, changed: 7, sectionsUpserted: 31, chunksEmbedded: 96, skippedUnchanged: 3356, durationS: 44 };
      r.finishedAt = new Date().toISOString();
      saveDB();
    }
  }, 6000);
  return job("ingest.mcd", "running", { runId: run.id });
});
route("GET", "/admin/indexes", ({ db }) => db.indexVersions);
route("POST", "/admin/indexes/:id/activate", ({ db, params }) => {
  requirePerm(db, "knowledge:admin");
  const target = db.indexVersions.find((i) => i.id === params.id);
  if (!target) fail(404, "Index version not found");
  db.indexVersions.forEach((i) => {
    if (i.alias === target.alias && i.status === "active") i.status = "ready";
  });
  target.status = "active";
  target.activatedAt = new Date().toISOString();
  appendAudit("knowledge.index.activate", "index_version", target.id, { alias: target.alias });
  saveDB();
  return target;
});
route("POST", "/admin/indexes/rollback", ({ db, query }) => {
  requirePerm(db, "knowledge:admin");
  const alias = query.get("alias") || "policy_chunks";
  const versions = db.indexVersions.filter((i) => i.alias === alias).sort((a, b) => (b.activatedAt ?? "").localeCompare(a.activatedAt ?? ""));
  const active = versions.find((v) => v.status === "active");
  const prev = versions.find((v) => v !== active && v.activatedAt && v.status !== "failed");
  if (!active || !prev) fail(409, "Nothing to roll back to");
  active.status = "ready";
  prev.status = "active";
  prev.activatedAt = new Date().toISOString();
  appendAudit("knowledge.index.rollback", "index_version", prev.id, { alias });
  saveDB();
  return prev;
});
route("GET", "/admin/models", () => ({ groups: MODEL_GROUPS, embedding: { model: "gemini/gemini-embedding-001", dims: 768 }, reranker: { chain: ["cohere/rerank-v3.5", "jina/jina-reranker-v2-base-multilingual", "llm-listwise (groq/llama-3.1-8b-instant)", "rrf-only"] } }));
route("GET", "/admin/models/usage", ({ query }) => buildModelUsage(Number((query.get("range") || "7d").replace("d", ""))));
route("POST", "/admin/models/test", async ({ body }) => {
  await sleep(500 + Math.random() * 700);
  const g = MODEL_GROUPS.find((x) => x.name === body.group) ?? MODEL_GROUPS[0]!;
  const d = g.deployments.find((x) => x.configured && x.healthy) ?? g.deployments[0]!;
  return { ok: true, provider: d.provider, model: d.model, latencyMs: Math.round((d.p50LatencyMs ?? 800) * (0.8 + Math.random() * 0.5)), sample: "READY — structured output validated against schema." };
});
route("GET", "/admin/cache/stats", ({ db }) => ({ ...db.cacheStats, hitRate: db.cacheStats.hits / (db.cacheStats.hits + db.cacheStats.misses), layers: [
  { name: "L1 exact response", entries: 312, hitRate: 0.17 },
  { name: "L2 semantic (entity-guarded)", entries: 488, hitRate: 0.06 },
  { name: "L3 retrieval", entries: 1_904, hitRate: 0.29 },
  { name: "L4 embeddings", entries: 23_118, hitRate: 0.62 },
  { name: "L5 LLM deterministic calls", entries: 2_406, hitRate: 0.21 },
] }));
route("POST", "/admin/cache/flush", ({ db }) => {
  requirePerm(db, "knowledge:admin");
  db.cacheStats = { hits: 0, misses: 0, semanticHits: 0, entries: 0 };
  appendAudit("cache.flush", "cache", null);
  saveDB();
  return { ok: true };
});
route("GET", "/admin/criteria", ({ db, query }) => {
  const status = query.get("status");
  return paginate(db.criteriaSets.filter((s) => !status || s.status === status), query);
});
route("GET", "/admin/criteria/:id", ({ db, params }) => db.criteriaSets.find((s) => s.id === params.id) ?? fail(404, "Criteria set not found"));
route("PATCH", "/admin/criteria/:id", ({ db, params, body }) => {
  const { user } = requirePerm(db, "criteria:review");
  const s = db.criteriaSets.find((x) => x.id === params.id);
  if (!s) fail(404, "Criteria set not found");
  if (body.tree) s.tree = body.tree as typeof s.tree;
  if (body.notes !== undefined) s.notes = body.notes as string;
  if (body.status) {
    s.status = body.status as typeof s.status;
    if (["approved", "rejected"].includes(String(body.status))) {
      s.reviewedBy = { id: user.id, fullName: user.fullName, avatarColor: user.avatarColor };
      s.reviewedAt = new Date().toISOString();
      appendAudit(`criteria.${body.status === "approved" ? "approve" : "reject"}`, "criteria_set", s.id, { agreement: s.agreement });
    }
  }
  saveDB();
  return s;
});
route("POST", "/admin/criteria/compile", ({ db }) => {
  requirePerm(db, "knowledge:admin");
  return job("criteria.compile", "running", {});
});
route("GET", "/admin/evals/runs", ({ db, query }) => {
  const suite = query.get("suite");
  return db.evalRuns.filter((r) => !suite || r.suite === suite);
});
route("GET", "/admin/evals/runs/:id", ({ db, params }) => db.evalRuns.find((r) => r.id === params.id) ?? fail(404, "Eval run not found"));
route("POST", "/admin/evals/runs", ({ db, body }) => {
  requirePerm(db, "evals:read");
  const suite = (body.suite as "retrieval") || "retrieval";
  const last = db.evalRuns.find((r) => r.suite === suite);
  const run = { ...(last ?? db.evalRuns[0]!), id: nextId("evr"), suite, status: "running" as const, startedAt: new Date().toISOString(), finishedAt: null, gitSha: "working" };
  db.evalRuns.unshift(run);
  saveDB();
  setTimeout(() => {
    const d = getDB();
    const r = d.evalRuns.find((x) => x.id === run.id);
    if (r) {
      r.status = "succeeded";
      r.finishedAt = new Date().toISOString();
      saveDB();
    }
  }, 5000);
  return run;
});
route("GET", "/admin/system", () => ({
  environment: "demo",
  version: "0.1.0",
  gitSha: "demo",
  featureFlags: { semanticCache: true, llmRerankFallback: true, demoMode: true },
  dataRetentionDays: 365,
  storage: { postgres: "Neon (free) — 212 MB", qdrant: "Qdrant Cloud (free) — 318 MB", redis: "Upstash (free)" },
}));

/* ── Dispatcher ─────────────────────────────────────────────────────────── */
export async function demoRequest<T>(method: string, fullPath: string, opts: RequestOptions): Promise<T> {
  const [rawPath, rawQs] = fullPath.split("?");
  const path = rawPath!.replace(/\/+$/, "");
  const query = new URLSearchParams(rawQs ?? "");
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) v.forEach((x) => query.append(k, x));
      else query.set(k, String(v));
    }
  }
  const parts = path.split("/").filter(Boolean);
  // Prefer static segments over params: sort candidate routes by number of params.
  const candidates = routes
    .filter((r) => r.method === method && r.parts.length === parts.length)
    .map((r) => {
      const params: Record<string, string> = {};
      let ok = true;
      let paramCount = 0;
      r.parts.forEach((p, i) => {
        if (!ok) return;
        if (p.startsWith(":")) {
          params[p.slice(1)] = decodeURIComponent(parts[i]!);
          paramCount++;
        } else if (p !== parts[i]) ok = false;
      });
      return ok ? { r, params, paramCount } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => a.paramCount - b.paramCount);
  const hit = candidates[0];
  await sleep(90 + Math.random() * 220);
  if (!hit) throw new ApiError({ title: "Not implemented in demo", status: 404, detail: `${method} ${path} is not available in demo mode.` });
  const result = await hit.r.handler({ params: hit.params, query, body: (opts.body as Record<string, unknown>) ?? {}, form: opts.form, db: getDB() });
  // Deep-clone so React Query caches never alias the mutable demo store.
  return (result === undefined ? undefined : JSON.parse(JSON.stringify(result))) as T;
}
