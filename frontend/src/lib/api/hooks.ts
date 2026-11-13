"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, type Query } from "./client";
import type {
  ActivityItem,
  AnalyticsOverview,
  ApiKey,
  AuditEntry,
  Case,
  CaseDocument,
  CaseEvent,
  CaseSummary,
  CodeResult,
  Conversation,
  CoverageGraph,
  CriteriaNode,
  CriteriaSet,
  CriterionResult,
  Denial,
  EvalRun,
  Evaluation,
  EvaluationSummary,
  IndexVersion,
  IngestionRun,
  Invitation,
  Job,
  KnowledgeStats,
  Letter,
  Member,
  ModelsOverview,
  ModelUsage,
  NextAction,
  NotificationItem,
  Org,
  Page,
  PolicyCode,
  PolicyDetail,
  PolicyDiff,
  PolicyMatch,
  PolicySummary,
  SessionInfo,
  SqlResult,
  TeamLoad,
  User,
  Verdict,
} from "./types";

/** The API rejects limits outside 1..max with a 422, so every list request is clamped to its cap. */
const capLimit = (n: unknown, max = 100) => Math.min(Math.max(Math.trunc(Number(n) || 0), 1), max);

export const qk = {
  me: ["me"] as const,
  org: ["org"] as const,
  members: ["members"] as const,
  invitations: ["invitations"] as const,
  apiKeys: ["api-keys"] as const,
  sessions: ["sessions"] as const,
  cases: (q?: Query) => ["cases", q ?? {}] as const,
  caseStats: ["cases", "stats"] as const,
  case: (id: string) => ["case", id] as const,
  docs: (id: string) => ["case", id, "documents"] as const,
  doc: (id: string, docId: string, reveal: boolean) => ["case", id, "documents", docId, reveal] as const,
  timeline: (id: string) => ["case", id, "timeline"] as const,
  evaluations: (id: string) => ["case", id, "evaluations"] as const,
  evaluation: (id: string, evalId: string) => ["case", id, "evaluation", evalId] as const,
  nextActions: (id: string) => ["case", id, "next-actions"] as const,
  letters: (id: string) => ["case", id, "letters"] as const,
  denials: (id: string) => ["case", id, "denials"] as const,
  allDenials: ["denials"] as const,
  patients: ["patients"] as const,
  policies: (q?: Query) => ["policies", q ?? {}] as const,
  policy: (id: string) => ["policy", id] as const,
  policyCodes: (id: string, system?: string) => ["policy", id, "codes", system ?? "all"] as const,
  policyDiff: (id: string, from: number, to: number) => ["policy", id, "diff", from, to] as const,
  policyCriteria: (id: string) => ["policy", id, "criteria"] as const,
  codeSearch: (q: string, system?: string) => ["codes", q, system ?? "all"] as const,
  codeGraph: (system: string, code: string, state?: string) => ["codes", "graph", system, code, state ?? ""] as const,
  knowledgeStats: ["knowledge", "stats"] as const,
  conversations: ["conversations"] as const,
  conversation: (id: string) => ["conversation", id] as const,
  suggestions: (ctx: string) => ["suggestions", ctx] as const,
  analytics: (range: string) => ["analytics", range] as const,
  team: ["analytics", "team"] as const,
  activity: ["activity"] as const,
  notifications: ["notifications"] as const,
  audit: (q?: Query) => ["audit", q ?? {}] as const,
  ingestion: ["admin", "ingestion"] as const,
  indexes: ["admin", "indexes"] as const,
  models: ["admin", "models"] as const,
  modelUsage: (range: string) => ["admin", "models", "usage", range] as const,
  cache: ["admin", "cache"] as const,
  criteria: (status?: string) => ["admin", "criteria", status ?? "all"] as const,
  criteriaSet: (id: string) => ["admin", "criteria", "set", id] as const,
  evalRuns: ["admin", "evals"] as const,
  system: ["admin", "system"] as const,
};

function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: QueryKey[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
}

function onError(e: unknown) {
  toast.error(errorMessage(e));
}

/* ── Org / members ──────────────────────────────────────────────────────── */
export const useOrg = () => useQuery({ queryKey: qk.org, queryFn: () => api.get<Org>("/orgs/current") });
export const useMembers = () => useQuery({ queryKey: qk.members, queryFn: () => api.get<Member[]>("/orgs/current/members") });
export const useInvitations = () => useQuery({ queryKey: qk.invitations, queryFn: () => api.get<Invitation[]>("/orgs/current/invitations") });
export const useApiKeys = () => useQuery({ queryKey: qk.apiKeys, queryFn: () => api.get<ApiKey[]>("/orgs/current/api-keys") });
export const useSessions = () => useQuery({ queryKey: qk.sessions, queryFn: () => api.get<SessionInfo[]>("/auth/sessions") });

export function useUpdateOrg() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: Partial<Org>) => api.patch<Org>("/orgs/current", body),
    onSuccess: () => {
      inv(qk.org, qk.me);
      toast.success("Organization settings saved");
    },
    onError,
  });
}

export function useUpdateMember() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ userId, ...body }: { userId: string; role?: string; status?: string }) => api.patch<Member>(`/orgs/current/members/${userId}`, body),
    onSuccess: () => {
      inv(qk.members);
      toast.success("Member updated");
    },
    onError,
  });
}

export function useRemoveMember() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (userId: string) => api.del(`/orgs/current/members/${userId}`),
    onSuccess: () => {
      inv(qk.members);
      toast.success("Member removed");
    },
    onError,
  });
}

export function useInvite() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { email: string; role: string }) => api.post<{ invitation: Invitation; devLink?: string }>("/orgs/current/invitations", body),
    onSuccess: () => inv(qk.invitations),
    onError,
  });
}

export function useRevokeInvite() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.del(`/orgs/current/invitations/${id}`), onSuccess: () => inv(qk.invitations), onError });
}

export function useCreateApiKey() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { name: string; scopes: string[] }) => api.post<{ apiKey: ApiKey; secret: string }>("/orgs/current/api-keys", body),
    onSuccess: () => inv(qk.apiKeys),
    onError,
  });
}

export function useRevokeApiKey() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.del(`/orgs/current/api-keys/${id}`),
    onSuccess: () => {
      inv(qk.apiKeys);
      toast.success("API key revoked");
    },
    onError,
  });
}

export function useUpdateMe() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: Partial<Pick<User, "fullName" | "title" | "preferences">>) => api.patch<User>("/users/me", body),
    onSuccess: () => inv(qk.me, qk.members),
    onError,
  });
}

/* ── Cases ──────────────────────────────────────────────────────────────── */
export const useCases = (q: Query = {}) =>
  useQuery({
    queryKey: qk.cases(q),
    queryFn: () => api.get<Page<CaseSummary>>("/cases", { ...q, limit: capLimit(q.limit ?? 100) }),
    placeholderData: keepPreviousData,
  });
export const useCaseStats = () =>
  useQuery({ queryKey: qk.caseStats, queryFn: () => api.get<{ byStatus: Record<string, number>; byReadiness: Record<string, number>; total: number }>("/cases/stats") });
export const useCase = (id: string) => useQuery({ queryKey: qk.case(id), queryFn: () => api.get<Case>(`/cases/${id}`), enabled: !!id });
export const useCaseDocuments = (id: string) => useQuery({ queryKey: qk.docs(id), queryFn: () => api.get<CaseDocument[]>(`/cases/${id}/documents`) });
export const useCaseDocument = (id: string, docId: string | null, reveal = false) =>
  useQuery({
    queryKey: qk.doc(id, docId ?? "", reveal),
    queryFn: () => api.get<CaseDocument & { revealed?: boolean }>(`/cases/${id}/documents/${docId}`, reveal ? { reveal: true } : undefined),
    enabled: !!docId,
  });
export const useTimeline = (id: string) => useQuery({ queryKey: qk.timeline(id), queryFn: () => api.get<CaseEvent[]>(`/cases/${id}/timeline`) });
export const useEvaluations = (id: string) => useQuery({ queryKey: qk.evaluations(id), queryFn: () => api.get<EvaluationSummary[]>(`/cases/${id}/evaluations`) });
export const useEvaluation = (id: string, evalId?: string | null) =>
  useQuery({ queryKey: qk.evaluation(id, evalId ?? ""), queryFn: () => api.get<Evaluation>(`/cases/${id}/evaluations/${evalId}`), enabled: !!evalId });
/** The API names suggested steps by what the server checks; the UI groups them by where they lead. */
const ACTION_TYPE: Record<string, NextAction["type"]> = {
  run_evaluation: "evaluate",
  rerun_evaluation: "evaluate",
  complete_review: "review",
  review_low_confidence: "review",
  verify_citations: "review",
  sla_risk: "review",
  upload_documents: "upload_document",
  review_quarantine: "upload_document",
  resolve_gap: "fix_gap",
  start_appeal: "appeal",
};
export const useNextActions = (id: string) =>
  useQuery({
    queryKey: qk.nextActions(id),
    queryFn: async () => {
      const rows = await api.get<NextAction[]>(`/cases/${id}/next-actions`);
      return rows.map((a) => ({ ...a, type: ACTION_TYPE[a.type as string] ?? a.type }));
    },
  });
export const useLetters = (id: string) => useQuery({ queryKey: qk.letters(id), queryFn: () => api.get<Letter[]>(`/cases/${id}/letters`) });
export const useCaseDenials = (id: string) => useQuery({ queryKey: qk.denials(id), queryFn: () => api.get<Denial[]>(`/cases/${id}/denials`) });
export const usePatients = () =>
  useQuery({ queryKey: qk.patients, queryFn: () => api.get<{ id: string; displayName: string; birthYear: number; sex: string; state: string }[]>("/patients") });

export function useAllDenials() {
  return useQuery({
    queryKey: qk.allDenials,
    queryFn: async () => {
      // One org-wide request (the API caps case lists at 100, and per-case fetches don't scale).
      const rows = await api.get<(Denial & { case?: CaseSummary | null })[]>("/denials", { limit: 200 });
      return rows
        .map(({ case: c, ...d }) => ({ ...d, caseNumber: d.caseNumber ?? c?.number, caseTitle: d.caseTitle ?? c?.title, payerName: d.payerName ?? c?.payerName }))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    },
  });
}

export function useCreateCase() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<Case>("/cases", body),
    onSuccess: () => inv(["cases"], qk.activity),
    onError,
  });
}

export function useUpdateCase(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Case>(`/cases/${id}`, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: qk.case(id) });
      const prev = qc.getQueryData<Case>(qk.case(id));
      if (prev && typeof body.status === "string") qc.setQueryData(qk.case(id), { ...prev, status: body.status });
      return { prev };
    },
    onError: (e, _b, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.case(id), ctx.prev);
      onError(e);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: qk.case(id) });
      qc.invalidateQueries({ queryKey: ["cases"] });
      qc.invalidateQueries({ queryKey: qk.timeline(id) });
    },
  });
}

export function useBulkAssign() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: async ({ ids, assigneeId }: { ids: string[]; assigneeId: string | null }) => {
      await Promise.all(ids.map((id) => api.patch(`/cases/${id}`, { assigneeId })));
    },
    onSuccess: (_d, v) => {
      inv(["cases"]);
      toast.success(`Reassigned ${v.ids.length} case${v.ids.length > 1 ? "s" : ""}`);
    },
    onError,
  });
}

export function useAddTextDocument(id: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { kind: string; text: string; title?: string; noteDate?: string }) => api.post<CaseDocument>(`/cases/${id}/documents/text`, body),
    onSuccess: (d) => {
      inv(qk.docs(id), qk.case(id), qk.timeline(id), qk.nextActions(id));
      if (d.quarantined) toast.warning("Document quarantined", { description: "Instruction-like text was detected. It will be excluded from evidence until reviewed." });
      else toast.success("Note added", { description: d.redactions ? `${d.redactions} identifier${d.redactions > 1 ? "s" : ""} de-identified` : undefined });
    },
    onError,
  });
}

export function useUploadDocument(id: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ file, kind, noteDate }: { file: File; kind: string; noteDate?: string }) => {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      if (noteDate) form.set("noteDate", noteDate);
      return api.upload<CaseDocument>(`/cases/${id}/documents`, form);
    },
    onSuccess: (d) => {
      inv(qk.docs(id), qk.case(id), qk.timeline(id), qk.nextActions(id));
      if (d.quarantined) toast.warning(`${d.filename} quarantined`, { description: "Possible prompt injection detected." });
      else toast.success(`${d.filename} uploaded`);
    },
    onError,
  });
}

export function useDeleteDocument(id: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (docId: string) => api.del(`/cases/${id}/documents/${docId}`),
    onSuccess: () => {
      inv(qk.docs(id), qk.case(id), qk.timeline(id));
      toast.success("Document removed");
    },
    onError,
  });
}

export function useComment(id: string) {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (body: string) => api.post(`/cases/${id}/comments`, { body }), onSuccess: () => inv(qk.timeline(id), qk.activity), onError });
}

export function useRecordOutcome(id: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { outcome: string; note?: string }) => api.post<Case>(`/cases/${id}/outcome`, body),
    onSuccess: () => {
      inv(qk.case(id), ["cases"], qk.timeline(id));
      toast.success("Outcome recorded");
    },
    onError,
  });
}

export function useOverrideCriterion(caseId: string, evalId: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ resultId, overrideVerdict, overrideReason }: { resultId: string; overrideVerdict: Verdict | null; overrideReason: string }) =>
      api.patch<CriterionResult>(`/cases/${caseId}/criteria/${resultId}`, { overrideVerdict, overrideReason }),
    onSuccess: () => {
      inv(qk.evaluation(caseId, evalId), qk.case(caseId), qk.timeline(caseId), qk.nextActions(caseId));
      toast.success("Verdict updated", { description: "Override recorded in the audit trail." });
    },
    onError,
  });
}

export function useCompleteReview(caseId: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (evalId: string) => api.post<Evaluation>(`/cases/${caseId}/evaluations/${evalId}/complete-review`),
    onSuccess: (e) => {
      inv(qk.case(caseId), qk.evaluation(caseId, e.id), ["cases"], qk.timeline(caseId), qk.nextActions(caseId));
      toast.success("Review completed");
    },
    onError,
  });
}

export function useUpdateLetter(caseId: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ letterId, ...body }: { letterId: string; contentMd?: string; status?: string }) => api.patch<Letter>(`/cases/${caseId}/letters/${letterId}`, body),
    onSuccess: () => inv(qk.letters(caseId), qk.timeline(caseId)),
    onError,
  });
}

export function useRecordDenial(caseId: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { text: string; receivedAt: string; carcCodes?: string[] }) => api.post<Denial>(`/cases/${caseId}/denials`, body),
    onSuccess: () => {
      inv(qk.denials(caseId), qk.case(caseId), qk.allDenials, ["cases"], qk.timeline(caseId));
      toast.success("Denial analyzed", { description: "Mapped to policy criteria — see the Denials tab." });
    },
    onError,
  });
}

export function useUpdateDenial(caseId: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ denialId, ...body }: { denialId: string; status?: string }) => api.patch<Denial>(`/cases/${caseId}/denials/${denialId}`, body),
    onSuccess: () => inv(qk.denials(caseId), qk.allDenials, qk.case(caseId)),
    onError,
  });
}

export const policySuggestions = (body: Record<string, unknown>) => api.post<{ matches: PolicyMatch[] }>("/cases/policy-suggestions", body);

/* ── Knowledge ──────────────────────────────────────────────────────────── */
export const usePolicies = (q: Query = {}) =>
  useQuery({
    queryKey: qk.policies(q),
    queryFn: () => api.get<Page<PolicySummary>>("/policies", { ...q, limit: capLimit(q.limit ?? 50) }),
    enabled: q.limit !== 0,
    placeholderData: keepPreviousData,
  });
export const usePolicy = (id: string) => useQuery({ queryKey: qk.policy(id), queryFn: () => api.get<PolicyDetail>(`/policies/${id}`), enabled: !!id });
export const usePolicyCodes = (id: string, system?: string) =>
  useQuery({ queryKey: qk.policyCodes(id, system), queryFn: () => api.get<Page<PolicyCode>>(`/policies/${id}/codes`, { system, limit: 200 }), enabled: !!id });
export const usePolicyDiff = (id: string, from: number, to: number, enabled = true) =>
  useQuery({ queryKey: qk.policyDiff(id, from, to), queryFn: () => api.get<PolicyDiff>(`/policies/${id}/diff`, { from, to }), enabled });
export const usePolicyCriteria = (id: string) =>
  useQuery({
    queryKey: qk.policyCriteria(id),
    queryFn: async () => normalizeCriteriaSet(await api.get<CriteriaSet>(`/policies/${id}/criteria`)),
    retry: false,
    enabled: !!id,
  });
export const useCodeSearch = (q: string, system?: string) =>
  useQuery({
    queryKey: qk.codeSearch(q, system),
    queryFn: () => api.get<CodeResult[]>("/codes/search", { q: q.trim(), system }),
    enabled: q.trim().length > 0,
    placeholderData: keepPreviousData,
  });
export const useCodeGraph = (system: string, code: string | null, state?: string, asOf?: string) =>
  useQuery({
    queryKey: [...qk.codeGraph(system, code ?? "", state), asOf ?? ""],
    queryFn: () => api.get<CoverageGraph>(`/codes/${system}/${code}/graph`, { state, asOf }),
    enabled: !!code,
  });
export const useKnowledgeStats = () => useQuery({ queryKey: qk.knowledgeStats, queryFn: () => api.get<KnowledgeStats>("/knowledge/stats") });

/* ── Assistant ──────────────────────────────────────────────────────────── */
export const useConversations = () => useQuery({ queryKey: qk.conversations, queryFn: () => api.get<Page<Conversation>>("/assistant/conversations") });
export const useConversation = (id: string | null) =>
  useQuery({ queryKey: qk.conversation(id ?? ""), queryFn: () => api.get<Conversation>(`/assistant/conversations/${id}`), enabled: !!id });
export const useSuggestions = (ctx: string) =>
  useQuery({ queryKey: qk.suggestions(ctx), queryFn: () => api.get<{ label: string; prompt: string }[]>("/assistant/suggestions", { context: ctx }), staleTime: 300_000 });

export function useCreateConversation() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (title?: string) => api.post<Conversation>("/assistant/conversations", { title }), onSuccess: () => inv(qk.conversations), onError });
}
export function useUpdateConversation() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; title?: string; pinned?: boolean }) => api.patch<Conversation>(`/assistant/conversations/${id}`, body),
    onSuccess: () => inv(qk.conversations),
    onError,
  });
}
export function useDeleteConversation() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api.del(`/assistant/conversations/${id}`), onSuccess: () => inv(qk.conversations), onError });
}
export function useMessageFeedback() {
  return useMutation({
    mutationFn: ({ messageId, rating, reason }: { messageId: string; rating: 1 | -1; reason?: string }) => api.post(`/assistant/messages/${messageId}/feedback`, { rating, reason }),
    onSuccess: () => toast.success("Thanks — feedback recorded", { description: "It feeds the evaluation set after triage." }),
    onError,
  });
}
export function useAskAnalytics() {
  return useMutation({ mutationFn: (question: string) => api.post<SqlResult>("/analytics/ask", { question }), onError });
}

/* ── Analytics / activity / notifications / audit ───────────────────────── */
export const useAnalytics = (range = "30d") => useQuery({ queryKey: qk.analytics(range), queryFn: () => api.get<AnalyticsOverview>("/analytics/overview", { range }) });
export const useTeam = () => useQuery({ queryKey: qk.team, queryFn: () => api.get<TeamLoad[]>("/analytics/team") });
export const useActivity = () => useQuery({ queryKey: qk.activity, queryFn: () => api.get<ActivityItem[]>("/activity") });
export const useNotifications = () =>
  useQuery({
    queryKey: qk.notifications,
    // The API returns `{ items, unread }`; the demo backend returns a bare array. Normalize to an array.
    queryFn: () => api.get<NotificationItem[] | { items: NotificationItem[] }>("/notifications").then((r) => (Array.isArray(r) ? r : (r?.items ?? []))),
    refetchInterval: 30_000,
  });
export function useMarkNotifications() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id?: string) => (id ? api.post(`/notifications/${id}/read`) : api.post("/notifications/read-all")),
    onSuccess: () => inv(qk.notifications),
  });
}
export const useAudit = (q: Query = {}) =>
  useQuery({ queryKey: qk.audit(q), queryFn: () => api.get<Page<AuditEntry>>("/audit", { ...q, limit: capLimit(q.limit ?? 100, 200) }), placeholderData: keepPreviousData });
export function useVerifyAudit() {
  return useMutation({ mutationFn: () => api.get<{ valid: boolean; checked: number; brokenAt?: number | null }>("/audit/verify"), onError });
}

/* ── Admin ──────────────────────────────────────────────────────────────── */
export const useIngestionRuns = () => useQuery({ queryKey: qk.ingestion, queryFn: () => api.get<IngestionRun[]>("/admin/ingestion/runs"), refetchInterval: 5000 });
export const useIndexes = () => useQuery({ queryKey: qk.indexes, queryFn: () => api.get<IndexVersion[]>("/admin/indexes") });
export const useModels = () => useQuery({ queryKey: qk.models, queryFn: () => api.get<ModelsOverview>("/admin/models") });
export const useModelUsage = (range = "7d") => useQuery({ queryKey: qk.modelUsage(range), queryFn: () => api.get<ModelUsage>("/admin/models/usage", { range }) });
export const useCacheStats = () =>
  useQuery({ queryKey: qk.cache, queryFn: () => api.get<{ hits: number; misses: number; hitRate: number; layers: { name: string; entries: number; hitRate: number }[] }>("/admin/cache/stats") });
/** The API stores a full criteria tree (`{ root, title, … }`, spans keyed `sectionKey`); the editor works on
 *  the root node with `sourceSpan.section`. Normalizing here keeps every screen on one shape. Idempotent. */
type ApiSpan = { section?: string; sectionKey?: string; quote: string };
type ApiNode = Omit<CriteriaNode, "sourceSpan" | "children"> & { sourceSpan?: ApiSpan; children?: ApiNode[] };
function toEditorNode(node: ApiNode): CriteriaNode {
  const { sourceSpan, children, ...rest } = node;
  return {
    ...rest,
    ...(sourceSpan ? { sourceSpan: { section: sourceSpan.section ?? sourceSpan.sectionKey ?? "", quote: sourceSpan.quote } } : {}),
    ...(children ? { children: children.map(toEditorNode) } : {}),
  };
}
export function normalizeCriteriaSet<T extends { tree?: unknown }>(set: T): T {
  const tree = set?.tree as (ApiNode & { root?: ApiNode }) | undefined;
  if (!tree) return set;
  return { ...set, tree: toEditorNode(tree.root ?? tree) };
}
export const useCriteriaSets = (status?: string) =>
  useQuery({
    queryKey: qk.criteria(status),
    queryFn: async () => {
      const page = await api.get<Page<CriteriaSet>>("/admin/criteria", { status });
      return { ...page, items: page.items.map(normalizeCriteriaSet) };
    },
  });
export const useCriteriaSet = (id: string) =>
  useQuery({ queryKey: qk.criteriaSet(id), queryFn: async () => normalizeCriteriaSet(await api.get<CriteriaSet>(`/admin/criteria/${id}`)) });
type ApiGate = { op: ">=" | "<=" | "=="; threshold: number; value?: number; passed: boolean };
function normalizeEvalRun(run: EvalRun): EvalRun {
  const g = run.gates as unknown;
  if (!g || Array.isArray(g)) return run;
  const gates = Object.entries(g as Record<string, ApiGate>).map(([metric, v]) => ({ metric, threshold: v.threshold, op: v.op, passed: v.passed }));
  return { ...run, gates };
}
export const useEvalRuns = () =>
  useQuery({
    queryKey: qk.evalRuns,
    queryFn: async () => (await api.get<EvalRun[]>("/admin/evals/runs")).map(normalizeEvalRun),
    refetchInterval: 6000,
  });
export const useSystemInfo = () => useQuery({ queryKey: qk.system, queryFn: () => api.get<Record<string, unknown>>("/admin/system") });

export function useStartIngestion() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (body: { source: string; scope: string }) => api.post<Job>("/admin/ingestion/runs", body),
    onSuccess: () => {
      inv(qk.ingestion);
      toast.success("Refresh started", { description: "Only policies that changed are updated." });
    },
    onError,
  });
}
export function useActivateIndex() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post<IndexVersion>(`/admin/indexes/${id}/activate`),
    onSuccess: () => {
      inv(qk.indexes, qk.knowledgeStats);
      toast.success("The new library version is live");
    },
    onError,
  });
}
export function useRollbackIndex() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (alias: string) => api.post<IndexVersion>(`/admin/indexes/rollback?alias=${alias}`),
    onSuccess: () => {
      inv(qk.indexes, qk.knowledgeStats);
      toast.success("Restored the previous library version");
    },
    onError,
  });
}
export function useTestModelGroup() {
  return useMutation({ mutationFn: (group: string) => api.post<{ ok: boolean; provider: string; model: string; latencyMs: number; sample: string }>("/admin/models/test", { group }), onError });
}
export function useFlushCache() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: () => api.post("/admin/cache/flush"),
    onSuccess: () => {
      inv(qk.cache);
      toast.success("Caches flushed");
    },
    onError,
  });
}
export function useUpdateCriteriaSet(id: string) {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: async (body: Partial<CriteriaSet>) => normalizeCriteriaSet(await api.patch<CriteriaSet>(`/admin/criteria/${id}`, body)),
    onSuccess: () => inv(qk.criteriaSet(id), ["admin", "criteria"], ["policy"]),
    onError,
  });
}
export function useCompileCriteria() {
  return useMutation({
    mutationFn: (body: { sourceKeys?: string[] }) => api.post<Job>("/admin/criteria/compile", body),
    onSuccess: () => toast.success("Preparing checklists", { description: "They will appear in Review when ready." }),
    onError,
  });
}
export function useStartEval() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (suite: string) => api.post<EvalRun>("/admin/evals/runs", { suite }),
    onSuccess: () => {
      inv(qk.evalRuns);
      toast.success("Quality check started");
    },
    onError,
  });
}
