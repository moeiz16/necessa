/* Types mirror docs/API_CONTRACT.md (camelCase wire format). */

export type UUID = string;
export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string;

export type Role = "owner" | "admin" | "coordinator" | "clinician" | "reviewer" | "rcm_manager" | "auditor";

export type Permission =
  | "cases:read"
  | "cases:write"
  | "cases:review"
  | "letters:approve"
  | "policies:read"
  | "knowledge:admin"
  | "criteria:review"
  | "analytics:read"
  | "audit:read"
  | "org:admin"
  | "evals:read"
  | "phi:reveal"
  | "assistant:use";

export interface Page<T> {
  items: T[];
  nextCursor?: string | null;
  total?: number | null;
}

export interface Problem {
  type?: string;
  title: string;
  status: number;
  detail?: string | null;
  code?: string | null;
  errors?: { loc?: (string | number)[]; msg: string; field?: string }[] | null;
  requestId?: string | null;
}

/* ── Auth / users / orgs ─────────────────────────────────────────────── */
export interface User {
  id: UUID;
  email: string;
  fullName: string;
  title?: string | null;
  avatarColor?: string | null;
  mfaEnabled: boolean;
  preferences?: { theme?: "light" | "dark" | "system"; density?: "comfortable" | "compact"; notifications?: Record<string, boolean> };
  createdAt: ISODateTime;
}

export interface OrgSummary {
  id: UUID;
  name: string;
  slug: string;
  role: Role;
}

export interface OrgSettings {
  slaHoursStandard: number;
  slaHoursExpedited: number;
  dataRetentionDays: number;
  requireMfa: boolean;
  defaultAsOf: "dos" | "today";
}

export interface Org {
  id: UUID;
  name: string;
  slug: string;
  npi?: string | null;
  specialty?: string | null;
  practiceType: "clinic" | "hospital" | "asc" | "dme" | "other";
  states: string[];
  payers: { type: PayerType; name: string }[];
  timezone: string;
  settings: OrgSettings;
  onboardingCompletedAt?: ISODateTime | null;
  counts?: { members: number; cases: number; openCases: number };
  createdAt: ISODateTime;
}

export interface Me {
  user: User;
  activeOrg: Org | null;
  membership: { role: Role; permissions: Permission[] } | null;
  orgs: OrgSummary[];
}

export interface LoginResponse {
  user?: User;
  orgs?: OrgSummary[];
  activeOrgId?: UUID | null;
  mfaRequired?: boolean;
}

export interface Member {
  id: UUID;
  fullName: string;
  email: string;
  role: Role;
  status: "active" | "suspended";
  lastLoginAt?: ISODateTime | null;
  mfaEnabled: boolean;
  avatarColor?: string | null;
}

export interface Invitation {
  id: UUID;
  email: string;
  role: Role;
  invitedBy?: { id: UUID; fullName: string } | null;
  expiresAt: ISODateTime;
  acceptedAt?: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface ApiKey {
  id: UUID;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt?: ISODateTime | null;
  expiresAt?: ISODateTime | null;
  createdAt: ISODateTime;
  revokedAt?: ISODateTime | null;
}

export interface SessionInfo {
  id: UUID;
  userAgent: string;
  ip: string;
  createdAt: ISODateTime;
  lastUsedAt: ISODateTime;
  current: boolean;
}

/* ── Cases ─────────────────────────────────────────────────────────────── */
export type CaseStatus =
  | "draft"
  | "evaluating"
  | "needs_review"
  | "ready"
  | "submitted"
  | "pending_payer"
  | "approved"
  | "denied"
  | "appealing"
  | "closed";
export type Readiness = "unknown" | "ready" | "gaps" | "not_supported";
export type PayerType = "medicare_ffs" | "medicare_advantage" | "commercial" | "medicaid";
export type Priority = "standard" | "expedited";
export type Verdict = "MET" | "NOT_MET" | "INSUFFICIENT";

export interface PersonRef {
  id: UUID;
  fullName: string;
  avatarColor?: string | null;
}

export interface CaseSummary {
  id: UUID;
  number: string;
  title: string;
  status: CaseStatus;
  priority: Priority;
  payerType: PayerType;
  payerName: string;
  state: string;
  serviceCodes: string[];
  dxCodes: string[];
  dateOfService: ISODate;
  readiness: Readiness;
  readinessScore?: number | null;
  dueAt?: ISODateTime | null;
  assignee?: PersonRef | null;
  patient: { id: UUID; displayName: string; birthYear: number; sex: "F" | "M" | "U" };
  updatedAt: ISODateTime;
}

export interface PolicyRef {
  policyId: UUID;
  policyVersionId: UUID;
  sourceKey: string;
  title: string;
  version: number;
}

export interface Case extends CaseSummary {
  placeOfService?: string | null;
  policyRefs: PolicyRef[];
  latestEvaluationId?: UUID | null;
  outcome?: "approved" | "denied" | "partial" | "withdrawn" | null;
  outcomeAt?: ISODateTime | null;
  submittedAt?: ISODateTime | null;
  tags: string[];
  documentsCount: number;
  createdBy?: PersonRef | null;
  createdAt: ISODateTime;
}

export type DocumentKind =
  | "clinical_note"
  | "fhir_bundle"
  | "pdf"
  | "imaging_report"
  | "therapy_note"
  | "denial_letter"
  | "other";

export interface CaseDocument {
  id: UUID;
  caseId: UUID;
  kind: DocumentKind;
  filename: string;
  mime: string;
  sizeBytes: number;
  pageCount?: number | null;
  ocrUsed: boolean;
  injectionScore: number;
  quarantined: boolean;
  noteDate?: ISODate | null;
  uploadedBy?: PersonRef | null;
  createdAt: ISODateTime;
  text?: string;
  redactions?: number;
}

export interface CaseEvent {
  id: UUID;
  caseId: UUID;
  actor?: PersonRef | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: ISODateTime;
}

export interface PolicyMatch {
  policyId: UUID;
  policyVersionId: UUID;
  sourceKey: string;
  title: string;
  docType: DocType;
  version: number;
  effectiveFrom: ISODate;
  effectiveTo?: ISODate | null;
  matchReasons: { type: "hcpcs" | "icd10" | "state" | "contractor"; value: string; detail: string }[];
  score: number;
  contractor?: { id: number; name: string } | null;
  criteriaSetStatus?: "approved" | "needs_review" | "draft" | null;
}

export interface Evidence {
  chunkId: string;
  documentId: UUID;
  quote: string;
  charStart?: number | null;
  charEnd?: number | null;
  noteDate?: ISODate | null;
  score?: number;
}

export interface CriterionResult {
  id: UUID;
  criterionId: string;
  text: string;
  kind: "positive" | "negative_attestation" | "documentation" | "temporal" | "numeric";
  treePath: string;
  verdict: Verdict;
  effectiveVerdict: Verdict;
  confidence: number;
  rationale: string;
  evidence: Evidence[];
  policyCitation: { policyVersionId: UUID; sectionKey: string; quote: string; sourceKey?: string };
  verification: {
    quoteValid: boolean;
    entailment?: "entails" | "neutral" | "contradicts" | null;
    judgeModel?: string;
    verifierModel?: string;
    iterations?: number;
  };
  override?: { verdict: Verdict; reason: string; by: PersonRef; at: ISODateTime } | null;
}

export interface TreeResult {
  op?: "AND" | "OR" | "N_OF_M";
  n?: number;
  criterionId?: string;
  text?: string;
  /** Group label from the criteria set (e.g. "Initial E0601 coverage"). */
  label?: string;
  verdict: Verdict;
  children?: TreeResult[];
}

export interface Gap {
  criterionId: string;
  title: string;
  detail: string;
  severity: "blocker" | "major" | "minor";
  suggestedFix: string;
  /** Absent for policy-level gaps (e.g. "No approved criteria for the applicable policy"). */
  policyQuote?: string | null;
}

export type EvaluationStatus = "running" | "awaiting_review" | "completed" | "failed" | "cancelled";

export interface Evaluation {
  id: UUID;
  caseId: UUID;
  status: EvaluationStatus;
  readiness: Readiness;
  readinessScore?: number | null;
  degraded: boolean;
  policies: PolicyMatch[];
  tree: TreeResult | null;
  criteria: CriterionResult[];
  gaps: Gap[];
  tokenUsage?: { promptTokens: number; completionTokens: number };
  modelInfo?: Record<string, string>;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime | null;
}

export interface EvaluationSummary {
  id: UUID;
  status: EvaluationStatus;
  readiness: Readiness;
  readinessScore?: number | null;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime | null;
  degraded: boolean;
}

export interface NextAction {
  type: "upload_document" | "evaluate" | "review" | "draft_letter" | "submit" | "appeal" | "fix_gap";
  title: string;
  detail: string;
  criterionId?: string;
  priority: "high" | "medium" | "low";
}

export type LetterKind = "lmn" | "pa_cover" | "appeal" | "peer_to_peer_prep";
export interface Letter {
  id: UUID;
  caseId: UUID;
  kind: LetterKind;
  status: "draft" | "in_review" | "approved" | "exported";
  title: string;
  contentMd: string;
  version: number;
  citations: { n: number; label: string; quote: string; source: string }[];
  modelInfo?: Record<string, string>;
  createdBy?: PersonRef | null;
  approvedBy?: PersonRef | null;
  approvedAt?: ISODateTime | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type DenialStatus = "new" | "analyzing" | "appeal_drafted" | "appealed" | "overturned" | "upheld";
export interface Denial {
  id: UUID;
  caseId: UUID;
  caseNumber?: string;
  caseTitle?: string;
  payerName?: string;
  documentId?: UUID | null;
  receivedAt: ISODate;
  reasonText: string;
  carcCodes: string[];
  rarcCodes: string[];
  category: "medical_necessity" | "documentation" | "coding" | "eligibility" | "timely_filing" | "other";
  mappedCriteria: { criterionId: string; text: string; confidence: number }[];
  appealDeadline: ISODate;
  appealLetterId?: UUID | null;
  status: DenialStatus;
  analysis?: { summary?: string; strategy?: string[] };
  createdAt: ISODateTime;
}

/* ── Knowledge ─────────────────────────────────────────────────────────── */
export type DocType = "NCD" | "LCD" | "Billing and Coding" | "Article" | "Response to Comments" | "Payer Policy";

export interface PolicySummary {
  id: UUID;
  sourceKey: string;
  title: string;
  docType: DocType;
  status: "active" | "retired" | "future";
  version: number;
  effectiveFrom: ISODate;
  effectiveTo?: ISODate | null;
  contractors: { id: number; name: string }[];
  states: string[];
  codeCount: number;
  hasCriteria: boolean;
  snippet?: string | null;
  score?: number | null;
}

export interface PolicySection {
  id: UUID;
  sectionKey: string;
  title: string;
  text: string;
  ordinal: number;
}

export interface PolicyVersionInfo {
  id: UUID;
  version: number;
  effectiveFrom: ISODate;
  effectiveTo?: ISODate | null;
  lastUpdated: ISODateTime;
  summary?: string | null;
}

export interface PolicyDetail extends PolicySummary {
  url?: string | null;
  keywords?: string | null;
  currentVersionId: UUID;
  sections: PolicySection[];
  versions: PolicyVersionInfo[];
  linked: { policyId: UUID; sourceKey: string; title: string; docType: DocType; relation: string }[];
  codeCounts: Record<string, number>;
}

export interface PolicyCode {
  codeSystem: "HCPCS" | "ICD10_COVERED" | "ICD10_NONCOVERED" | "ICD10_PCS";
  code: string;
  groupNo: number;
  description: string;
  isRange?: boolean;
}

export interface DiffHunk {
  op: "equal" | "insert" | "delete";
  text: string;
}
export interface PolicyDiff {
  from: number;
  to: number;
  sections: { sectionKey: string; title: string; status: "added" | "removed" | "changed" | "same"; hunks: DiffHunk[] }[];
}

export interface CriteriaNode {
  op?: "AND" | "OR" | "N_OF_M";
  n?: number;
  id?: string;
  text?: string;
  kind?: CriterionResult["kind"];
  evidenceType?: string[];
  lookbackDays?: number | null;
  sourceSpan?: { section: string; quote: string };
  children?: CriteriaNode[];
}

export interface CriteriaSet {
  id: UUID;
  policyVersionId: UUID;
  policyTitle?: string;
  sourceKey?: string;
  version?: number;
  status: "draft" | "needs_review" | "approved" | "rejected" | "superseded";
  criteriaCount?: number;
  tree: CriteriaNode;
  extractorModel: string;
  verifierModel: string;
  agreement: number;
  groundingPassRate: number;
  notes?: string | null;
  reviewedBy?: PersonRef | null;
  reviewedAt?: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface CodeResult {
  system: "HCPCS" | "ICD10CM";
  code: string;
  shortDesc: string;
  longDesc?: string | null;
}

export interface CoverageGraph {
  nodes: { id: string; type: "code" | "article" | "lcd" | "ncd" | "payer" | "contractor" | "state"; label: string; meta?: Record<string, unknown> }[];
  edges: { source: string; target: string; type: string }[];
}

export interface KnowledgeStats {
  policies: Record<string, number>;
  versions: number;
  chunks: number;
  codes: number;
  lastIngestion?: { id: string; source: string; status: string; startedAt?: ISODateTime | null; finishedAt?: ISODateTime | null } | null;
  activeIndex?: { id: string; points: number; activatedAt?: ISODateTime | null } | null;
  freshnessDays?: number | null;
}

/* ── Retrieval / assistant ─────────────────────────────────────────────── */
export interface StageScores {
  dense?: number;
  sparse?: number;
  bm25?: number;
  fused?: number;
  rerank?: number;
}

export interface RouteTrace {
  intent: string;
  confidence: number;
  strategy: string;
  transforms: string[];
  filters: Record<string, unknown>;
  reason: string;
  retrievers?: string[];
  fusion?: string;
  rerank?: string | null;
  correctiveIterations?: number;
  abstained?: boolean;
  degraded?: string[];
}

export interface RetrievalChunk {
  chunkId: string;
  sourceKey: string;
  title: string;
  sectionKey: string;
  version: number;
  score: number;
  scores: StageScores;
  text?: string;
}

export interface Citation {
  n: number;
  chunkId: string;
  sourceKey: string;
  title: string;
  sectionKey: string;
  version: number;
  quote: string;
  url?: string | null;
}

export interface SqlResult {
  sql: string;
  columns: string[];
  rows: (string | number | null)[][];
  chartHint?: { type: "bar" | "line" | "pie" | "table"; x?: string; y?: string };
  summary?: string;
  warnings?: string[];
}

export interface Conversation {
  id: UUID;
  title: string;
  pinned: boolean;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  messages?: Message[];
}

export interface Message {
  id: UUID;
  conversationId: UUID;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  route?: RouteTrace | null;
  retrieval?: { chunks: RetrievalChunk[]; timings: Record<string, number> } | null;
  sql?: SqlResult | null;
  usage?: { promptTokens: number; completionTokens: number; latencyMs?: number; model?: string; provider?: string; cached?: boolean };
  feedback?: 1 | -1 | null;
  guardrails?: { kind: string; message: string }[];
  createdAt: ISODateTime;
}

/* ── Analytics / ops ───────────────────────────────────────────────────── */
export interface AnalyticsOverview {
  kpis: {
    openCases: number;
    dueSoon: number;
    readyRate: number;
    avgReadinessScore: number;
    gapsCaughtPreSubmission: number;
    deniedCases: number;
    appealsOverturned: number;
    avgTurnaroundHours: number | null;
    estimatedHoursSaved: number;
  };
  trends: {
    casesByDay: { date: ISODate; count: number }[];
    readinessByWeek: { week: string; ready: number; gaps: number; notSupported: number }[];
  };
  topGapCriteria: { criterionText: string; count: number }[];
  denialReasons: { category: string; count: number }[];
  payerMix: { payerType: PayerType; count: number }[];
}

export interface TeamLoad {
  user: PersonRef;
  role: Role;
  open: number;
  dueSoon: number;
  completed30d: number;
}

export interface ActivityItem {
  id: UUID;
  actor?: PersonRef | null;
  verb: string;
  target: string;
  link?: string;
  createdAt: ISODateTime;
}

export interface NotificationItem {
  id: UUID;
  type: string;
  title: string;
  body: string;
  link?: string | null;
  readAt?: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface AuditEntry {
  id: number;
  actor?: PersonRef | null;
  actorId?: string | null;
  actorName?: string | null;
  actorType: "user" | "system" | "api_key";
  action: string;
  resourceType: string;
  resourceId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata: Record<string, unknown>;
  hash: string;
  prevHash?: string | null;
  createdAt: ISODateTime;
}

export interface Job {
  id: UUID;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  message?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: ISODateTime;
  startedAt?: ISODateTime | null;
  finishedAt?: ISODateTime | null;
}

export interface IngestionRun {
  id: UUID;
  source: "mcd" | "codesets" | "payer_upload" | "fixtures";
  scope: Record<string, unknown>;
  status: "queued" | "running" | "succeeded" | "failed";
  stats: Record<string, number>;
  error?: string | null;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime | null;
}

export interface IndexVersion {
  id: UUID;
  alias: string;
  physicalName: string;
  embedModel: string;
  dims: number;
  sparseModel: string;
  status: "building" | "ready" | "active" | "retired" | "failed";
  points: number;
  stats: Record<string, number>;
  createdAt: ISODateTime;
  activatedAt?: ISODateTime | null;
}

export interface ModelDeployment {
  provider: string;
  model: string;
  configured: boolean;
  healthy?: boolean;
  cooldownUntil?: ISODateTime | null;
  rpm?: number | null;
  rpd?: number | null;
  usedToday?: number;
  p50LatencyMs?: number | null;
  errorRate?: number | null;
}

export interface ModelGroup {
  name: string;
  purpose: string;
  dataClasses: ("PUBLIC" | "INTERNAL" | "PHI")[];
  deployments: ModelDeployment[];
}

export interface ModelsOverview {
  groups: ModelGroup[];
  embedding: { model: string; dims: number; configured?: boolean };
  reranker: { chain: { provider?: string; model?: string; llmGroup?: string; configured: boolean }[] };
  phiAllowedGroups?: string[];
  fake?: boolean;
}

/** Usage as the API reports it: per deployment, plus calls per day and provider. */
export interface ModelUsage {
  range: string;
  byDeployment: {
    provider: string;
    model: string;
    group: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
    avgLatencyMs: number;
    errors: number;
    cacheHits: number;
    fallbacks: number;
  }[];
  daily: { date: ISODate; provider: string; calls: number; tokens: number }[];
  blockedByPolicy: number;
  costUsd: number;
}

export interface EvalRun {
  id: UUID;
  suite: "retrieval" | "verdicts" | "sql" | "faithfulness" | "safety" | "e2e";
  status: "queued" | "running" | "succeeded" | "failed";
  metrics: Record<string, number>;
  config: Record<string, unknown>;
  gitSha?: string | null;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime | null;
  gates?: { metric: string; threshold: number; op: ">=" | "<=" | "=="; passed: boolean }[];
}

/* ── Streams ───────────────────────────────────────────────────────────── */
export type StreamEvent = { event: string; data: Record<string, unknown> };
