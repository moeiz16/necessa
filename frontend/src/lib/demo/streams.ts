"use client";

/* Simulated SSE streams for demo mode — same event names/payloads as docs/API_CONTRACT.md §5. */

import type {
  Citation,
  CriteriaNode,
  CriterionResult,
  Evaluation,
  Gap,
  Message,
  PolicyMatch,
  RetrievalChunk,
  RouteTrace,
  SqlResult,
  StreamEvent,
  Verdict,
} from "@/lib/api/types";
import { sleep } from "@/lib/utils";
import { evaluateTree } from "./seed-cases";
import { resolvePolicies } from "./handlers";
import { addEvent, appendAudit, getDB, nextId, notify, saveDB, type DemoDB } from "./store";

const ev = (event: string, data: Record<string, unknown>): StreamEvent => ({ event, data });

function* chunkText(text: string) {
  const re = /(\S+\s*)/g;
  let m: RegExpExecArray | null;
  let buf = "";
  let i = 0;
  while ((m = re.exec(text))) {
    buf += m[1];
    i++;
    if (i % 2 === 0) {
      yield buf;
      buf = "";
    }
  }
  if (buf) yield buf;
}

/* ── Retrieval simulation ───────────────────────────────────────────────── */
const STOP = new Set("the a an and or of for to in on with without is are be does do what which how many much when who this that these those it its my our we i me before after under than at by from as about into can".split(" "));

function terms(q: string) {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

function scoreChunks(db: DemoDB, q: string, opts: { keys?: string[]; topK?: number } = {}) {
  const ts = terms(q);
  const rows: { chunk: RetrievalChunk; text: string }[] = [];
  for (const p of db.policies) {
    if (opts.keys && !opts.keys.includes(p.sourceKey)) continue;
    p.sections.forEach((s) => {
      const sentences = s.text.split(/(?<=\.)\s+/);
      sentences.forEach((sent, i) => {
        const low = sent.toLowerCase();
        const hits = ts.filter((t) => low.includes(t)).length;
        if (!hits && !opts.keys) return;
        const titleBoost = ts.filter((t) => p.title.toLowerCase().includes(t)).length;
        const dense = Math.min(0.94, 0.48 + hits * 0.09 + titleBoost * 0.05);
        const bm25 = Math.min(18, hits * 3.4 + titleBoost * 1.2);
        const sparse = Math.min(0.9, 0.3 + hits * 0.12);
        rows.push({
          text: sent,
          chunk: {
            chunkId: `${p.sourceKey}#${s.sectionKey}-${i}`,
            sourceKey: p.sourceKey,
            title: p.title,
            sectionKey: s.sectionKey,
            version: p.version,
            score: 0,
            scores: { dense: round(dense), sparse: round(sparse), bm25: round(bm25) },
            text: sent,
          },
        });
      });
    });
  }
  // RRF fusion across the three retrievers, then a "cross-encoder" rerank
  const rankBy = (k: "dense" | "sparse" | "bm25") => [...rows].sort((a, b) => (b.chunk.scores[k] ?? 0) - (a.chunk.scores[k] ?? 0));
  const fused = new Map<string, number>();
  (["dense", "sparse", "bm25"] as const).forEach((k) =>
    rankBy(k).forEach((r, i) => fused.set(r.chunk.chunkId, (fused.get(r.chunk.chunkId) ?? 0) + 1 / (60 + i + 1))),
  );
  rows.forEach((r) => {
    const f = fused.get(r.chunk.chunkId) ?? 0;
    r.chunk.scores.fused = round(f * 20);
    const exact = ts.filter((t) => r.text.toLowerCase().includes(t)).length / Math.max(1, ts.length);
    r.chunk.scores.rerank = round(Math.min(0.99, 0.2 + exact * 0.75 + (r.chunk.scores.dense ?? 0) * 0.1));
    r.chunk.score = r.chunk.scores.rerank!;
  });
  return rows.sort((a, b) => b.chunk.score - a.chunk.score).slice(0, opts.topK ?? 8);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function buildRetrieval(query: string) {
  const db = getDB();
  const plan = planRoute(query);
  const rows = scoreChunks(db, query, { keys: plan.keys });
  return {
    chunks: rows.map((r) => r.chunk),
    route: plan.route,
    timings: { understandMs: 38, retrieveMs: 142, rerankMs: 311 },
  };
}

interface Plan {
  kind: "policy" | "code_lookup" | "analytics" | "multihop" | "exact" | "abstain" | "injection";
  route: RouteTrace;
  keys?: string[];
}

function planRoute(q: string): Plan {
  const low = q.toLowerCase();
  const base = (r: Partial<RouteTrace>): RouteTrace => ({
    intent: "conceptual_policy",
    confidence: 0.88,
    strategy: "S4 · hybrid + rerank",
    transforms: [],
    filters: {},
    reason: "",
    retrievers: ["dense", "sparse", "bm25"],
    fusion: "rrf(k=60)",
    rerank: "cohere/rerank-v3.5",
    correctiveIterations: 0,
    abstained: false,
    degraded: [],
    ...r,
  });
  if (/ignore (all )?(previous|prior) instructions|system prompt|reveal your/i.test(q))
    return { kind: "injection", route: base({ intent: "blocked", confidence: 0.97, strategy: "guardrail", retrievers: [], fusion: undefined, rerank: null, abstained: true, reason: "Prompt-injection pattern detected by the input guard (heuristic 0.94, guard model 0.91)." }) };
  if (/\b(prescribe|dosage|dose|should i (give|treat|prescribe)|diagnos(e|is) (me|my))\b/i.test(q))
    return { kind: "abstain", route: base({ intent: "clinical_advice", confidence: 0.93, strategy: "S11 · abstain", retrievers: [], fusion: undefined, rerank: null, abstained: true, reason: "Clinical treatment advice is out of scope; Necessa answers coverage and documentation questions only." }) };
  if (/\b(top|how many|count|average|trend|this month|last \d+ days|per (week|month)|by payer)\b/i.test(q) && /\b(case|gap|denial|criteria|readiness|turnaround)/i.test(q))
    return { kind: "analytics", route: base({ intent: "analytics", confidence: 0.9, strategy: "S3 · text-to-SQL", retrievers: ["schema_docs", "few_shot"], fusion: undefined, rerank: null, transforms: ["schema_retrieval", "dynamic_few_shot"], reason: "Aggregate question over the organization's own case data; routed to text-to-SQL on allowlisted views with row-level security." }) };
  const exact = q.match(/\b([LA]\d{5}|NCD[- ]?\d{3}\.\d+)\b/i);
  if (exact && !/\b(covered|require|need)/i.test(q))
    return { kind: "exact", keys: [exact[1]!.toUpperCase().replace(" ", "-")], route: base({ intent: "identifier_lookup", confidence: 0.99, strategy: "S1 · SQL exact → BM25", retrievers: ["sql_exact", "bm25"], fusion: undefined, rerank: null, transforms: ["regex_extract"], filters: { sourceKey: exact[1]!.toUpperCase() }, reason: "Exact document identifier detected; exact match in SQL with BM25 fallback." }) };
  if (/\bm17\.1[12]\b/i.test(q) || (/covered/i.test(q) && /\b(knee|tka|arthroplasty)\b/i.test(q)))
    return { kind: "multihop", keys: ["L36575", "A57685"], route: base({ intent: "multi_hop", confidence: 0.86, strategy: "S8 · decompose → graph/SQL + hybrid", retrievers: ["graph", "sql_tools", "dense", "sparse", "bm25"], transforms: ["decomposition", "self_query"], filters: { states: ["AZ"], codes: ["27447", "M17.11"] }, reason: "Two sub-questions: coverage of the diagnosis (structured: article ICD-10 groups) and documentation requirements (text)." }) };
  const code = q.match(/\b(\d{5}|[A-Z]\d{4})\b/);
  if (code && /\b(which|what|list|policies|lcds?)\b/i.test(q))
    return { kind: "code_lookup", route: base({ intent: "structured_lookup", confidence: 0.92, strategy: "S2 · SQL/graph tools", retrievers: ["tool:find_policies_by_code"], fusion: undefined, rerank: null, transforms: ["regex_extract", "state_to_jurisdiction"], filters: { code: code[1], states: /texas|\btx\b/i.test(q) ? ["TX"] : [] }, reason: "Structured relationship question (code → article → LCD → contractor → state); answered by a parameterized tool." }) };
  if (/cpap|positive airway|adherence|sleep apnea/i.test(low))
    return { kind: "policy", keys: ["L33718", "A52467", "NCD-240.4"], route: base({ transforms: ["abbrev_expand", "synonym_expand"], filters: { docTypes: ["LCD", "NCD", "Article"] }, reason: "Conceptual policy question; DME policy family resolved from 'CPAP' via synonym expansion." }) };
  if (/\besi\b|epidural|conservative care|radicul/i.test(low))
    return { kind: "policy", keys: ["L36920", "A56681"], route: base({ transforms: ["abbrev_expand", "self_query"], filters: { states: /novitas|texas|\btx\b/i.test(q) ? ["TX"] : [], docTypes: ["LCD"] }, reason: "Conceptual question about a policy requirement; payer jurisdiction inferred from the question." }) };
  if (/spinal cord|scs|stimulat/i.test(low))
    return { kind: "policy", keys: ["L35136", "NCD-160.7"], route: base({ transforms: ["synonym_expand"], reason: "Conceptual policy question about neurostimulation." }) };
  return { kind: "policy", route: base({ transforms: ["rewrite"], reason: "General coverage question; hybrid retrieval across the policy corpus." }) };
}

export function buildSql(question: string): SqlResult {
  const low = question.toLowerCase();
  if (/denial/.test(low))
    return {
      sql: `SELECT category, COUNT(*) AS denials\nFROM v_case_denials\nWHERE received_at >= date_trunc('month', CURRENT_DATE)\nGROUP BY category\nORDER BY denials DESC\nLIMIT 10;`,
      columns: ["category", "denials"],
      rows: [["medical_necessity", 4], ["documentation", 3], ["coding", 1], ["eligibility", 1]],
      chartHint: { type: "bar", x: "category", y: "denials" },
      summary: "Medical-necessity denials lead this month (4), followed by documentation (3).",
      warnings: [],
    };
  if (/payer/.test(low))
    return {
      sql: `SELECT payer_type, COUNT(*) AS cases,\n       ROUND(AVG(readiness_score)::numeric, 2) AS avg_readiness\nFROM v_case_summary\nWHERE created_at >= CURRENT_DATE - INTERVAL '30 days'\nGROUP BY payer_type\nORDER BY cases DESC\nLIMIT 10;`,
      columns: ["payer_type", "cases", "avg_readiness"],
      rows: [["medicare_ffs", 58, 0.83], ["medicare_advantage", 23, 0.79], ["commercial", 15, 0.81], ["medicaid", 4, 0.74]],
      chartHint: { type: "bar", x: "payer_type", y: "cases" },
      summary: "Medicare FFS makes up 58% of volume; Medicaid cases trail on readiness (0.74).",
      warnings: [],
    };
  if (/turnaround|time|hours/.test(low))
    return {
      sql: `SELECT date_trunc('week', submitted_at)::date AS week,\n       ROUND(AVG(EXTRACT(EPOCH FROM submitted_at - created_at) / 3600)::numeric, 1) AS avg_hours\nFROM v_case_summary\nWHERE submitted_at IS NOT NULL\nGROUP BY 1 ORDER BY 1\nLIMIT 12;`,
      columns: ["week", "avg_hours"],
      rows: [["2026-09-28", 31.2], ["2026-10-05", 27.9], ["2026-10-12", 24.4], ["2026-10-19", 22.1], ["2026-10-26", 20.6], ["2026-11-02", 19.4], ["2026-11-09", 18.7]],
      chartHint: { type: "line", x: "week", y: "avg_hours" },
      summary: "Average time to submission fell from 31 h to under 19 h over seven weeks.",
      warnings: [],
    };
  return {
    sql: `SELECT criterion_text, COUNT(*) AS gap_count\nFROM v_case_gap_stats\nWHERE evaluated_at >= date_trunc('month', CURRENT_DATE)\nGROUP BY criterion_text\nORDER BY gap_count DESC\nLIMIT 5;`,
    columns: ["criterion_text", "gap_count"],
    rows: [
      ["≥ 4 weeks of failed conservative care documented", 14],
      ["Contraindication / anticoagulation attestation", 11],
      ["Validated pain or disability score recorded", 8],
      ["Supplier instruction on device use (DME)", 5],
      ["Trial outcome with pre/post function scores", 3],
    ],
    chartHint: { type: "bar", x: "criterion_text", y: "gap_count" },
    summary: "Conservative-care duration is the most frequent gap (14 cases), followed by missing contraindication attestations (11).",
    warnings: ["Cells with fewer than 11 cases are shown because they contain no patient-level data."],
  };
}

/* ── Assistant stream ───────────────────────────────────────────────────── */
async function* assistantStream(db: DemoDB, conversationId: string, content: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const conv = db.conversations.find((c) => c.id === conversationId);
  if (!conv) {
    yield ev("error", { message: "Conversation not found", retryable: false });
    return;
  }
  const t0 = performance.now();
  const userMsg: Message = { id: nextId("m"), conversationId, role: "user", content, citations: [], createdAt: new Date().toISOString() };
  conv.messages = [...(conv.messages ?? []), userMsg];
  if (conv.title === "New conversation") conv.title = content.length > 48 ? `${content.slice(0, 46).trim()}…` : content;
  conv.updatedAt = new Date().toISOString();

  await sleep(260);
  const plan = planRoute(content);
  yield ev("route", plan.route as unknown as Record<string, unknown>);
  if (signal?.aborted) return;

  let answer = "";
  let citations: Citation[] = [];
  let sql: SqlResult | null = null;
  let retrieval: Message["retrieval"] = null;
  const guardrails: { kind: string; message: string }[] = [];

  if (plan.kind === "injection") {
    await sleep(200);
    guardrails.push({ kind: "injection", message: "This message looks like an attempt to override system instructions. It was not sent to a model." });
    yield ev("guardrail", guardrails[0]!);
    answer = "I can't follow instructions that try to change how I operate. I can help with coverage policies, documentation requirements, codes and your case data.";
  } else if (plan.kind === "abstain") {
    await sleep(200);
    guardrails.push({ kind: "policy", message: "Clinical treatment advice is outside Necessa's scope." });
    yield ev("guardrail", guardrails[0]!);
    answer = "I can't give treatment or prescribing advice — that decision belongs to the treating clinician. I can tell you what a payer policy requires to document medical necessity for a given service, or check a case against those criteria.";
  } else if (plan.kind === "analytics") {
    await sleep(500);
    sql = buildSql(content);
    yield ev("tool", { name: "text_to_sql", args: { question: content, views: ["v_case_gap_stats", "v_case_summary", "v_case_denials"] }, result: { validated: true, readOnly: true, rowLimit: 1000 } });
    await sleep(380);
    yield ev("sql", sql as unknown as Record<string, unknown>);
    answer = `${sql.summary} The query ran read-only against allowlisted, tenant-scoped views — expand **SQL** to see exactly what was executed.`;
  } else if (plan.kind === "code_lookup") {
    await sleep(320);
    const code = String((plan.route.filters as { code?: string }).code ?? "");
    const states = (plan.route.filters as { states?: string[] }).states ?? [];
    const pols = db.policies.filter((p) => (db.policyCodes[p.id] ?? []).some((c) => c.code === code) && (!states.length || p.states.includes(states[0]!)));
    yield ev("tool", { name: "find_policies_by_code", args: { code, state: states[0] ?? null, asOf: new Date().toISOString().slice(0, 10) }, result: { count: pols.length } });
    citations = pols.slice(0, 4).map((p, i) => ({ n: i + 1, chunkId: `${p.sourceKey}#codes`, sourceKey: p.sourceKey, title: p.title, sectionKey: "codes", version: p.version, quote: `${code} listed in Group 1`, url: p.url }));
    answer = pols.length
      ? `**${code}** appears in ${pols.length} active document${pols.length > 1 ? "s" : ""}${states.length ? ` applicable in ${states[0]}` : ""}:\n\n${pols.map((p, i) => `- **${p.sourceKey}** — ${p.title} (v${p.version}, ${p.contractors[0]?.name ?? "national"}) [${i + 1}]`).join("\n")}\n\nCoverage criteria live in the LCD; billing rules and covered ICD-10-CM groups live in the related Billing & Coding article.`
      : `I couldn't find an active policy listing **${code}**${states.length ? ` in ${states[0]}` : ""}. Check the code, or widen the state filter.`;
  } else {
    const rows = scoreChunks(db, content, { keys: plan.keys, topK: 6 });
    retrieval = { chunks: rows.map((r) => r.chunk), timings: { understandMs: 41, retrieveMs: 133 + Math.round(Math.random() * 40), rerankMs: 286 + Math.round(Math.random() * 60) } };
    await sleep(420);
    yield ev("retrieval", retrieval as unknown as Record<string, unknown>);
    if (!rows.length || rows[0]!.chunk.score < 0.35) {
      plan.route.abstained = true;
      guardrails.push({ kind: "abstain", message: "Retrieval confidence below threshold after 2 corrective iterations." });
      yield ev("guardrail", guardrails[0]!);
      answer = "I couldn't find enough evidence in the indexed policies to answer that confidently. Try naming the service, code or payer, or check the Policy Library.";
    } else {
      const top = rows.slice(0, 3);
      citations = top.map((r, i) => ({ n: i + 1, chunkId: r.chunk.chunkId, sourceKey: r.chunk.sourceKey, title: r.chunk.title, sectionKey: r.chunk.sectionKey, version: r.chunk.version, quote: r.text, url: null }));
      answer = composeAnswer(plan, content, top.map((r) => r.text), top.map((r) => r.chunk));
    }
  }

  await sleep(240);
  for (const piece of chunkText(answer)) {
    if (signal?.aborted) return;
    yield ev("token", { text: piece });
    await sleep(18 + Math.random() * 28);
  }
  if (citations.length) yield ev("citations", { items: citations });
  const latencyMs = Math.round(performance.now() - t0);
  const usage = { promptTokens: 2400 + Math.round(Math.random() * 1400), completionTokens: Math.round(answer.length / 4), latencyMs, model: plan.kind === "analytics" ? "openai/gpt-oss-20b" : "llama-3.3-70b-versatile", provider: "groq", cached: false };
  const msg: Message = {
    id: nextId("m"),
    conversationId,
    role: "assistant",
    content: answer,
    citations,
    route: plan.route,
    retrieval,
    sql,
    usage,
    feedback: null,
    guardrails,
    createdAt: new Date().toISOString(),
  };
  conv.messages = [...conv.messages, msg];
  saveDB();
  yield ev("done", { messageId: msg.id, usage, latencyMs, cached: false, model: usage.model, provider: usage.provider });
}

function composeAnswer(plan: Plan, q: string, texts: string[], chunks: RetrievalChunk[]) {
  const k = chunks[0]!;
  if (plan.kind === "multihop") {
    return `**Yes — M17.11 (unilateral primary osteoarthritis, right knee) is listed as a covered diagnosis** in the Billing & Coding article A57685 that accompanies LCD **L36575** (Noridian, applicable in Arizona).\n\nTo document medical necessity under L36575 you'll need:\n\n1. Pain or functional disability that interferes with activities of daily living [1]\n2. Radiographic evidence of advanced arthritis (joint-space narrowing, sclerosis, osteophytes or cysts) [1]\n3. At least 12 weeks of unsuccessful non-surgical treatment — unless there's severe deformity or bone-on-bone findings with intractable pain [2]\n4. No active infection at the joint, systemically, or at the surgical site [3]`;
  }
  if (/cpap|adherence/i.test(q)) {
    return `For continued PAP coverage after the first 12 weeks, LCD **L33718** requires a clinical re-evaluation **between day 31 and day 91** documenting that OSA symptoms improved, **and** objective adherence: **≥ 4 hours per night on ≥ 70% of nights during a consecutive 30-day period** in the first three months [1]. Adherence data must be downloaded from the device [2].`;
  }
  if (/conservative|esi|epidural/i.test(q)) {
    return `Under LCD **${k.sourceKey}** (${k.title}, v${k.version}), the patient must have **failed at least 4 weeks of conservative care** — physical therapy, a home exercise program and/or medications — unless conservative care is contraindicated and the contraindication is documented [1]. The pre-procedure record must capture the **duration and outcome** of that care [2], and repeat injections at the same level need **≥ 50% relief or meaningful functional improvement lasting ≥ 3 months** [3].`;
  }
  const lead = texts[0]!.replace(/\.$/, "");
  return `According to **${k.sourceKey}** (${k.title}, v${k.version}): ${lead} [1].${texts[1] ? `\n\nRelated requirement: ${texts[1]!.replace(/\.$/, "")} [2].` : ""}`;
}

/* ── Case evaluation stream ─────────────────────────────────────────────── */
function leaves(node: CriteriaNode, path = "root"): (CriteriaNode & { path: string })[] {
  if (node.children?.length) return node.children.flatMap((c, i) => leaves(c, `${path}.${i}`));
  return [{ ...node, path }];
}

const KW_STOP = new Set(["documented", "documentation", "least", "weeks", "patient", "with", "without", "from", "that", "this", "have", "been", "their", "under", "planned", "recorded"]);

function heuristicJudge(db: DemoDB, caseId: string, leaf: CriteriaNode): Pick<CriterionResult, "verdict" | "confidence" | "rationale" | "evidence"> {
  const docs = db.documents.filter((d) => d.caseId === caseId && !d.quarantined && d.text);
  const kws = (leaf.text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !KW_STOP.has(w));
  let best: { doc: (typeof docs)[number]; sent: string; score: number } | null = null;
  for (const d of docs) {
    for (const sent of d.text!.split(/(?<=[.!?])\s+|\n+/)) {
      const low = sent.toLowerCase();
      const score = kws.filter((k) => low.includes(k.slice(0, 6))).length;
      if (score > (best?.score ?? 0)) best = { doc: d, sent: sent.trim(), score };
    }
  }
  if (leaf.kind === "negative_attestation") {
    const hit = docs.flatMap((d) => d.text!.split(/(?<=[.!?])\s+|\n+/).map((s) => ({ d, s }))).find(({ s }) => /\bno (signs of )?(active )?infection|anticoagul\w* (none|held|managed)|no contraindication/i.test(s));
    if (hit) return { verdict: "MET", confidence: 0.86, rationale: "Explicit attestation found in the chart.", evidence: [{ chunkId: `${hit.d.id}#a`, documentId: hit.d.id, quote: hit.s.trim(), noteDate: hit.d.noteDate }] };
    return { verdict: "INSUFFICIENT", confidence: 0.84, rationale: "Negative attestation required — absence of evidence is not treated as met.", evidence: [] };
  }
  if (best && best.score >= 2) {
    return {
      verdict: "MET",
      confidence: Math.min(0.95, 0.6 + best.score * 0.08),
      rationale: `Chart language addresses this criterion (${best.score} key concepts matched) and was verified verbatim.`,
      evidence: [{ chunkId: `${best.doc.id}#h`, documentId: best.doc.id, quote: best.sent, noteDate: best.doc.noteDate }],
    };
  }
  return { verdict: "INSUFFICIENT", confidence: 0.72, rationale: docs.length ? "No chart passage supports this criterion after corrective retrieval." : "No clinical documents are attached to this case yet.", evidence: [] };
}

async function* unevaluableRun(db: DemoDB, caseId: string, evaluationId: string, matches: PolicyMatch[]): AsyncGenerator<StreamEvent> {
  const c = db.cases.find((x) => x.id === caseId)!;
  yield ev("evaluation.started", { evaluationId, policies: matches, criteriaCount: 0 });
  yield ev("evaluation.phase", { phase: "loading_criteria", message: matches.length ? `${matches[0]!.sourceKey} v${matches[0]!.version} has no approved criteria set.` : "No active policy lists these codes in this jurisdiction." });
  await sleep(450);
  yield ev("evaluation.phase", { phase: "aggregating", message: "Nothing evaluable — readiness stays unknown." });
  const keys = matches.map((m) => m.sourceKey).join(", ") || "none";
  const gaps: Gap[] = [
    {
      criterionId: "policy:criteria",
      title: matches.length ? "No approved criteria for the applicable policy" : "No applicable policy found",
      detail: matches.length ? `Matched policies (${keys}) have no reviewed criteria set yet, so nothing was evaluated.` : "No active LCD, NCD or payer policy lists these service codes for this jurisdiction and date of service.",
      severity: "blocker",
      suggestedFix: matches.length ? "Compile or approve criteria in Knowledge → Criteria review, then re-run the evaluation." : "Check the service codes and state, or upload the payer's medical policy.",
    },
  ];
  yield ev("evaluation.aggregate", { readiness: "unknown", readinessScore: null, tree: { verdict: "INSUFFICIENT", label: "No approved criteria for the applicable policies" } });
  yield ev("evaluation.gaps", { gaps });
  const evaluation: Evaluation = {
    id: evaluationId,
    caseId,
    status: "awaiting_review",
    readiness: "unknown",
    readinessScore: null,
    degraded: true,
    policies: matches,
    tree: { verdict: "INSUFFICIENT", label: "No approved criteria for the applicable policies" },
    criteria: [],
    gaps,
    tokenUsage: { promptTokens: 0, completionTokens: 0 },
    modelInfo: { degradedReasons: ["no_applicable_criteria"] } as unknown as Record<string, string>,
    startedAt: new Date(Date.now() - 1500).toISOString(),
    finishedAt: new Date().toISOString(),
  };
  db.evaluations = db.evaluations.filter((e) => e.id !== evaluationId);
  db.evaluations.push(evaluation);
  c.latestEvaluationId = evaluationId;
  c.readiness = "unknown";
  c.readinessScore = null;
  c.status = "needs_review";
  c.updatedAt = new Date().toISOString();
  addEvent(caseId, "evaluation_completed", { readiness: "unknown", gaps: 1 }, true);
  saveDB();
  yield ev("evaluation.phase", { phase: "review", message: "Awaiting human review" });
  yield ev("evaluation.awaiting_review", { evaluationId });
  yield ev("evaluation.completed", { evaluation });
}

async function* evaluationStream(db: DemoDB, caseId: string, evaluationId: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const c = db.cases.find((x) => x.id === caseId)!;
  const prior = db.evaluations.find((e) => e.id === c.latestEvaluationId);
  yield ev("evaluation.phase", { phase: "resolving", message: "Resolving applicable policy for codes, jurisdiction and date of service…" });
  await sleep(700);
  const matches = resolvePolicies(db, { serviceCodes: c.serviceCodes, dxCodes: c.dxCodes, state: c.state });
  const match = matches.find((m) => db.criteriaSets.some((s) => s.policyVersionId === m.policyVersionId)) ?? matches[0];
  const set = match ? db.criteriaSets.find((s) => s.policyVersionId === match.policyVersionId && s.status === "approved") : undefined;
  if (!match || !set) {
    // Mirrors the API: nothing evaluable → readiness `unknown` with a blocker gap, never a guessed score.
    yield* unevaluableRun(db, caseId, evaluationId, match ? [match] : []);
    return;
  }
  const ls = leaves(set.tree);
  yield ev("evaluation.started", { evaluationId, policies: [match], criteriaCount: ls.length });
  await sleep(500);
  yield ev("evaluation.phase", { phase: "loading_criteria", message: `Loaded ${ls.length} criteria from ${match.sourceKey} v${match.version}${set.status !== "approved" ? " (criteria set pending review)" : ""}.` });
  await sleep(550);
  const docs = db.documents.filter((d) => d.caseId === caseId);
  const quarantined = docs.filter((d) => d.quarantined).length;
  yield ev("evaluation.phase", { phase: "indexing_chart", message: `De-identified and indexed ${docs.length - quarantined} document${docs.length - quarantined === 1 ? "" : "s"}${quarantined ? ` · ${quarantined} quarantined (prompt-injection)` : ""}.` });
  await sleep(650);
  yield ev("evaluation.phase", { phase: "evaluating", message: "Evaluating criteria one at a time with hybrid chart retrieval…" });

  const results: CriterionResult[] = [];
  for (const leaf of ls) {
    if (signal?.aborted) return;
    yield ev("criterion.started", { criterionId: leaf.id, text: leaf.text, treePath: leaf.path });
    await sleep(380 + Math.random() * 280);
    const prev = prior?.criteria.find((r) => r.criterionId === leaf.id);
    const judged = prev && prior?.policies[0]?.policyVersionId === match.policyVersionId
      ? { verdict: prev.verdict, confidence: prev.confidence, rationale: prev.rationale, evidence: prev.evidence }
      : heuristicJudge(db, caseId, leaf);
    if (judged.evidence.length) {
      yield ev("criterion.evidence", { criterionId: leaf.id, evidence: judged.evidence.map((e) => ({ ...e, score: e.score ?? 0.88 })) });
      await sleep(260);
    }
    if (judged.verdict === "INSUFFICIENT") {
      yield ev("criterion.corrective", { criterionId: leaf.id, iteration: 1, reason: "Low evidence score — rewriting query with synonyms and widening lookback window." });
      await sleep(420);
    }
    const r: CriterionResult = {
      id: nextId("cr"),
      criterionId: leaf.id!,
      text: leaf.text ?? "",
      kind: leaf.kind ?? "positive",
      treePath: leaf.path,
      verdict: judged.verdict as Verdict,
      effectiveVerdict: judged.verdict as Verdict,
      confidence: judged.confidence,
      rationale: judged.rationale,
      evidence: judged.evidence,
      policyCitation: { policyVersionId: match.policyVersionId, sectionKey: leaf.sourceSpan?.section ?? "indication", quote: leaf.sourceSpan?.quote ?? "", sourceKey: match.sourceKey },
      verification: { quoteValid: true, entailment: judged.verdict === "MET" ? "entails" : judged.verdict === "NOT_MET" ? "contradicts" : "neutral", judgeModel: "groq/openai/gpt-oss-120b", verifierModel: "gemini/gemini-2.5-flash", iterations: judged.verdict === "INSUFFICIENT" ? 2 : 1 },
      override: null,
    };
    results.push(r);
    yield ev("criterion.verdict", { result: r });
    await sleep(160);
  }

  yield ev("evaluation.phase", { phase: "aggregating", message: "Aggregating with three-valued (Kleene) logic over the criteria tree…" });
  await sleep(450);
  const verdicts = Object.fromEntries(results.map((r) => [r.criterionId, r.effectiveVerdict]));
  const tree = evaluateTree(set.tree, verdicts);
  const met = results.filter((r) => r.effectiveVerdict === "MET").length;
  const readinessScore = Math.round((met / results.length) * 100) / 100;
  const readiness = tree.verdict === "MET" ? "ready" : results.some((r) => r.effectiveVerdict === "NOT_MET") ? "not_supported" : "gaps";
  yield ev("evaluation.aggregate", { readiness, readinessScore, tree });
  await sleep(300);

  yield ev("evaluation.phase", { phase: "drafting_gaps", message: "Drafting actionable gap fixes…" });
  await sleep(400);
  const gaps: Gap[] =
    prior && prior.policies[0]?.policyVersionId === match.policyVersionId && prior.gaps.length
      ? prior.gaps.filter((g) => verdicts[g.criterionId] !== "MET")
      : results
          .filter((r) => r.effectiveVerdict !== "MET" && !(set.tree.op === "OR" && r.effectiveVerdict === "INSUFFICIENT" && tree.verdict === "MET"))
          .map((r) => ({
            criterionId: r.criterionId,
            title: r.kind === "negative_attestation" ? "Attestation needed" : `Missing support: ${r.text}`,
            detail: r.rationale,
            severity: r.effectiveVerdict === "NOT_MET" || r.kind === "negative_attestation" ? ("blocker" as const) : ("major" as const),
            suggestedFix: r.kind === "negative_attestation" ? `Add a signed statement that addresses: ${r.text.toLowerCase()}.` : `Add documentation that explicitly addresses: ${r.text.toLowerCase()}.`,
            policyQuote: r.policyCitation.quote,
          }));
  yield ev("evaluation.gaps", { gaps });

  const evaluation: Evaluation = {
    id: evaluationId,
    caseId,
    status: "awaiting_review",
    readiness,
    readinessScore,
    degraded: false,
    policies: [match],
    tree,
    criteria: results,
    gaps,
    tokenUsage: { promptTokens: 16_000 + results.length * 1_100, completionTokens: 1_900 + results.length * 160 },
    modelInfo: { judge: "groq/openai/gpt-oss-120b", verifier: "gemini/gemini-2.5-flash", embedding: "gemini/gemini-embedding-001", reranker: "cohere/rerank-v3.5" },
    startedAt: new Date(Date.now() - 9000).toISOString(),
    finishedAt: new Date().toISOString(),
  };
  db.evaluations = db.evaluations.filter((e) => e.id !== evaluationId);
  db.evaluations.push(evaluation);
  c.latestEvaluationId = evaluationId;
  c.readiness = readiness;
  c.readinessScore = readinessScore;
  c.status = "needs_review";
  c.policyRefs = [{ policyId: match.policyId, policyVersionId: match.policyVersionId, sourceKey: match.sourceKey, title: match.title, version: match.version }];
  c.updatedAt = new Date().toISOString();
  addEvent(caseId, "evaluation_completed", { readiness, score: readinessScore, gaps: gaps.length }, true);
  appendAudit("case.evaluation.completed", "case", caseId, { readiness, tokens: evaluation.tokenUsage!.promptTokens + evaluation.tokenUsage!.completionTokens });
  notify({ type: "evaluation", title: `Evaluation finished: ${c.number}`, body: `Readiness ${Math.round(readinessScore * 100)}% · ${gaps.length} gap${gaps.length === 1 ? "" : "s"}.`, link: `/cases/${caseId}` });
  saveDB();
  yield ev("evaluation.awaiting_review", { evaluationId });
  yield ev("evaluation.completed", { evaluation });
}

/* ── Letter stream ──────────────────────────────────────────────────────── */
async function* letterStream(db: DemoDB, caseId: string, letterId: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const letter = db.letters.find((l) => l.id === letterId)!;
  const c = db.cases.find((x) => x.id === caseId)!;
  const e = db.evaluations.find((x) => x.id === c.latestEvaluationId);
  yield ev("letter.started", { letterId, kind: letter.kind });
  await sleep(500);
  const met = (e?.criteria ?? []).filter((r) => r.effectiveVerdict === "MET" && r.evidence.length);
  const pol = c.policyRefs[0];
  const citations = met.slice(0, 6).map((r, i) => ({ n: i + 1, label: `${r.criterionId} · ${r.text}`, quote: r.evidence[0]!.quote, source: r.evidence[0]!.documentId }));
  const intro =
    letter.kind === "appeal"
      ? `We respectfully request redetermination of the denial for the ${c.title} (date of service ${c.dateOfService}). The enclosed documentation shows that each coverage indication in ${pol ? `LCD ${pol.sourceKey}` : "the applicable policy"} was met at the time of service.`
      : letter.kind === "peer_to_peer_prep"
        ? `Talking points for the peer-to-peer discussion on the ${c.title}.`
        : `I am requesting prior authorization for a ${c.title} (${c.serviceCodes.join(", ")}) for my patient, diagnosed with ${c.dxCodes.join(", ")}.`;
  const body = met.length
    ? met.slice(0, 6).map((r, i) => `**${r.text}.** ${r.evidence[0]!.quote.replace(/\.$/, "")} [${i + 1}].`).join("\n\n")
    : "_No criteria are currently supported by verified chart evidence. Resolve the gaps on the Criteria tab before drafting._";
  const openGaps = (e?.gaps ?? []).length;
  const content = `**Re:** ${c.title} — ${c.payerName}  \n**Patient:** [PATIENT_NAME] · DOB [DOB] · Member ID [MEMBER_ID]  \n**Date of service:** ${c.dateOfService}\n\nTo the Medical Review Department,\n\n${intro}\n\n${body}\n\n${pol ? `The patient meets the documented coverage indications of ${pol.sourceKey} (${pol.title}, v${pol.version}).` : ""}${openGaps ? `\n\n> ⚠︎ ${openGaps} open gap${openGaps > 1 ? "s" : ""} remain on this case. Resolve before sending.` : ""}\n\nSincerely,\n\n[TREATING_CLINICIAN]`;
  let acc = "";
  for (const piece of chunkText(content)) {
    if (signal?.aborted) return;
    acc += piece;
    yield ev("letter.token", { letterId, text: piece });
    await sleep(14 + Math.random() * 20);
  }
  letter.contentMd = acc;
  letter.citations = citations;
  letter.updatedAt = new Date().toISOString();
  saveDB();
  yield ev("letter.completed", { letter });
}

/* ── Dispatcher ─────────────────────────────────────────────────────────── */
export async function* demoStream(method: string, path: string, body: unknown, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const db = getDB();
  const p = path.split("?")[0]!;
  let m = p.match(/^\/assistant\/conversations\/([^/]+)\/messages$/);
  if (method === "POST" && m) {
    yield* assistantStream(db, m[1]!, String((body as { content?: string })?.content ?? ""), signal);
    return;
  }
  m = p.match(/^\/cases\/([^/]+)\/events$/);
  if (m) {
    const caseId = m[1]!;
    const pending = db.pending.filter((x) => x.caseId === caseId);
    db.pending = db.pending.filter((x) => x.caseId !== caseId);
    saveDB();
    for (const job of pending) {
      if (job.kind === "evaluation") yield* evaluationStream(db, caseId, job.id, signal);
      if (job.kind === "letter") yield* letterStream(db, caseId, job.id, signal);
    }
    return;
  }
  m = p.match(/^\/jobs\/([^/]+)\/events$/);
  if (m) {
    for (let i = 1; i <= 5; i++) {
      await sleep(500);
      yield ev("progress", { progress: i / 5, message: ["Fetching", "Parsing", "Chunking", "Embedding", "Validating"][i - 1] });
    }
    yield ev("completed", { result: { ok: true } });
  }
}
