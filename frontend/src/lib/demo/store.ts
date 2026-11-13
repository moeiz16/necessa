"use client";

import type {
  ApiKey,
  AuditEntry,
  Case,
  CaseDocument,
  CaseEvent,
  CodeResult,
  Conversation,
  CriteriaSet,
  Denial,
  EvalRun,
  Evaluation,
  IndexVersion,
  IngestionRun,
  Invitation,
  Job,
  Letter,
  Member,
  NotificationItem,
  Org,
  PolicyCode,
  PolicyDetail,
  Role,
  SessionInfo,
  User,
} from "@/lib/api/types";
import { lsGet, lsRemove, lsSet } from "@/lib/utils";
import {
  buildCases,
  buildDenials,
  buildDocuments,
  buildEvaluations,
  buildEvents,
  buildLetters,
  MEMBERS,
  ORG,
  ORG_ID,
  PATIENTS,
  USERS,
  type DemoPatient,
} from "./seed-cases";
import { buildCriteriaSets, buildPolicies, buildPolicyCodes, CODES } from "./seed-knowledge";
import {
  buildAudit,
  buildConversations,
  buildEvalRuns,
  buildIndexVersions,
  buildIngestionRuns,
  buildNotifications,
  chainHash,
} from "./seed-ops";

const KEY = "necessa.demo.db";
const VERSION = 5;
const MAX_AGE_MS = 12 * 3600_000;

export type DemoUser = User & { password: string };
export interface Membership {
  orgId: string;
  userId: string;
  role: Role;
  status: "active" | "suspended";
}

export interface Pending {
  kind: "evaluation" | "letter" | "denial";
  caseId: string;
  id: string;
}

export interface DemoDB {
  version: number;
  seededAt: number;
  session: { userId: string; orgId: string | null } | null;
  users: DemoUser[];
  memberships: Membership[];
  members: Member[];
  orgs: Org[];
  invitations: (Invitation & { orgId: string; token: string })[];
  apiKeys: ApiKey[];
  sessions: SessionInfo[];
  patients: DemoPatient[];
  cases: (Case & { orgId?: string })[];
  documents: CaseDocument[];
  events: CaseEvent[];
  evaluations: Evaluation[];
  letters: Letter[];
  denials: Denial[];
  policies: PolicyDetail[];
  policyCodes: Record<string, PolicyCode[]>;
  criteriaSets: CriteriaSet[];
  codes: CodeResult[];
  conversations: Conversation[];
  notifications: NotificationItem[];
  audit: AuditEntry[];
  jobs: Job[];
  ingestionRuns: IngestionRun[];
  indexVersions: IndexVersion[];
  evalRuns: EvalRun[];
  pending: Pending[];
  cacheStats: { hits: number; misses: number; semanticHits: number; entries: number };
  seq: number;
}

export function seed(): DemoDB {
  const policies = buildPolicies();
  const criteriaSets = buildCriteriaSets(policies);
  const cases = buildCases(policies);
  const documents = buildDocuments();
  const evaluations = buildEvaluations(cases, policies, criteriaSets, documents);
  const policyCodes: Record<string, PolicyCode[]> = {};
  policies.forEach((p) => (policyCodes[p.id] = buildPolicyCodes(p)));
  return {
    version: VERSION,
    seededAt: Date.now(),
    session: null,
    users: USERS.map(({ role: _r, ...u }) => u),
    memberships: USERS.map((u) => ({ orgId: ORG_ID, userId: u.id, role: u.role, status: "active" as const })),
    members: MEMBERS,
    orgs: [ORG],
    invitations: [
      {
        id: "inv-1",
        orgId: ORG_ID,
        token: "demo-invite-token",
        email: "nina@riverbend.demo",
        role: "coordinator",
        invitedBy: { id: "u-maya", fullName: "Dr. Maya Okafor" },
        expiresAt: new Date(Date.now() + 5 * 86400_000).toISOString(),
        acceptedAt: null,
        createdAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
      },
    ],
    apiKeys: [
      {
        id: "key-1",
        name: "EHR integration (sandbox)",
        prefix: "nk_live_7Fq2",
        scopes: ["cases:read", "cases:write"],
        lastUsedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
        expiresAt: null,
        createdAt: new Date(Date.now() - 50 * 3600_000).toISOString(),
        revokedAt: null,
      },
    ],
    sessions: [
      { id: "s-1", userAgent: "Chrome 131 on macOS", ip: "10.12.4.20", createdAt: new Date(Date.now() - 3600_000).toISOString(), lastUsedAt: new Date().toISOString(), current: true },
      { id: "s-2", userAgent: "Safari 18 on iPhone", ip: "172.58.11.4", createdAt: new Date(Date.now() - 4 * 86400_000).toISOString(), lastUsedAt: new Date(Date.now() - 86400_000).toISOString(), current: false },
    ],
    patients: PATIENTS,
    cases: cases.map((c) => ({ ...c, orgId: ORG_ID })),
    documents,
    events: buildEvents(cases),
    evaluations,
    letters: buildLetters(),
    denials: buildDenials(cases),
    policies,
    policyCodes,
    criteriaSets,
    codes: CODES,
    conversations: buildConversations(),
    notifications: buildNotifications(),
    audit: buildAudit(),
    jobs: [],
    ingestionRuns: buildIngestionRuns(),
    indexVersions: buildIndexVersions(),
    evalRuns: buildEvalRuns(),
    pending: [],
    cacheStats: { hits: 1184, misses: 3766, semanticHits: 212, entries: 488 },
    seq: 100,
  };
}

let db: DemoDB | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function getDB(): DemoDB {
  if (db) return db;
  const stored = lsGet<DemoDB | null>(KEY, null);
  if (stored && stored.version === VERSION && Date.now() - stored.seededAt < MAX_AGE_MS) {
    db = stored;
  } else {
    const session = stored?.session ?? null;
    db = seed();
    // keep the user signed in across reseeds when the account still exists
    if (session && db.users.some((u) => u.id === session.userId)) db.session = session;
  }
  return db;
}

export function saveDB() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (db) lsSet(KEY, db);
  }, 150);
}

export function resetDB() {
  lsRemove(KEY);
  db = seed();
  saveDB();
  return db;
}

export function nextId(prefix: string) {
  const d = getDB();
  d.seq += 1;
  return `${prefix}-${d.seq}`;
}

export function appendAudit(action: string, resourceType: string, resourceId: string | null, metadata: Record<string, unknown> = {}) {
  const d = getDB();
  const actorUser = d.session ? d.users.find((u) => u.id === d.session!.userId) : null;
  const prev = d.audit[0]?.hash ?? null;
  const createdAt = new Date().toISOString();
  const entry: AuditEntry = {
    id: (d.audit[0]?.id ?? 18_400) + 1,
    actor: actorUser ? { id: actorUser.id, fullName: actorUser.fullName, avatarColor: actorUser.avatarColor } : null,
    actorType: actorUser ? "user" : "system",
    action,
    resourceType,
    resourceId,
    ip: actorUser ? "10.12.4.20" : null,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 80) : null,
    metadata,
    prevHash: prev,
    hash: chainHash(prev, `${action}|${resourceId}|${createdAt}`),
    createdAt,
  };
  d.audit.unshift(entry);
}

export function addEvent(caseId: string, type: string, payload: Record<string, unknown> = {}, system = false) {
  const d = getDB();
  const u = !system && d.session ? d.users.find((x) => x.id === d.session!.userId) : null;
  d.events.push({
    id: nextId("ev"),
    caseId,
    actor: u ? { id: u.id, fullName: u.fullName, avatarColor: u.avatarColor } : null,
    type,
    payload,
    createdAt: new Date().toISOString(),
  });
}

export function notify(n: Omit<NotificationItem, "id" | "createdAt">) {
  const d = getDB();
  d.notifications.unshift({ ...n, id: nextId("n"), createdAt: new Date().toISOString() });
}
