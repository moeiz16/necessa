"use client";

/**
 * Live evaluation view: what the engine is doing right now, criterion by criterion.
 * Phase timeline → per-criterion lifecycle (queued → retrieving → corrective → verdict) with
 * evidence chips arriving as they are retrieved and verification marks landing with the verdict.
 */
import { BadgeCheck, Check, ChevronDown, FileSearch, Quote, RotateCcw, ShieldCheck, TerminalSquare } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { DocTypeBadge, VerdictBadge, VerdictIcon } from "@/components/domain/verdict";
import { AiWorking } from "@/components/domain/trust";
import { Card, Progress } from "@/components/ui/display";
import { Collapse } from "@/components/ui/motion";
import type { LiveCriterion, LiveEvaluation } from "./use-case-stream";

export const PHASES = [
  { id: "resolving", label: "Resolve policy" },
  { id: "loading_criteria", label: "Load criteria" },
  { id: "indexing_chart", label: "Index chart" },
  { id: "evaluating", label: "Judge criteria" },
  { id: "aggregating", label: "Aggregate" },
  { id: "drafting_gaps", label: "Draft gaps" },
  { id: "review", label: "Human review" },
] as const;

function phaseIndex(phase?: string) {
  const i = PHASES.findIndex((p) => p.id === phase);
  return i < 0 ? 0 : i;
}

function useElapsed(running: boolean) {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);
  const s = Math.max(0, Math.round((now - start) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function PhaseTimeline({ phase, done }: { phase?: string; done?: boolean }) {
  const current = done ? PHASES.length : phaseIndex(phase);
  return (
    <ol className="flex flex-wrap items-center gap-y-1" aria-label="Evaluation phases">
      {PHASES.map((p, i) => {
        const complete = i < current;
        const active = i === current;
        return (
          <li key={p.id} className="flex shrink-0 items-center" aria-current={active ? "step" : undefined}>
            <span className={cn("flex items-center gap-1.5 rounded-full px-2 py-1 text-[11.5px] font-medium transition-colors duration-300", active ? "bg-brand-soft text-brand-fg" : complete ? "text-fg" : "text-subtle")}>
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-full border transition-colors duration-300",
                  complete ? "border-met bg-met text-white" : active ? "border-brand bg-surface" : "border-border-strong bg-surface",
                )}
              >
                {complete ? <Check className="size-2.5" strokeWidth={3} /> : active ? <span className="size-1.5 animate-pulse rounded-full bg-brand" /> : null}
              </span>
              {p.label}
            </span>
            {i < PHASES.length - 1 ? (
              <span className="relative mx-0.5 h-px w-4 bg-border sm:w-6" aria-hidden>
                <span className="absolute inset-y-0 left-0 bg-met transition-[width] duration-500 ease-out" style={{ width: complete ? "100%" : "0%" }} />
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function LiveRow({ c }: { c: LiveCriterion }) {
  const reduce = useReducedMotion();
  const r = c.result;
  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "relative overflow-hidden rounded-lg border bg-surface px-3 py-2.5 transition-colors duration-300",
        c.state === "done" ? "border-border" : "border-brand/30 shadow-[0_0_0_3px_color-mix(in_oklab,var(--brand)_8%,transparent)]",
      )}
    >
      {c.state !== "done" ? <span aria-hidden className="ai-sheen pointer-events-none absolute inset-0" /> : null}
      <div className="relative flex items-start gap-3">
        <span className="mt-0.5">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={c.state === "done" ? "v" : "p"} initial={reduce ? false : { scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ type: "spring", stiffness: 500, damping: 26 }} className="block">
              <VerdictIcon verdict={r?.verdict} pending={c.state !== "done"} />
            </motion.span>
          </AnimatePresence>
        </span>
        <span className="font-mono text-[11px] leading-5 text-subtle">{c.criterionId}</span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-5 text-fg">{c.text}</p>
          {c.state === "corrective" ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-info">
              <RotateCcw className="size-3 animate-spin [animation-duration:1.6s]" /> {c.corrective}
            </p>
          ) : null}
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            <AnimatePresence initial={false}>
              {c.evidence.slice(0, 3).map((e, i) => (
                <motion.li
                  key={e.chunkId + i}
                  initial={reduce ? false : { opacity: 0, scale: 0.96, y: 3 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ duration: 0.22, delay: i * 0.06 }}
                  className="flex max-w-full items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-muted ring-1 ring-inset ring-border"
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
          {r ? (
            <motion.span initial={reduce ? false : { scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 420, damping: 22 }}>
              <VerdictBadge verdict={r.verdict} short />
            </motion.span>
          ) : (
            <span className="text-xs text-subtle">{c.state === "corrective" ? "Re-retrieving…" : c.evidence.length ? "Judging…" : "Retrieving…"}</span>
          )}
          {r ? (
            <span className="flex items-center gap-1.5 text-[10.5px] text-subtle">
              <span className={cn("inline-flex items-center gap-0.5", r.verification.quoteValid ? "text-met-fg" : "text-notmet-fg")} title={r.verification.quoteValid ? "Every quote was found verbatim in the chart" : "A quote could not be verified — downgraded"}>
                <BadgeCheck className="size-3" /> verbatim
              </span>
              {r.verification.entailment ? (
                <span className={cn("inline-flex items-center gap-0.5", r.verification.entailment === "entails" ? "text-met-fg" : "text-subtle")} title={`Cross-model check: ${r.verification.entailment}`}>
                  <ShieldCheck className="size-3" /> cross-check
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
  const [logOpen, setLogOpen] = useState(false);
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
      <Card className="ai-border overflow-hidden">
        <div className="grid gap-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <AiWorking label={live.phase === "evaluating" ? `Judging criterion ${Math.min(done + 1, total)} of ${total}` : live.message || "Preparing evaluation"} />
            <span className="tabular text-xs text-subtle">{elapsed}</span>
            {policy ? (
              <span className="ml-auto flex items-center gap-1.5 text-xs text-muted">
                <DocTypeBadge docType={policy.docType} /> <span className="font-mono font-medium text-fg">{policy.sourceKey}</span> v{policy.version}
              </span>
            ) : null}
          </div>
          <PhaseTimeline phase={live.phase} />
          <div className="flex items-center gap-3">
            <Progress className="flex-1" value={live.criteriaCount ? done / total : 0} />
            <span className="tabular flex items-center gap-2.5 text-xs text-muted">
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
          {live.message && live.phase !== "evaluating" ? <p className="text-xs text-muted">{live.message}</p> : null}
        </div>
        {live.log.length ? (
          <div className="border-t border-border/70">
            <button type="button" onClick={() => setLogOpen((v) => !v)} className="flex w-full items-center gap-1.5 px-4 py-2 text-[11.5px] font-medium text-subtle hover:text-fg" aria-expanded={logOpen}>
              <TerminalSquare className="size-3.5" /> Engine log
              <span className="tabular">({live.log.length})</span>
              <ChevronDown className={cn("ml-auto size-3.5 transition-transform", logOpen && "rotate-180")} />
            </button>
            <Collapse open={logOpen}>
              <ul className="grid max-h-36 gap-0.5 overflow-y-auto px-4 pb-3 font-mono text-[11px] text-subtle scrollbar-thin">
                {live.log.map((l) => (
                  <li key={l.at + l.text}>
                    <span className="text-subtle/70">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span> › {l.text}
                  </li>
                ))}
              </ul>
            </Collapse>
          </div>
        ) : null}
      </Card>

      <ul className="grid gap-2" aria-live="polite">
        {live.criteria.map((c) => (
          <LiveRow key={c.criterionId} c={c} />
        ))}
        {Array.from({ length: queued }).map((_, i) => (
          <li key={`q${i}`} className="flex items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-subtle">
            <FileSearch className="size-4 opacity-60" />
            <span className="skeleton h-3 flex-1 rounded" style={{ maxWidth: `${55 + ((i * 17) % 35)}%` }} />
            Queued
          </li>
        ))}
      </ul>
    </div>
  );
}
