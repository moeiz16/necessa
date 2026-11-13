"use client";

import { BadgeCheck, ChevronRight, CircleHelp, FileSearch, Gavel, Layers, Pencil, Play, Quote, RotateCcw, ShieldCheck, Sparkles, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useCompleteReview, useOverrideCriterion } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import type { CriterionResult, Evaluation, TreeResult, Verdict } from "@/lib/api/types";
import { fmtDate, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { RadioCards } from "@/components/ui/controls";
import { Avatar, Badge, Card, Progress } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Field, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/overlays";
import { ConfidenceMeter, DocTypeBadge, VerdictBadge, VerdictIcon, VERDICT_META } from "@/components/domain/verdict";
import type { LiveEvaluation } from "./use-case-stream";

const KIND_LABEL: Record<CriterionResult["kind"], string> = {
  positive: "Clinical",
  negative_attestation: "Attestation",
  documentation: "Documentation",
  temporal: "Duration",
  numeric: "Measure",
};

function OverrideDialog({ result, caseId, evalId, open, onOpenChange }: { result: CriterionResult; caseId: string; evalId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [verdict, setVerdict] = useState<Verdict>(result.override?.verdict ?? (result.verdict === "MET" ? "INSUFFICIENT" : "MET"));
  const [reason, setReason] = useState(result.override?.reason ?? "");
  const m = useOverrideCriterion(caseId, evalId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Override ${result.criterionId}`} description={result.text}>
        <div className="grid gap-4">
          <div className="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[13px]">
            <span className="text-muted">AI verdict</span>
            <VerdictBadge verdict={result.verdict} />
            <span className="text-xs text-subtle">· confidence {Math.round(result.confidence * 100)}%</span>
          </div>
          <Field label="Your verdict">
            <RadioCards
              columns={3}
              value={verdict}
              onValueChange={(v) => setVerdict(v as Verdict)}
              options={(Object.keys(VERDICT_META) as Verdict[]).map((v) => ({ value: v, label: VERDICT_META[v].short, icon: <VerdictIcon verdict={v} /> }))}
            />
          </Field>
          <Field label="Reason" hint="Required. Recorded in the audit log and used to improve evaluations.">
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

function WhyPopover({ r }: { r: CriterionResult }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="inline-flex items-center gap-1 rounded-sm px-1 text-xs text-muted hover:text-fg" onClick={(e) => e.stopPropagation()}>
          <CircleHelp className="size-3.5" /> Why?
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(420px,calc(100vw-2rem))]" align="end" onClick={(e) => e.stopPropagation()}>
        <p className="text-xs font-medium uppercase tracking-wider text-subtle">Policy requires</p>
        <p className="mt-1 text-[13px] text-fg">
          <mark className="mark-policy">“{r.policyCitation.quote}”</mark>
          <span className="ml-1 text-xs text-subtle">
            {r.policyCitation.sourceKey} · {r.policyCitation.sectionKey.replace(/_/g, " ")}
          </span>
        </p>
        <p className="mt-3 text-xs font-medium uppercase tracking-wider text-subtle">Chart shows</p>
        {r.evidence.length ? (
          r.evidence.slice(0, 2).map((e) => (
            <p key={e.chunkId} className="mt-1 text-[13px] text-fg">
              <mark className="mark-evidence">“{e.quote}”</mark>
              {e.noteDate ? <span className="ml-1 text-xs text-subtle">{fmtDate(e.noteDate, "MM/dd/yyyy")}</span> : null}
            </p>
          ))
        ) : (
          <p className="mt-1 text-[13px] text-insufficient-fg">No supporting passage found{r.kind === "negative_attestation" ? " — attestations must be explicit" : ""}.</p>
        )}
        <p className="mt-3 text-xs font-medium uppercase tracking-wider text-subtle">So</p>
        <p className="mt-1 text-[13px] text-muted">{r.rationale}</p>
      </PopoverContent>
    </Popover>
  );
}

function CriterionRow({ r, caseId, evalId, onJump, canReview }: { r: CriterionResult; caseId: string; evalId: string; onJump: (criterionId: string) => void; canReview: boolean }) {
  const [open, setOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  return (
    <div className={cn("rounded-lg border bg-surface transition-colors", open ? "border-border-strong shadow-e1" : "border-border hover:border-border-strong")}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}
        className="flex cursor-pointer items-center gap-3 px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
      >
        <ChevronRight className={cn("size-4 shrink-0 text-subtle transition-transform", open && "rotate-90")} />
        <VerdictIcon verdict={r.effectiveVerdict} />
        <span className="font-mono text-[11px] text-subtle">{r.criterionId}</span>
        <span className="min-w-0 flex-1 text-[13px] text-fg">{r.text}</span>
        <Badge tone="outline" size="xs" className="hidden md:inline-flex">
          {KIND_LABEL[r.kind]}
        </Badge>
        <span className="hidden items-center gap-1 text-xs text-subtle sm:inline-flex">
          <FileSearch className="size-3.5" />
          {r.evidence.length}
        </span>
        <span className="hidden sm:inline-flex">
          <ConfidenceMeter value={r.confidence} />
        </span>
        <WhyPopover r={r} />
        <VerdictBadge verdict={r.effectiveVerdict} overridden={!!r.override} short />
      </div>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="grid gap-4 border-t border-border px-4 py-4 lg:grid-cols-[1.3fr_1fr]">
              <div className="grid content-start gap-3">
                <p className="text-[13px] leading-relaxed text-fg">{r.rationale}</p>
                {r.override ? (
                  <div className="flex items-start gap-2 rounded-md bg-brand-soft/50 p-2.5 text-[13px]">
                    <Avatar name={r.override.by.fullName} color={r.override.by.avatarColor} size={20} />
                    <span>
                      <span className="font-medium text-fg">{r.override.by.fullName}</span> <span className="text-muted">overrode to</span> <VerdictBadge verdict={r.override.verdict} size="xs" short />
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
                      <button key={e.chunkId} onClick={() => onJump(r.criterionId)} className="group flex gap-2 rounded-md bg-surface-2/70 p-2.5 text-left text-[13px] transition-colors hover:bg-surface-2">
                        <Quote className="mt-0.5 size-3.5 shrink-0 text-subtle" />
                        <span className="min-w-0 flex-1">
                          <span className="text-fg">{e.quote}</span>
                          <span className="mt-1 flex items-center gap-1.5 text-xs text-subtle">
                            {e.noteDate ? fmtDate(e.noteDate) : "undated"} · <span className="text-brand group-hover:underline">View in chart</span>
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
              <div className="grid content-start gap-3">
                <div className="grid gap-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Policy language</p>
                  <p className="rounded-md border-l-2 border-brand bg-brand-soft/30 px-3 py-2 text-[13px] text-fg">
                    “{r.policyCitation.quote}”
                    <span className="mt-1 block text-xs text-muted">
                      {r.policyCitation.sourceKey} · {r.policyCitation.sectionKey.replace(/_/g, " ")}
                    </span>
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Verification</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone={r.verification.quoteValid ? "met" : "notmet"} size="xs">
                      <BadgeCheck /> {r.verification.quoteValid ? "Quotes verified verbatim" : "Quote mismatch"}
                    </Badge>
                    {r.verification.entailment ? (
                      <Badge tone={r.verification.entailment === "entails" ? "met" : r.verification.entailment === "contradicts" ? "notmet" : "neutral"} size="xs">
                        <ShieldCheck /> Entailment: {r.verification.entailment}
                      </Badge>
                    ) : null}
                    {r.verification.iterations && r.verification.iterations > 1 ? (
                      <Badge tone="info" size="xs">
                        <RotateCcw /> {r.verification.iterations - 1} corrective pass
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-subtle">
                    Judge {r.verification.judgeModel ?? "—"} · verifier {r.verification.verifierModel ?? "—"}
                  </p>
                </div>
                {canReview ? (
                  <Button size="sm" variant="secondary" className="w-fit" onClick={() => setOverrideOpen(true)}>
                    <Pencil /> {r.override ? "Edit override" : "Override verdict"}
                  </Button>
                ) : null}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {overrideOpen ? <OverrideDialog result={r} caseId={caseId} evalId={evalId} open={overrideOpen} onOpenChange={setOverrideOpen} /> : null}
    </div>
  );
}

const OP_LABEL = (t: TreeResult) => (t.op === "OR" ? "Any one of" : t.op === "N_OF_M" ? `At least ${t.n ?? 1} of` : "All of the following");

function TreeNode({ node, results, depth, ...rest }: { node: TreeResult; results: Map<string, CriterionResult>; depth: number; caseId: string; evalId: string; onJump: (id: string) => void; canReview: boolean }) {
  if (!node.children?.length) {
    const r = node.criterionId ? results.get(node.criterionId) : undefined;
    return r ? <CriterionRow r={r} {...rest} /> : null;
  }
  return (
    <div className={cn("grid gap-2", depth > 0 && "rounded-lg border border-dashed border-border-strong bg-surface-2/30 p-2.5")}>
      <div className="flex items-center gap-2 px-1">
        <Layers className="size-3.5 text-subtle" />
        <span className="text-xs font-medium text-muted">{OP_LABEL(node)}</span>
        <VerdictBadge verdict={node.verdict} size="xs" short />
      </div>
      {node.children.map((c, i) => (
        <TreeNode key={c.criterionId ?? `g${depth}-${i}`} node={c} results={results} depth={depth + 1} {...rest} />
      ))}
    </div>
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
  const complete = useCompleteReview(caseId);

  if (live.running || (live.criteria.length && !evaluation)) {
    const done = live.criteria.filter((c) => c.state === "done").length;
    const total = live.criteriaCount || Math.max(live.criteria.length, 1);
    const policy = live.policies[0];
    return (
      <div className="grid gap-4">
        <Card className="ai-border overflow-hidden p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-8 items-center justify-center rounded-full bg-brand-soft text-brand">
              <Sparkles className="size-4 animate-[pulse-dot_1.4s_ease-in-out_infinite]" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-fg">{live.phase === "evaluating" ? `Evaluating criterion ${Math.min(done + 1, total)} of ${total}` : "Preparing evaluation"}</p>
              <p className="truncate text-xs text-muted">{live.message}</p>
            </div>
            {policy ? (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <DocTypeBadge docType={policy.docType} /> <span className="font-mono text-fg">{policy.sourceKey}</span> v{policy.version}
              </span>
            ) : null}
          </div>
          <Progress className="mt-3" value={total ? done / total : 0} />
          {live.log.length ? (
            <ul className="mt-3 grid max-h-24 gap-0.5 overflow-y-auto font-mono text-[11px] text-subtle scrollbar-thin">
              {live.log.slice(-6).map((l) => (
                <li key={l.at + l.text}>› {l.text}</li>
              ))}
            </ul>
          ) : null}
        </Card>
        <div className="grid gap-2">
          {live.criteria.map((c) => (
            <motion.div key={c.criterionId} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
              <VerdictIcon verdict={c.result?.verdict} pending={c.state !== "done"} className="mt-0.5" />
              <span className="font-mono text-[11px] leading-5 text-subtle">{c.criterionId}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-fg">{c.text}</p>
                {c.state === "corrective" ? <p className="mt-0.5 text-xs text-info">{c.corrective}</p> : null}
                {c.evidence[0] ? <p className="mt-1 truncate text-xs text-muted">“{c.evidence[0].quote}”</p> : null}
              </div>
              {c.result ? <VerdictBadge verdict={c.result.verdict} short /> : <span className="text-xs text-subtle">{c.state === "corrective" ? "re-retrieving…" : "retrieving…"}</span>}
            </motion.div>
          ))}
        </div>
      </div>
    );
  }

  if (!evaluation) {
    return (
      <Card>
        <EmptyState
          art="spark"
          title={live.error ? "The last evaluation didn't finish" : "No evaluation yet"}
          description={live.error ?? "Necessa will resolve the applicable policy, then check each criterion against the de-identified chart with citations."}
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

  const results = new Map(evaluation.criteria.map((r) => [r.criterionId, r]));
  const policy = evaluation.policies[0];
  const counts = { MET: 0, NOT_MET: 0, INSUFFICIENT: 0 } as Record<Verdict, number>;
  evaluation.criteria.forEach((r) => (counts[r.effectiveVerdict] += 1));
  const canReview = can("cases:review");

  return (
    <div className="grid gap-4">
      {policy ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-surface px-4 py-3 shadow-e1">
          <span className="flex items-center gap-2 text-[13px]">
            <DocTypeBadge docType={policy.docType} />
            <span className="font-mono font-medium text-fg">{policy.sourceKey}</span>
            <span className="text-muted">v{policy.version}</span>
            <span className="hidden max-w-[340px] truncate text-muted lg:inline">· {policy.title}</span>
          </span>
          <span className="text-xs text-subtle">
            {policy.contractor?.name ?? "National"} · effective {fmtDate(policy.effectiveFrom)}
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
          {evaluation.degraded ? (
            <Badge tone="degraded" size="xs">
              Degraded mode
            </Badge>
          ) : null}
          <span className="ml-auto flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1">
              <VerdictIcon verdict="MET" className="size-3.5" /> {counts.MET}
            </span>
            <span className="flex items-center gap-1">
              <VerdictIcon verdict="INSUFFICIENT" className="size-3.5" /> {counts.INSUFFICIENT}
            </span>
            <span className="flex items-center gap-1">
              <VerdictIcon verdict="NOT_MET" className="size-3.5" /> {counts.NOT_MET}
            </span>
          </span>
        </div>
      ) : null}

      {evaluation.tree ? (
        <TreeNode node={evaluation.tree} results={results} depth={0} caseId={caseId} evalId={evaluation.id} onJump={onJump} canReview={canReview} />
      ) : (
        <div className="grid gap-2">
          {evaluation.criteria.map((r) => (
            <CriterionRow key={r.id} r={r} caseId={caseId} evalId={evaluation.id} onJump={onJump} canReview={canReview} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border-strong px-4 py-3">
        <p className="flex items-center gap-2 text-xs text-muted">
          <Gavel className="size-3.5" />
          Necessa reports documentation readiness only — it never approves or denies. A licensed clinician makes the medical-necessity determination.
        </p>
        <div className="flex gap-2">
          {canEvaluate ? (
            <Button size="sm" variant="ghost" onClick={onEvaluate}>
              <RotateCcw /> Re-run
            </Button>
          ) : null}
          {evaluation.status === "awaiting_review" && canReview ? (
            <Button size="sm" variant="primary" loading={complete.isPending} onClick={() => complete.mutate(evaluation.id)}>
              <BadgeCheck /> Complete review
            </Button>
          ) : evaluation.status === "completed" ? (
            <Badge tone="met">
              <BadgeCheck /> Review completed
            </Badge>
          ) : null}
        </div>
      </div>
    </div>
  );
}
