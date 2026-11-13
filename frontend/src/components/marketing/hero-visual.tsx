"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FileText, Quote, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { Verdict } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { ReadinessRing, VerdictIcon } from "@/components/domain/verdict";

const ROWS: { text: string; verdict: Verdict; quote?: string; source?: string }[] = [
  { text: "Radicular pain supported by history and exam", verdict: "MET", quote: "Positive straight-leg raise at 40 degrees on the right", source: "Progress note · 10/28" },
  { text: "Functional deficit on a validated scale", verdict: "MET", quote: "Oswestry Disability Index 46% (severe disability)", source: "Progress note · 10/28" },
  { text: "≥ 4 weeks of failed conservative care", verdict: "INSUFFICIENT", quote: "Dates of care: 09/29/2026 to 10/20/2026", source: "PT discharge" },
  { text: "Imaging consistent with presentation", verdict: "MET", quote: "protrusion contacting the descending right S1 nerve root", source: "MRI · 08/30" },
  { text: "Fluoroscopic or CT guidance with contrast", verdict: "MET", quote: "under fluoroscopic guidance with contrast", source: "Plan" },
  { text: "No active infection (attestation)", verdict: "INSUFFICIENT", source: "Not documented" },
];

export function HeroVisual() {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(reduce ? ROWS.length : 0);
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setStep((s) => (s >= ROWS.length + 4 ? 0 : s + 1)), 900);
    return () => clearInterval(t);
  }, [reduce]);
  const done = Math.min(step, ROWS.length);
  const met = ROWS.slice(0, done).filter((r) => r.verdict === "MET").length;
  const active = ROWS[Math.min(step, ROWS.length) - 1];

  return (
    <div className="relative">
      <div className="absolute -inset-8 -z-10 rounded-[40px] bg-[radial-gradient(60%_60%_at_70%_20%,color-mix(in_oklab,var(--ai-1)_22%,transparent),transparent),radial-gradient(50%_50%_at_10%_90%,color-mix(in_oklab,var(--ai-3)_16%,transparent),transparent)] blur-2xl" />
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-e3">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <ReadinessRing size={40} stroke={3.5} score={done ? met / ROWS.length : 0} readiness={done === ROWS.length ? "gaps" : done ? "gaps" : "unknown"} />
            <div className="grid min-w-0 leading-tight">
              <span className="truncate text-[13px] font-semibold text-fg">NC-2026-00042 · Right L5-S1 transforaminal ESI</span>
              <span className="truncate text-xs text-muted">Medicare Part B · TX · LCD L36920 v107 (Novitas)</span>
            </div>
          </div>
          <span className="hidden items-center gap-1.5 rounded-full bg-brand-soft px-2 py-1 text-[11px] font-medium text-brand-fg sm:inline-flex">
            <Sparkles className="size-3" />
            {done < ROWS.length ? `Evaluating ${done + 1}/${ROWS.length}` : "Awaiting review"}
          </span>
        </div>
        <ul className="divide-y divide-border/70">
          {ROWS.map((r, i) => {
            const state = i < done ? "done" : i === done && step < ROWS.length ? "active" : "pending";
            return (
              <li key={r.text} className={cn("flex items-center gap-3 px-4 py-2.5 transition-colors", state === "active" && "bg-brand-soft/30")}>
                <VerdictIcon verdict={state === "done" ? r.verdict : null} pending={state === "active"} />
                <span className={cn("min-w-0 flex-1 truncate text-[13px]", state === "pending" ? "text-subtle" : "text-fg")}>{r.text}</span>
                <AnimatePresence>
                  {state === "done" ? (
                    <motion.span
                      initial={{ opacity: 0, x: 6 }}
                      animate={{ opacity: 1, x: 0 }}
                      className={cn(
                        "shrink-0 rounded-[5px] px-1.5 py-0.5 text-[11px] font-medium",
                        r.verdict === "MET" ? "bg-met-soft text-met-fg" : "bg-insufficient-soft text-insufficient-fg",
                      )}
                    >
                      {r.verdict === "MET" ? "Met" : "Insufficient"}
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </li>
            );
          })}
        </ul>
        <div className="min-h-[92px] border-t border-border bg-surface-2/50 px-4 py-3">
          <AnimatePresence mode="wait">
            {active ? (
              <motion.div key={active.text} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="grid gap-1.5">
                <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-subtle">
                  <FileText className="size-3" /> Evidence · {active.source}
                </span>
                {active.quote ? (
                  <p className="flex gap-2 text-[13px] leading-snug text-fg">
                    <Quote className="mt-0.5 size-3.5 shrink-0 text-subtle" />
                    <mark className="mark-evidence">{active.quote}</mark>
                  </p>
                ) : (
                  <p className="text-[13px] text-insufficient-fg">No attestation in the chart — absence of evidence isn’t treated as met. Suggested fix drafted.</p>
                )}
              </motion.div>
            ) : (
              <motion.p key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-[13px] text-muted">
                Resolving LCD for 64483 + M54.17 in Texas as of 11/18/2026…
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
