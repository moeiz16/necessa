import type {
  AnalyticsOverview,
  AuditEntry,
  Conversation,
  EvalRun,
  IndexVersion,
  IngestionRun,
  ModelGroup,
  ModelUsage,
  NotificationItem,
  TeamLoad,
} from "@/lib/api/types";
import { MEMBERS, ref } from "./seed-cases";

const daysAgo = (d: number, h = 0) => new Date(Date.now() - d * 86400_000 - h * 3600_000).toISOString();
const dateOnly = (iso: string) => iso.slice(0, 10);

// deterministic pseudo-random so the demo looks the same on every load
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export function buildAnalytics(range = 30): AnalyticsOverview {
  const r = rng(42);
  const casesByDay = Array.from({ length: range }, (_, i) => {
    const d = new Date(Date.now() - (range - 1 - i) * 86400_000);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    return { date: dateOnly(d.toISOString()), count: weekend ? Math.round(r() * 2) : 5 + Math.round(r() * 7) };
  });
  const weeks = Math.max(4, Math.round(range / 7));
  const readinessByWeek = Array.from({ length: weeks }, (_, i) => {
    const ready = 14 + Math.round(r() * 6) + i * 2;
    return { week: `W${44 - weeks + i + 1}`, ready, gaps: 9 + Math.round(r() * 5) - Math.floor(i / 2), notSupported: 1 + Math.round(r() * 3) };
  });
  return {
    kpis: {
      openCases: 10,
      dueSoon: 3,
      readyRate: 0.64,
      avgReadinessScore: 0.81,
      gapsCaughtPreSubmission: 37,
      deniedCases: 2,
      appealsOverturned: 1,
      avgTurnaroundHours: 19.4,
      estimatedHoursSaved: 61.5,
    },
    trends: { casesByDay, readinessByWeek },
    topGapCriteria: [
      { criterionText: "≥ 4 weeks of failed conservative care documented", count: 14 },
      { criterionText: "Contraindication / anticoagulation attestation", count: 11 },
      { criterionText: "Validated pain or disability score recorded", count: 8 },
      { criterionText: "Supplier instruction on device use (DME)", count: 5 },
      { criterionText: "Trial outcome with pre/post function scores", count: 3 },
    ],
    denialReasons: [
      { category: "medical_necessity", count: 4 },
      { category: "documentation", count: 3 },
      { category: "coding", count: 1 },
      { category: "eligibility", count: 1 },
    ],
    payerMix: [
      { payerType: "medicare_ffs", count: 58 },
      { payerType: "medicare_advantage", count: 23 },
      { payerType: "commercial", count: 15 },
      { payerType: "medicaid", count: 4 },
    ],
  };
}

export function buildTeam(): TeamLoad[] {
  return MEMBERS.filter((m) => ["coordinator", "clinician", "reviewer", "rcm_manager"].includes(m.role)).map((m, i) => ({
    user: { id: m.id, fullName: m.fullName, avatarColor: m.avatarColor },
    role: m.role,
    open: [5, 1, 2, 3, 2][i] ?? 1,
    dueSoon: [2, 0, 1, 1, 0][i] ?? 0,
    completed30d: [41, 12, 18, 26, 9][i] ?? 5,
  }));
}

/* ── LLM providers / models ─────────────────────────────────────────────── */
const dep = (
  provider: string,
  model: string,
  o: Partial<{ configured: boolean; healthy: boolean; rpm: number; rpd: number; used: number; p50: number; err: number; cooldown: boolean }> = {},
) => ({
  provider,
  model,
  configured: o.configured ?? true,
  healthy: o.healthy ?? true,
  cooldownUntil: o.cooldown ? new Date(Date.now() + 7 * 60_000).toISOString() : null,
  rpm: o.rpm ?? null,
  rpd: o.rpd ?? null,
  usedToday: o.used ?? 0,
  p50LatencyMs: o.p50 ?? null,
  errorRate: o.err ?? 0,
});

export const MODEL_GROUPS: ModelGroup[] = [
  {
    name: "router-small",
    purpose: "Intent routing, query rewriting, decomposition",
    dataClasses: ["PUBLIC", "PHI"],
    deployments: [dep("groq", "llama-3.1-8b-instant", { rpm: 30, rpd: 14400, used: 412, p50: 210 }), dep("gemini", "gemini-2.5-flash-lite", { rpm: 15, rpd: 1000, used: 37, p50: 480 })],
  },
  {
    name: "qa-public",
    purpose: "Grounded policy Q&A synthesis (no PHI)",
    dataClasses: ["PUBLIC"],
    deployments: [
      dep("groq", "llama-3.3-70b-versatile", { rpm: 30, rpd: 1000, used: 286, p50: 690, err: 0.012 }),
      dep("gemini", "gemini-2.5-flash", { rpm: 10, rpd: 250, used: 41, p50: 1240 }),
      dep("openrouter", "meta-llama/llama-3.3-70b-instruct:free", { rpm: 20, rpd: 50, used: 12, p50: 2100, err: 0.08 }),
    ],
  },
  {
    name: "judge",
    purpose: "Per-criterion verdicts over de-identified chart evidence",
    dataClasses: ["PHI"],
    deployments: [
      dep("groq", "openai/gpt-oss-120b", { rpm: 30, rpd: 1000, used: 538, p50: 940, err: 0.006 }),
      dep("gemini", "gemini-2.5-flash", { rpm: 10, rpd: 250, used: 66, p50: 1380 }),
    ],
  },
  {
    name: "verifier",
    purpose: "Cross-family verification & LLM-as-judge (different family than generator)",
    dataClasses: ["PUBLIC", "PHI"],
    deployments: [dep("gemini", "gemini-2.5-flash", { rpm: 10, rpd: 250, used: 188, p50: 1310 }), dep("groq", "qwen/qwen3-32b", { rpm: 30, rpd: 1000, used: 22, p50: 820 })],
  },
  {
    name: "sql",
    purpose: "Text-to-SQL over allowlisted analytics views",
    dataClasses: ["INTERNAL"],
    deployments: [dep("groq", "openai/gpt-oss-20b", { rpm: 30, rpd: 1000, used: 74, p50: 520 }), dep("gemini", "gemini-2.5-flash", { rpm: 10, rpd: 250, used: 3, p50: 1190 })],
  },
  {
    name: "drafter",
    purpose: "Letters of medical necessity & appeals (de-identified facts, rehydrated locally)",
    dataClasses: ["PHI"],
    deployments: [
      dep("groq", "llama-3.3-70b-versatile", { rpm: 30, rpd: 1000, used: 19, p50: 1730 }),
      dep("gemini", "gemini-2.5-flash", { rpm: 10, rpd: 250, used: 4, p50: 2210 }),
    ],
  },
  {
    name: "compiler-longctx",
    purpose: "Criteria compilation from long policy text (offline, quota-paced)",
    dataClasses: ["PUBLIC"],
    deployments: [dep("gemini", "gemini-2.5-flash", { rpm: 10, rpd: 250, used: 31, p50: 6400 }), dep("mistral", "mistral-small-latest", { configured: false, healthy: false })],
  },
  {
    name: "ocr-vision",
    purpose: "Scanned PDF / fax OCR",
    dataClasses: ["PHI"],
    deployments: [dep("gemini", "gemini-2.5-flash", { rpm: 10, rpd: 250, used: 6, p50: 3900 })],
  },
  {
    name: "guard",
    purpose: "Prompt-injection & policy classifier (second opinion over heuristics)",
    dataClasses: ["PUBLIC", "PHI"],
    deployments: [
      dep("groq", "llama-3.1-8b-instant", { rpm: 30, rpd: 14400, used: 96, p50: 180 }),
      dep("cerebras", "llama3.1-8b", { configured: false, healthy: false }),
      dep("openrouter", "google/gemma-3-27b-it:free", { rpm: 20, rpd: 50, used: 50, healthy: false, cooldown: true, err: 0.21 }),
    ],
  },
];

export function buildModelUsage(days = 7): ModelUsage {
  const r = rng(7);
  const byDay = Array.from({ length: days }, (_, i) => {
    const calls = 380 + Math.round(r() * 260);
    return {
      date: dateOnly(new Date(Date.now() - (days - 1 - i) * 86400_000).toISOString()),
      calls,
      tokens: calls * (1900 + Math.round(r() * 700)),
      errors: Math.round(calls * (0.004 + r() * 0.02)),
      cacheHits: Math.round(calls * (0.18 + r() * 0.12)),
      fallbacks: Math.round(calls * (0.02 + r() * 0.05)),
    };
  });
  return {
    byDay,
    byProvider: [
      { provider: "groq", calls: 2190, tokens: 4_120_000, p50LatencyMs: 640, errorRate: 0.009 },
      { provider: "gemini", calls: 812, tokens: 2_380_000, p50LatencyMs: 1310, errorRate: 0.004 },
      { provider: "cohere", calls: 1460, tokens: 0, p50LatencyMs: 290, errorRate: 0.002 },
      { provider: "openrouter", calls: 88, tokens: 140_000, p50LatencyMs: 2100, errorRate: 0.11 },
    ],
    byGroup: MODEL_GROUPS.map((g) => ({ group: g.name, calls: g.deployments.reduce((a, d) => a + d.usedToday, 0) * 6, tokens: g.deployments.reduce((a, d) => a + d.usedToday, 0) * 9_400 })),
    totals: { calls: byDay.reduce((a, d) => a + d.calls, 0), tokens: byDay.reduce((a, d) => a + d.tokens, 0), cacheHitRate: 0.24, fallbackRate: 0.041, errorRate: 0.011 },
  };
}

/* ── Evals ──────────────────────────────────────────────────────────────── */
export function buildEvalRuns(): EvalRun[] {
  const r = rng(99);
  const suites: EvalRun["suite"][] = ["retrieval", "verdicts", "sql", "faithfulness", "safety"];
  const runs: EvalRun[] = [];
  for (let w = 7; w >= 0; w--) {
    for (const suite of suites) {
      const drift = (7 - w) * 0.006;
      const m: Record<string, number> =
        suite === "retrieval"
          ? {
              "recall@10": 0.86 + drift + r() * 0.01,
              mrr: 0.74 + drift + r() * 0.02,
              "ndcg@10": 0.72 + drift + r() * 0.02,
              "hit_rate@5": 0.88 + drift,
              "intent.S1": 1,
              "intent.S2": 0.95 + drift * 0.5,
              "intent.S4": 0.93 + drift * 0.5,
              "intent.S5": 0.71 + drift * 1.5,
              "intent.S6": 0.9 + drift * 0.5,
              "intent.S8": 0.84 + drift,
              "intent.S9": 1,
              "intent.S10": 0.92 + drift * 0.5,
              "intent.S11": 1,
            }
          : suite === "verdicts"
            ? { macro_f1: 0.81 + drift + r() * 0.01, false_met_rate: Math.max(0.009, 0.034 - drift * 0.6), insufficient_recall: 0.86 + drift, ece: 0.07 - drift * 0.3 }
            : suite === "sql"
              ? { execution_accuracy: 0.8 + drift + r() * 0.01, validity_rate: 0.97 + r() * 0.02, self_correction_rate: 0.11 }
              : suite === "faithfulness"
                ? { faithfulness: 0.88 + drift + r() * 0.01, answer_relevance: 0.9 + r() * 0.02, citation_precision: 0.93 + drift * 0.5 }
                : { injection_block_rate: 0.93 + drift * 0.6, phi_leak_rate: 0, refusal_correctness: 0.95 + r() * 0.02 };
      Object.keys(m).forEach((k) => (m[k] = Math.round(m[k]! * 1000) / 1000));
      const gates =
        suite === "retrieval"
          ? [{ metric: "recall@10", threshold: 0.9, op: ">=" as const, passed: m["recall@10"]! >= 0.9 }]
          : suite === "verdicts"
            ? [{ metric: "false_met_rate", threshold: 0.02, op: "<=" as const, passed: m.false_met_rate! <= 0.02 }]
            : suite === "sql"
              ? [{ metric: "execution_accuracy", threshold: 0.85, op: ">=" as const, passed: m.execution_accuracy! >= 0.85 }]
              : suite === "faithfulness"
                ? [{ metric: "faithfulness", threshold: 0.9, op: ">=" as const, passed: m.faithfulness! >= 0.9 }]
                : [{ metric: "phi_leak_rate", threshold: 0, op: "==" as const, passed: m.phi_leak_rate === 0 }];
      runs.push({
        id: `evr-${suite}-${w}`,
        suite,
        status: "succeeded",
        metrics: m,
        config: { dataset: `${suite}-gold-v${3 + Math.floor((7 - w) / 3)}`, items: suite === "verdicts" ? 640 : suite === "retrieval" ? 212 : 150, judge: "gemini/gemini-2.5-flash" },
        gitSha: Math.floor(r() * 0xffffff).toString(16).padStart(7, "0"),
        startedAt: daysAgo(w * 7 + 1, 3),
        finishedAt: daysAgo(w * 7 + 1, 2),
        gates,
      });
    }
  }
  return runs.reverse();
}

/* ── Knowledge ops ──────────────────────────────────────────────────────── */
export function buildIngestionRuns(): IngestionRun[] {
  return [
    { id: "ing-9", source: "mcd", scope: { scope: "focus", refresh: "weekly" }, status: "succeeded", stats: { documentsSeen: 3363, changed: 41, sectionsUpserted: 188, chunksEmbedded: 612, skippedUnchanged: 3322, durationS: 486 }, startedAt: daysAgo(1, 9), finishedAt: daysAgo(1, 8.8) },
    { id: "ing-8", source: "codesets", scope: { icd10cm: "FY2027", hcpcs: "2026-Q4" }, status: "succeeded", stats: { codes: 79_544, changed: 1_204, durationS: 71 }, startedAt: daysAgo(6, 4), finishedAt: daysAgo(6, 3.9) },
    { id: "ing-7", source: "mcd", scope: { scope: "focus", refresh: "weekly" }, status: "failed", stats: { documentsSeen: 3358, changed: 12, chunksEmbedded: 140 }, error: "Embedding quota exhausted (gemini 429 RESOURCE_EXHAUSTED). Run paused and resumed automatically next window.", startedAt: daysAgo(8, 9), finishedAt: daysAgo(8, 8.7) },
    { id: "ing-6", source: "mcd", scope: { scope: "focus", refresh: "initial" }, status: "succeeded", stats: { documentsSeen: 3351, changed: 3351, sectionsUpserted: 9_874, chunksEmbedded: 21_406, durationS: 14_220 }, startedAt: daysAgo(31, 9), finishedAt: daysAgo(31, 5) },
    { id: "ing-5", source: "fixtures", scope: { set: "synthetic-v2" }, status: "succeeded", stats: { documents: 6, chunks: 54, durationS: 9 }, startedAt: daysAgo(40), finishedAt: daysAgo(40) },
  ];
}

export function buildIndexVersions(): IndexVersion[] {
  return [
    { id: "idx-8", alias: "policy_chunks", physicalName: "necessa_policy_chunks__v8", embedModel: "gemini/gemini-embedding-001", dims: 768, sparseModel: "bm25-snowball-v1", status: "ready", points: 22_018, stats: { "recall@10": 0.931, "ndcg@10": 0.792, smokeQueries: 40 }, createdAt: daysAgo(1, 8.8) },
    { id: "idx-7", alias: "policy_chunks", physicalName: "necessa_policy_chunks__v7", embedModel: "gemini/gemini-embedding-001", dims: 768, sparseModel: "bm25-snowball-v1", status: "active", points: 21_406, stats: { "recall@10": 0.927, "ndcg@10": 0.788, smokeQueries: 40 }, createdAt: daysAgo(31, 5), activatedAt: daysAgo(31, 4) },
    { id: "idx-6", alias: "policy_chunks", physicalName: "necessa_policy_chunks__v6", embedModel: "gemini/text-embedding-004", dims: 768, sparseModel: "bm25-snowball-v1", status: "retired", points: 20_877, stats: { "recall@10": 0.894 }, createdAt: daysAgo(62), activatedAt: daysAgo(61) },
    { id: "idx-c3", alias: "criteria", physicalName: "necessa_criteria__v3", embedModel: "gemini/gemini-embedding-001", dims: 768, sparseModel: "bm25-snowball-v1", status: "active", points: 1_284, stats: { smokeQueries: 12 }, createdAt: daysAgo(10), activatedAt: daysAgo(10) },
    { id: "idx-ch2", alias: "chart_chunks", physicalName: "necessa_chart_chunks__v2", embedModel: "gemini/gemini-embedding-001", dims: 768, sparseModel: "bm25-snowball-v1", status: "active", points: 3_912, stats: { tenants: 1 }, createdAt: daysAgo(31), activatedAt: daysAgo(31) },
    { id: "idx-sc1", alias: "semantic_cache", physicalName: "necessa_semantic_cache__v1", embedModel: "gemini/gemini-embedding-001", dims: 768, sparseModel: "—", status: "active", points: 488, stats: { hitRate: 0.24 }, createdAt: daysAgo(31), activatedAt: daysAgo(31) },
  ];
}

/* ── Audit (hash chained) ───────────────────────────────────────────────── */
function fakeHash(input: string) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ input.charCodeAt(i), 2246822519);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return (hex(h1) + hex(h2) + hex(h1 ^ h2) + hex(Math.imul(h1, 31) ^ h2)).repeat(2);
}

export function chainHash(prev: string | null, payload: string) {
  return fakeHash(`${prev ?? ""}|${payload}`);
}

export function buildAudit(): AuditEntry[] {
  const rows: [string | null, string, string, string | null, Record<string, unknown>, number][] = [
    ["u-maya", "auth.login", "session", null, { mfa: false }, 0.1],
    ["u-tessa", "case.criterion.override", "case", "case-32", { criterionId: "C7", from: "INSUFFICIENT", to: "MET" }, 2],
    ["u-jordan", "case.evaluate", "case", "case-42", { policy: "L36920 v107" }, 1.1],
    [null, "case.evaluation.completed", "case", "case-42", { readiness: "gaps", tokens: 24_310 }, 1.05],
    ["u-jordan", "document.upload", "case_document", "doc-42-4", { kind: "clinical_note" }, 28.4],
    ["u-priya", "document.reveal_phi", "case_document", "doc-32-1", { reason: "Verify referring office note" }, 3.2],
    [null, "guardrail.injection.quarantine", "case_document", "doc-32-1", { score: 0.91, rule: "instruction_override" }, 3.3],
    ["u-sam", "letter.approve", "letter", "let-41-lmn", { version: 2 }, 4],
    ["u-maya", "org.member.invite", "invitation", "inv-1", { email: "nina@riverbend.demo", role: "coordinator" }, 26],
    ["u-maya", "knowledge.index.activate", "index_version", "idx-7", { alias: "policy_chunks" }, 31 * 24 - 4],
    ["u-tessa", "criteria.approve", "criteria_set", "crit-esi", { agreement: 0.94 }, 42 * 24],
    ["u-luis", "denial.record", "denial", "den-36", { carc: ["50"], rarc: ["N115"] }, 20 * 24],
    ["u-grace", "audit.verify", "audit_log", null, { valid: true, checked: 18_402 }, 24],
    ["u-maya", "org.api_key.create", "api_key", "key-1", { name: "EHR integration (sandbox)" }, 50],
    [null, "llm.fallback", "llm_call", null, { group: "qa-public", from: "openrouter", to: "groq", reason: "429" }, 6],
  ];
  const sorted = rows.sort((a, b) => b[5] - a[5]);
  let prev: string | null = null;
  const out: AuditEntry[] = [];
  sorted.forEach(([actor, action, rt, rid, md, h], i) => {
    const createdAt = daysAgo(0, h);
    const hash = chainHash(prev, `${action}|${rid}|${createdAt}`);
    out.push({
      id: 18_388 + i,
      actor: actor ? ref(actor) : null,
      actorType: actor ? "user" : "system",
      action,
      resourceType: rt,
      resourceId: rid,
      ip: actor ? `10.12.4.${20 + i}` : null,
      userAgent: actor ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15" : null,
      metadata: md,
      prevHash: prev,
      hash,
      createdAt,
    });
    prev = hash;
  });
  return out.reverse();
}

export function buildNotifications(): NotificationItem[] {
  return [
    { id: "n-1", type: "sla", title: "Expedited case due in 9 hours", body: "NC-2026-00032 · Left L4-L5 transforaminal ESI has 1 open gap.", link: "/cases/case-32", createdAt: daysAgo(0, 0.5) },
    { id: "n-2", type: "evaluation", title: "Evaluation finished with 2 gaps", body: "NC-2026-00042 · readiness 71%. Contraindication attestation missing.", link: "/cases/case-42", createdAt: daysAgo(0, 1) },
    { id: "n-3", type: "security", title: "Document quarantined", body: "A note on NC-2026-00032 contained instruction-like text and was excluded from evidence.", link: "/cases/case-32?tab=documents", createdAt: daysAgo(0, 3.3) },
    { id: "n-4", type: "policy", title: "LCD L33789 v49 takes effect Dec 20", body: "Power Mobility Devices — documentation requirements revised. 1 open case affected.", link: "/policies/pol-l33789", createdAt: daysAgo(0, 9) },
    { id: "n-5", type: "criteria", title: "2 criteria sets need review", body: "Spinal Cord Stimulators (L35136) and PVA (L34228) compiled with agreement below 0.9.", link: "/knowledge?tab=criteria", readAt: daysAgo(0, 2), createdAt: daysAgo(1, 2) },
    { id: "n-6", type: "denial", title: "New denial: SCS trial", body: "NC-2026-00030 · CARC 50 / RARC N115 mapped to criterion C3.", link: "/denials", readAt: daysAgo(3), createdAt: daysAgo(12) },
  ];
}

export function buildConversations(): Conversation[] {
  return [
    {
      id: "conv-1",
      title: "ESI conservative care requirement",
      pinned: true,
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
      messages: [
        {
          id: "m-1",
          conversationId: "conv-1",
          role: "user",
          content: "How many weeks of conservative care does Novitas require before a lumbar ESI?",
          citations: [],
          createdAt: daysAgo(2),
        },
        {
          id: "m-2",
          conversationId: "conv-1",
          role: "assistant",
          content:
            "Under LCD **L36920** (Epidural Steroid Injections for Pain Management, v107), the patient must have **failed at least 4 weeks of conservative care** — physical therapy, a home exercise program and/or medications — unless conservative care is contraindicated and that contraindication is documented [1]. The pre-procedure evaluation must also record the duration and outcome of that care [2].",
          citations: [
            { n: 1, chunkId: "L36920#ind-3", sourceKey: "L36920", title: "Epidural Steroid Injections for Pain Management", sectionKey: "indication", version: 107, quote: "The patient must have failed at least 4 weeks of conservative care, including physical therapy, a home exercise program and/or medications" },
            { n: 2, chunkId: "L36920#doc-1", sourceKey: "L36920", title: "Epidural Steroid Injections for Pain Management", sectionKey: "doc_reqs", version: 107, quote: "the duration and outcome of conservative care" },
          ],
          route: { intent: "conceptual_policy", confidence: 0.91, strategy: "S4 · hybrid + rerank", transforms: ["abbrev_expand", "self_query"], filters: { states: ["TX"], docTypes: ["LCD"], asOf: "2026-11-11" }, reason: "Conceptual question about a policy requirement; payer jurisdiction inferred from 'Novitas'.", retrievers: ["dense", "sparse", "bm25"], fusion: "rrf(k=60)", rerank: "cohere/rerank-v3.5", correctiveIterations: 0, abstained: false, degraded: [] },
          usage: { promptTokens: 3110, completionTokens: 142, latencyMs: 1840, model: "llama-3.3-70b-versatile", provider: "groq", cached: false },
          feedback: 1,
          createdAt: daysAgo(2),
        },
      ],
    },
    { id: "conv-2", title: "CPAP adherence window", pinned: false, createdAt: daysAgo(5), updatedAt: daysAgo(5), messages: [] },
    { id: "conv-3", title: "Top gap criteria this month", pinned: false, createdAt: daysAgo(9), updatedAt: daysAgo(9), messages: [] },
  ];
}

export { ref };
