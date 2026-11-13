"use client";

import { BadgeCheck, BookOpenCheck, ChevronRight, FileSearch, Gavel, Pencil, Play, Quote, RotateCcw, ShieldCheck, Sparkles, Undo2, UserCheck, UserPen } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useCompleteReview, useOverrideCriterion } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import type { CriterionResult, Evaluation, TreeResult, Verdict } from "@/lib/api/types";
import { fmtDate, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RadioCards } from "@/components/ui/controls";
import { Avatar, Badge, Card } from "@/components/ui/display";
import { Callout, EmptyState } from "@/components/ui/empty";
import { Field, Textarea } from "@/components/ui/input";
import { Collapse } from "@/components/ui/motion";
import { Dialog, DialogContent, DialogFooter, Tooltip } from "@/components/ui/overlays";
import { AiBadge, ConfidencePill, DecisionDisclaimer, Provenance, ReviewBadge, WhyButton } from "@/components/domain/trust";
import { DocTypeBadge, VerdictBadge, VerdictIcon, VERDICT_META } from "@/components/domain/verdict";
import { LiveEvaluationView } from "./eval-live";
import type { LiveEvaluation } from "./use-case-stream";

const KIND_LABEL: Record<CriterionResult["kind"], string> = {
  positive: "Clinical",
  negative_attestation: "Attestation",
  documentation: "Documentation",
  temporal: "Duration",
  numeric: "Measure",
};

/** The backend nests model ids under `models` and reports degradation reasons; the demo uses flat keys. */
export function evaluationModels(ev?: Evaluation): { judge?: string; verifier?: string; degradedReasons: string[] } {
  const info = (ev?.modelInfo ?? {}) as Record<string, unknown>;
  const models = (info.models ?? {}) as Record<string, string>;
  const reasons = Array.isArray(info.degradedReasons) ? (info.degradedReasons as string[]) : [];
  return { judge: (info.judge as string) ?? models.judge, verifier: (info.verifier as string) ?? models.verifier, degradedReasons: reasons };
}

const DEGRADED_COPY: Record<string, string> = {
  llm_unavailable: "no model provider was reachable",
  budget_exhausted: "the token budget for this case ran out",
  no_applicable_criteria: "no approved criteria matched the resolved policy",
  rerank: "the reranker was unavailable",
  dense: "dense retrieval was unavailable",
};

type Provenance = { state: "ai" | "reviewed" | "overridden"; by?: string };
function provenanceOf(r: CriterionResult, ev: Evaluation): Provenance {
  if (r.override) return { state: "overridden", by: r.override.by.fullName };
  if (ev.status === "completed") return { state: "reviewed" };
  return { state: "ai" };
}

function ProvenanceIcon({ p }: { p: Provenance }) {
  const meta =
    p.state === "overridden"
      ? { icon: <UserPen className="size-3.5 text-brand" />, label: `Human override by ${p.by}` }
      : p.state === "reviewed"
        ? { icon: <UserCheck className="size-3.5 text-met" />, label: "Confirmed at clinical review" }
        : { icon: <Sparkles className="size-3.5 text-ai-2" />, label: "AI-suggested · awaiting review" };
  return (
    <Tooltip content={meta.label}>
      <span className="inline-flex size-5 items-center justify-center rounded-md hover:bg-surface-2" aria-label={meta.label}>
        {meta.icon}
      </span>
    </Tooltip>
  );
}

function OverrideDialog({ result, caseId, evalId, open, onOpenChange }: { result: CriterionResult; caseId: string; evalId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [verdict, setVerdict] = useState<Verdict>(result.override?.verdict ?? (result.verdict === "MET" ? "INSUFFICIENT" : "MET"));
  const [reason, setReason] = useState(result.override?.reason ?? "");
  const m = useOverrideCriterion(caseId, evalId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Override ${result.criterionId}`} description={result.text}>
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[13px]">
            <AiBadge label="AI verdict" />
            <VerdictBadge verdict={result.verdict} />
            <ConfidencePill value={result.confidence} />
          </div>
          <Field label="Your verdict">
            <RadioCards
              columns={3}
              value={verdict}
              onValueChange={(v) => setVerdict(v as Verdict)}
              options={(Object.keys(VERDICT_META) as Verdict[]).map((v) => ({ value: v, label: VERDICT_META[v].short, icon: <VerdictIcon verdict={v} /> }))}
            />
          </Field>
          <Field label="Clinical rationale" hint="Required (8+ characters). Saved to the audit log and used to improve future evaluations.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Verbal attestation captured at pre-op call; signed form uploaded 11/14." autoFocus />
          </Field>
        </div>
        <DialogFooter>
          {result.override ? (
            <Button
              variant="ghost"
              className="mr-auto"
              onClick={() => m.mutate({ resultId: result.id, overrideVerdict: null, overrideReason: "" }, { onSuccess: () => onOpenChange(false) })}
            >
              <Undo2 /> Revert to AI verdict
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} disabled={reason.trim().length < 8} onClick={() => m.mutate({ resultId: result.id, overrideVerdict: verdict, overrideReason: reason }, { onSuccess: () => onOpenChange(false) })}>
            Save override
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WhyContent({ r }: { r: CriterionResult }) {
  return (
    <>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Policy requires</p>
        <p className="mt-1 text-fg">
          <mark className="mark-policy">“{r.policyCitation.quote}”</mark>
        </p>
        <Provenance source={r.policyCitation.sourceKey} detail={r.policyCitation.sectionKey.replace(/_/g, " ")} />
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Chart shows</p>
        {r.evidence.length ? (
          r.evidence.slice(0, 2).map((e) => (
            <div key={e.chunkId} className="mt-1">
              <p className="text-fg">
                <mark className="mark-evidence">“{e.quote}”</mark>
              </p>
              <Provenance source={e.noteDate ? fmtDate(e.noteDate, "MM/dd/yyyy") : "undated note"} verified={r.verification.quoteValid} />
            </div>
          ))
        ) : (
          <p className="mt-1 text-insufficient-fg">No supporting passage found{r.kind === "negative_attestation" ? " — attestations must be explicit; silence isn't evidence" : ""}.</p>
        )}
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Reasoning</p>
        <p className="mt-1">{r.rationale}</p>
      </div>
    </>
  );
}

function CriterionRow({ r, ev, caseId, onJump, canReview }: { r: CriterionResult; ev: Evaluation; caseId: string; onJump: (criterionId: string) => void; canReview: boolean }) {
  const [open, setOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const prov = provenanceOf(r, ev);
  const models = evaluationModels(ev);
  return (
    <div className={cn("min-w-0 rounded-lg border bg-surface transition-[border-color,box-shadow] duration-200", open ? "border-border-strong shadow-e1" : "border-border hover:border-border-strong", r.effectiveVerdict !== "MET" && !open && "bg-surface")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}
        className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-brand/30 sm:gap-3"
      >
        <ChevronRight className={cn("size-4 shrink-0 text-subtle transition-transform duration-200", open && "rotate-90")} />
        <VerdictIcon verdict={r.effectiveVerdict} />
        <span className="font-mono text-[11px] text-subtle">{r.criterionId.split(":").pop()}</span>
        <span className="min-w-0 flex-1 text-[13px] leading-5 text-fg">{r.text}</span>
        <Badge tone="outline" size="xs" className="hidden lg:inline-flex">
          {KIND_LABEL[r.kind]}
        </Badge>
        <span className="hidden items-center gap-1 text-xs text-subtle sm:inline-flex" title={`${r.evidence.length} evidence passage${r.evidence.length === 1 ? "" : "s"}`}>
          <FileSearch className="size-3.5" />
          {r.evidence.length}
        </span>
        <span className="hidden md:inline-flex" onClick={(e) => e.stopPropagation()}>
          <ConfidencePill value={r.confidence} showNumber={false} />
        </span>
        <span className="hidden items-center sm:inline-flex" onClick={(e) => e.stopPropagation()}>
          <ProvenanceIcon p={prov} />
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <WhyButton title={`Why ${VERDICT_META[r.effectiveVerdict].short.toLowerCase()}?`}>
            <WhyContent r={r} />
          </WhyButton>
        </span>
        <VerdictBadge verdict={r.effectiveVerdict} overridden={!!r.override} short />
      </div>
      <Collapse open={open}>
        <div className="grid gap-4 border-t border-border px-4 py-4 lg:grid-cols-[1.3fr_1fr]">
          <div className="grid content-start gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {prov.state === "ai" ? <AiBadge /> : <ReviewBadge state={prov.state === "overridden" ? "overridden" : "reviewed"} by={prov.by} />}
              <ConfidencePill value={r.confidence} />
              <Badge tone="outline" size="xs">
                {KIND_LABEL[r.kind]}
              </Badge>
            </div>
            <p className="text-[13px] leading-relaxed text-fg">{r.rationale}</p>
            {r.override ? (
              <div className="flex items-start gap-2 rounded-md bg-brand-soft/50 p-2.5 text-[13px]">
                <Avatar name={r.override.by.fullName} color={r.override.by.avatarColor} size={20} />
                <span>
                  <span className="font-medium text-fg">{r.override.by.fullName}</span> <span className="text-muted">changed the AI verdict</span> <VerdictBadge verdict={r.verdict} size="xs" short /> <span className="text-muted">→</span>{" "}
                  <VerdictBadge verdict={r.override.verdict} size="xs" short />
                  <span className="mt-1 block text-muted">“{r.override.reason}” · {fmtRelative(r.override.at)}</span>
                </span>
              </div>
            ) : null}
            <div className="grid gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Chart evidence</p>
              {r.evidence.length === 0 ? (
                <p className="rounded-md border border-dashed border-border-strong px-3 py-2.5 text-[13px] text-muted">
                  No passage in the chart supports this criterion.
                  {r.kind === "negative_attestation" ? " Negative criteria need an explicit attestation — silence isn't evidence." : ""}
                </p>
              ) : (
                r.evidence.map((e) => (
                  <button key={e.chunkId} onClick={() => onJump(r.criterionId)} className="group grid gap-1 rounded-md bg-surface-2/70 p-2.5 text-left text-[13px] transition-colors hover:bg-surface-2">
                    <span className="flex gap-2">
                      <Quote className="mt-0.5 size-3.5 shrink-0 text-subtle" />
                      <span className="text-fg">{e.quote}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 pl-5 text-xs text-subtle">
                      {e.noteDate ? fmtDate(e.noteDate) : "undated"}
                      <span className="inline-flex items-center gap-0.5 text-met-fg">
                        · <ShieldCheck className="size-3" /> verbatim
                      </span>
                      · <span className="text-brand-fg group-hover:underline">View in chart</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="grid content-start gap-3">
            <div className="grid gap-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Policy language</p>
              <div className="rounded-md border-l-2 border-brand bg-brand-soft/30 px-3 py-2 text-[13px] text-fg">
                “{r.policyCitation.quote}”
                <Provenance className="mt-1" source={r.policyCitation.sourceKey} detail={r.policyCitation.sectionKey.replace(/_/g, " ")} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Verification</p>
              <ul className="grid gap-1 text-[13px]">
                <li className={cn("flex items-center gap-2", r.verification.quoteValid ? "text-met-fg" : "text-notmet-fg")}>
                  <BadgeCheck className="size-3.5" /> {r.verification.quoteValid ? "Every quote found verbatim in its source" : "Quote not found verbatim — verdict downgraded"}
                </li>
                {r.verification.entailment ? (
                  <li className={cn("flex items-center gap-2", r.verification.entailment === "entails" ? "text-met-fg" : r.verification.entailment === "contradicts" ? "text-notmet-fg" : "text-muted")}>
                    <ShieldCheck className="size-3.5" /> Cross-model check: evidence {r.verification.entailment}
                  </li>
                ) : (
                  <li className="flex items-center gap-2 text-muted">
                    <ShieldCheck className="size-3.5" /> Cross-model check not run (deterministic rule)
                  </li>
                )}
                {r.verification.iterations && r.verification.iterations > 1 ? (
                  <li className="flex items-center gap-2 text-info">
                    <RotateCcw className="size-3.5" /> {r.verification.iterations - 1} corrective retrieval pass{r.verification.iterations > 2 ? "es" : ""}
                  </li>
                ) : null}
              </ul>
              <p className="text-xs text-subtle">
                Judge {r.verification.judgeModel ?? models.judge ?? "—"} · verifier {r.verification.verifierModel ?? models.verifier ?? "—"}
              </p>
            </div>
            {canReview ? (
              <Button size="sm" variant="secondary" className="w-fit" onClick={() => setOverrideOpen(true)}>
                <Pencil /> {r.override ? "Edit override" : "Override verdict"}
              </Button>
            ) : null}
          </div>
        </div>
      </Collapse>
      {overrideOpen ? <OverrideDialog result={r} caseId={caseId} evalId={ev.id} open={overrideOpen} onOpenChange={setOverrideOpen} /> : null}
    </div>
  );
}

const OP_LABEL = (t: TreeResult) => (t.op === "OR" ? "Any one of" : t.op === "N_OF_M" ? `At least ${t.n ?? 1} of` : "All of the following");
const OP_JOIN = (t: TreeResult) => (t.op === "OR" ? "or" : t.op === "N_OF_M" ? "of" : "and");

function TreeNode({ node, results, depth, ...rest }: { node: TreeResult; results: Map<string, CriterionResult>; depth: number; ev: Evaluation; caseId: string; onJump: (id: string) => void; canReview: boolean }) {
  if (!node.children?.length) {
    const r = node.criterionId ? results.get(node.criterionId) : undefined;
    return r ? <CriterionRow r={r} {...rest} /> : null;
  }
  const children = node.children.filter((c) => c.children?.length || (c.criterionId && results.has(c.criterionId)));
  return (
    <div className={cn("grid min-w-0 grid-cols-1 gap-2", depth > 0 && "rounded-lg border border-dashed border-border-strong bg-surface-2/30 p-2.5")}>
      <div className="flex items-center gap-2 px-1">
        <span className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-wider text-muted">{node.op === "N_OF_M" ? `${node.n ?? 1}-of-${children.length}` : node.op ?? "AND"}</span>
        <span className="text-xs font-medium text-muted">{node.label && depth === 0 ? node.label : OP_LABEL(node)}</span>
        <VerdictBadge verdict={node.verdict} size="xs" short />
      </div>
      <div className="relative grid min-w-0 grid-cols-1 gap-2 pl-4">
        <span aria-hidden className="absolute bottom-3 left-[7px] top-3 w-px bg-border-strong" />
        {children.map((c, i) => (
          <div key={c.criterionId ?? `g${depth}-${i}`} className="relative min-w-0">
            <span aria-hidden className="absolute -left-[9px] top-[18px] h-px w-[9px] bg-border-strong" />
            {i > 0 ? (
              <span aria-hidden className="absolute left-[-9px] top-[-4px] z-[1] -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface-2 px-1 font-mono text-[9px] font-semibold uppercase leading-[14px] text-subtle ring-1 ring-border">
                {OP_JOIN(node)}
              </span>
            ) : null}
            <TreeNode node={c} results={results} depth={depth + 1} {...rest} />
          </div>
        ))}
      </div>
    </div>
  );
}

function CompleteReviewDialog({ ev, caseId, open, onOpenChange }: { ev: Evaluation; caseId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const complete = useCompleteReview(caseId);
  const counts = { MET: 0, NOT_MET: 0, INSUFFICIENT: 0 } as Record<Verdict, number>;
  ev.criteria.forEach((r) => (counts[r.effectiveVerdict] += 1));
  const overrides = ev.criteria.filter((r) => r.override).length;
  const unresolved = counts.INSUFFICIENT + counts.NOT_MET;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Complete clinical review" description="Your sign-off is recorded in the audit trail with every verdict as it stands now." size="sm">
        <div className="grid gap-3 text-[13px]">
          <ul className="grid gap-1.5 rounded-lg bg-surface-2 p-3">
            {(["MET", "INSUFFICIENT", "NOT_MET"] as Verdict[]).map((v) => (
              <li key={v} className="flex items-center gap-2">
                <VerdictIcon verdict={v} />
                <span className="flex-1 text-fg">{VERDICT_META[v].label}</span>
                <span className="tabular font-medium">{counts[v]}</span>
              </li>
            ))}
            <li className="flex items-center gap-2 border-t border-border pt-1.5">
              <UserPen className="size-4 text-brand" />
              <span className="flex-1 text-fg">Human overrides</span>
              <span className="tabular font-medium">{overrides}</span>
            </li>
          </ul>
          {unresolved ? (
            <Callout tone="warning" title={`${unresolved} criteri${unresolved === 1 ? "on is" : "a are"} not met or lack evidence`}>
              The case will stay in <b>Needs review</b> with open gaps. Close them first if you intend to submit.
            </Callout>
          ) : (
            <Callout tone="success" title="Every criterion is documented">
              The case moves to <b>Ready to submit</b>.
            </Callout>
          )}
          <DecisionDisclaimer />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={complete.isPending} onClick={() => complete.mutate(ev.id, { onSuccess: () => onOpenChange(false) })}>
            <BadgeCheck /> Sign off review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CriteriaPanel({
  caseId,
  evaluation,
  live,
  onEvaluate,
  onJump,
  canEvaluate,
}: {
  caseId: string;
  evaluation?: Evaluation;
  live: LiveEvaluation;
  onEvaluate: () => void;
  onJump: (criterionId: string) => void;
  canEvaluate: boolean;
}) {
  const { can } = useSession();
  const [reviewOpen, setReviewOpen] = useState(false);

  if (live.running || (live.criteria.length && !evaluation)) return <LiveEvaluationView live={live} />;

  if (!evaluation) {
    return (
      <Card>
        <EmptyState
          art="spark"
          title={live.error ? "The last evaluation didn't finish" : "No evaluation yet"}
          description={live.error ?? "Necessa resolves the applicable policy version, then checks each criterion against the de-identified chart — every verdict cites both."}
          action={
            canEvaluate ? (
              <Button variant="ai" onClick={onEvaluate}>
                <Play /> Run medical-necessity check
              </Button>
            ) : null
          }
        />
      </Card>
    );
  }

  const models = evaluationModels(evaluation);
  const policy = evaluation.policies[0];
  const canReview = can("cases:review");
  const degradedBanner = evaluation.degraded ? (
    <Callout tone="warning" title="LLM unavailable — deterministic checks only">
      {models.degradedReasons.length ? `This run was limited because ${models.degradedReasons.map((r) => DEGRADED_COPY[r] ?? r.replace(/_/g, " ")).join(", ")}. ` : ""}
      Criteria the rules can&apos;t decide are marked <b>Insufficient</b> rather than guessed. Re-run when a model is available.
    </Callout>
  ) : null;

  // Nothing could be evaluated (e.g. the applicable policy has no approved criteria yet).
  if (evaluation.criteria.length === 0) {
    const gap = evaluation.gaps[0];
    return (
      <div className="grid gap-3">
        <Card className="p-5">
          <div className="flex flex-wrap items-start gap-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-insufficient-soft text-insufficient">
              <BookOpenCheck className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[15px] font-semibold text-fg">{gap?.title ?? "No approved criteria for the applicable policy"}</h3>
                <Badge tone="notmet" size="xs">
                  Blocker
                </Badge>
                <Badge tone="neutral" size="xs">
                  Readiness unknown
                </Badge>
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{gap?.detail ?? "The matched policy has no reviewed criteria set yet, so nothing was evaluated."}</p>
              <p className="mt-2 text-[13px] text-fg">
                <span className="font-medium">Next step: </span>
                {gap?.suggestedFix ?? "Compile or approve criteria in Knowledge → Criteria review, then re-run the evaluation."}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {can("criteria:review") ? (
                  <Button asChild variant="primary" size="sm">
                    <Link href="/knowledge?tab=criteria">
                      <BookOpenCheck /> Open criteria review
                    </Link>
                  </Button>
                ) : null}
                {canEvaluate ? (
                  <Button size="sm" variant="secondary" onClick={onEvaluate}>
                    <RotateCcw /> Re-run evaluation
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </Card>
        {degradedBanner}
        <DecisionDisclaimer className="px-1" />
      </div>
    );
  }

  const results = new Map(evaluation.criteria.map((r) => [r.criterionId, r]));
  const counts = { MET: 0, NOT_MET: 0, INSUFFICIENT: 0 } as Record<Verdict, number>;
  evaluation.criteria.forEach((r) => (counts[r.effectiveVerdict] += 1));
  const overrides = evaluation.criteria.filter((r) => r.override).length;

  return (
    <div className="grid grid-cols-1 gap-4">
      {policy ? (
        <div className="grid min-w-0 gap-2 rounded-xl bg-surface px-4 py-3 shadow-e1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="flex min-w-0 items-center gap-2 text-[13px]">
              <DocTypeBadge docType={policy.docType} />
              <Link href={policy.policyId ? `/policies/${policy.policyId}` : "/policies"} className="font-mono font-medium text-fg hover:underline">
                {policy.sourceKey}
              </Link>
              <span className="text-muted">v{policy.version}</span>
              <span className="hidden min-w-0 truncate text-muted lg:inline">· {policy.title}</span>
            </span>
            <span className="ml-auto flex items-center gap-3 text-xs text-muted">
              {(["MET", "INSUFFICIENT", "NOT_MET"] as Verdict[]).map((v) => (
                <span key={v} className="tabular flex items-center gap-1" title={VERDICT_META[v].label}>
                  <VerdictIcon verdict={v} className="size-3.5" /> {counts[v]}
                </span>
              ))}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
            <span>
              {policy.contractor?.name ?? "National coverage"} · effective {fmtDate(policy.effectiveFrom)}
            </span>
            {policy.criteriaSetStatus && policy.criteriaSetStatus !== "approved" ? (
              <Tooltip content="This criteria set hasn't been approved by a reviewer yet — treat verdicts as preliminary.">
                <Badge tone="insufficient" size="xs">
                  Criteria pending review
                </Badge>
              </Tooltip>
            ) : (
              <Badge tone="met" size="xs">
                <BadgeCheck /> Reviewed criteria
              </Badge>
            )}
            {evaluation.status === "completed" ? <ReviewBadge state="reviewed" /> : <ReviewBadge state="pending" />}
            {overrides ? <ReviewBadge state="overridden" by={`${overrides} override${overrides === 1 ? "" : "s"}`} /> : null}
            {evaluation.degraded ? (
              <Badge tone="degraded" size="xs">
                Degraded mode
              </Badge>
            ) : null}
          </div>
        </div>
      ) : null}

      {degradedBanner}

      {evaluation.tree?.children?.length ? (
        <TreeNode node={evaluation.tree} results={results} depth={0} ev={evaluation} caseId={caseId} onJump={onJump} canReview={canReview} />
      ) : (
        <div className="grid gap-2">
          {evaluation.criteria.map((r) => (
            <CriterionRow key={r.id} r={r} ev={evaluation} caseId={caseId} onJump={onJump} canReview={canReview} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border-strong px-4 py-3">
        <p className="flex max-w-xl items-start gap-2 text-xs leading-relaxed text-muted">
          <Gavel className="mt-0.5 size-3.5 shrink-0" />
          Necessa reports documentation readiness only — it never approves or denies. A licensed clinician makes the medical-necessity determination.
        </p>
        <div className="flex gap-2">
          {canEvaluate ? (
            <Button size="sm" variant="ghost" onClick={onEvaluate}>
              <RotateCcw /> Re-run
            </Button>
          ) : null}
          {evaluation.status === "awaiting_review" && canReview ? (
            <Button size="sm" variant="primary" onClick={() => setReviewOpen(true)}>
              <BadgeCheck /> Complete review
            </Button>
          ) : evaluation.status === "completed" ? (
            <Badge tone="met">
              <BadgeCheck /> Review signed off
            </Badge>
          ) : null}
        </div>
      </div>
      {reviewOpen ? <CompleteReviewDialog ev={evaluation} caseId={caseId} open={reviewOpen} onOpenChange={setReviewOpen} /> : null}
    </div>
  );
}
