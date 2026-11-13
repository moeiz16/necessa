"use client";

/**
 * The live check: what Necessa is doing right now, requirement by requirement.
 * Five plain steps, then one row per requirement that fills in as each one is checked.
 */
import { BadgeCheck, Check, FileSearch, Quote, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { DocTypeBadge, VerdictBadge, VerdictIcon } from "@/components/domain/verdict";
import { Card, Progress } from "@/components/ui/display";
import type { LiveCriterion, LiveEvaluation } from "./use-case-stream";

export const PHASES = [
  { id: "policy", label: "Finding the right policy", from: ["resolving", "loading_criteria"] },
  { id: "chart", label: "Reading the chart", from: ["indexing_chart"] },
  { id: "check", label: "Checking each requirement", from: ["evaluating"] },
  { id: "summary", label: "Summarizing gaps", from: ["aggregating", "drafting_gaps"] },
  { id: "review", label: "Ready for your review", from: ["review"] },
] as const;

function phaseIndex(phase?: string) {
  const i = PHASES.findIndex((p) => (p.from as readonly string[]).includes(phase ?? ""));
  return i < 0 ? 0 : i;
}

function useElapsed(running: boolean) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  const s = Math.max(0, Math.round((now - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function PhaseTimeline({ phase, done }: { phase?: string; done?: boolean }) {
  const current = done ? PHASES.length : phaseIndex(phase);
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1.5" aria-label="Progress">
      {PHASES.map((p, i) => {
        const complete = i < current;
        const active = i === current;
        return (
          <li key={p.id} className="flex shrink-0 items-center" aria-current={active ? "step" : undefined}>
            <span className={cn("flex items-center gap-1.5 text-xs", active ? "font-medium text-fg" : complete ? "text-muted" : "text-subtle")}>
              <span className={cn("flex size-4 items-center justify-center rounded-full border", complete ? "border-met bg-met text-white" : active ? "border-brand" : "border-border-strong")}>
                {complete ? <Check className="size-2.5" strokeWidth={3} /> : active ? <span className="size-1.5 rounded-full bg-brand" /> : null}
              </span>
              {p.label}
            </span>
            {i < PHASES.length - 1 ? <span className="mx-2 h-px w-3 bg-border sm:w-5" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function stateLabel(c: LiveCriterion) {
  if (c.state === "corrective") return "Taking a second look…";
  return c.evidence.length ? "Checking…" : "Reading the chart…";
}

function LiveRow({ c }: { c: LiveCriterion }) {
  const reduce = useReducedMotion();
  const r = c.result;
  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className={cn("rounded-lg border bg-surface px-3 py-2.5", c.state === "done" ? "border-border" : "border-border-strong")}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5">
          <VerdictIcon verdict={r?.verdict} pending={c.state !== "done"} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-5 text-fg">{c.text}</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            <AnimatePresence initial={false}>
              {c.evidence.slice(0, 3).map((e, i) => (
                <motion.li
                  key={e.chunkId + i}
                  initial={reduce ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.18, delay: i * 0.05 }}
                  className="flex max-w-full items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-muted"
                  title={e.quote}
                >
                  <Quote className="size-3 shrink-0 text-subtle" />
                  <span className="max-w-[280px] truncate">{e.quote}</span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {r ? <VerdictBadge verdict={r.verdict} short /> : <span className="text-xs text-subtle">{stateLabel(c)}</span>}
          {r ? (
            <span className="flex items-center gap-2 text-[10.5px] text-subtle">
              <span className={cn("inline-flex items-center gap-0.5", r.verification.quoteValid ? "text-met-fg" : "text-notmet-fg")} title={r.verification.quoteValid ? "Every quote was found in the chart" : "A quote could not be found in the chart, so this result was lowered"}>
                <BadgeCheck className="size-3" /> {r.verification.quoteValid ? "Quote verified" : "Quote not found"}
              </span>
              {r.verification.entailment ? (
                <span className={cn("inline-flex items-center gap-0.5", r.verification.entailment === "entails" ? "text-met-fg" : "text-subtle")} title="A second, independent check agreed with this result">
                  <ShieldCheck className="size-3" /> Double-checked
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </motion.li>
  );
}

export function LiveEvaluationView({ live }: { live: LiveEvaluation }) {
  const elapsed = useElapsed(live.running);
  const done = live.criteria.filter((c) => c.state === "done").length;
  const total = live.criteriaCount || Math.max(live.criteria.length, 1);
  const queued = Math.max(0, (live.criteriaCount || 0) - live.criteria.length);
  const policy = live.policies[0];
  const tally = live.criteria.reduce(
    (acc, c) => {
      if (c.result) acc[c.result.verdict] += 1;
      return acc;
    },
    { MET: 0, INSUFFICIENT: 0, NOT_MET: 0 } as Record<"MET" | "INSUFFICIENT" | "NOT_MET", number>,
  );

  return (
    <div className="grid gap-3" aria-busy={live.running}>
      <Card>
        <div className="grid gap-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-medium text-fg">Checking this case against the policy</h2>
            <span className="tabular text-xs text-subtle">{elapsed}</span>
            {policy ? (
              <span className="ml-auto flex items-center gap-1.5 text-xs text-muted">
                <DocTypeBadge docType={policy.docType} /> <span className="font-medium text-fg">{policy.sourceKey}</span> v{policy.version}
              </span>
            ) : null}
          </div>
          <PhaseTimeline phase={live.phase} />
          <div className="flex items-center gap-3">
            <Progress className="flex-1" value={live.criteriaCount ? done / total : 0} />
            <span className="tabular flex items-center gap-2.5 text-xs text-muted" aria-label={`${tally.MET} met, ${tally.INSUFFICIENT} need more documentation, ${tally.NOT_MET} not met`}>
              <span className="flex items-center gap-1">
                <VerdictIcon verdict="MET" className="size-3.5" /> {tally.MET}
              </span>
              <span className="flex items-center gap-1">
                <VerdictIcon verdict="INSUFFICIENT" className="size-3.5" /> {tally.INSUFFICIENT}
              </span>
              <span className="flex items-center gap-1">
                <VerdictIcon verdict="NOT_MET" className="size-3.5" /> {tally.NOT_MET}
              </span>
            </span>
          </div>
          {live.phase === "evaluating" && live.criteriaCount ? (
            <p className="text-xs text-muted">
              Requirement {Math.min(done + 1, total)} of {total}
            </p>
          ) : null}
        </div>
      </Card>

      <ul className="grid gap-2" aria-live="polite">
        {live.criteria.map((c) => (
          <LiveRow key={c.criterionId} c={c} />
        ))}
        {Array.from({ length: queued }).map((_, i) => (
          <li key={`q${i}`} className="flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-subtle">
            <FileSearch className="size-4 opacity-60" />
            <span className="skeleton h-3 flex-1 rounded" style={{ maxWidth: `${55 + ((i * 17) % 35)}%` }} />
            Waiting
          </li>
        ))}
      </ul>
    </div>
  );
}
