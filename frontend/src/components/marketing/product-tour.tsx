"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowRight, BookOpen, CircleAlert, CircleCheck, Clock, FileText, Gauge, Layers, MessageSquareText, ScanSearch, Sparkles, SplitSquareHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "workspace", label: "Case workspace", icon: Gauge, blurb: "Criteria tree, live evaluation, gaps and next steps — on one screen." },
  { id: "evidence", label: "Evidence view", icon: SplitSquareHorizontal, blurb: "Policy text and chart side by side, with every quote highlighted in both." },
  { id: "assistant", label: "Ask Necessa", icon: MessageSquareText, blurb: "Cited answers with the full retrieval trace — nothing is a black box." },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Chrome({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-e3">
      <div className="flex items-center gap-2 border-b border-border bg-surface-2/60 px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-border-strong" />
          <span className="size-2.5 rounded-full bg-border-strong" />
          <span className="size-2.5 rounded-full bg-border-strong" />
        </span>
        <span className="mx-auto truncate rounded-md bg-surface px-3 py-0.5 font-mono text-[11px] text-subtle shadow-e1">{title}</span>
      </div>
      {children}
    </div>
  );
}

function Workspace() {
  const rows = [
    { t: "Radicular pain on history and exam", v: "met" },
    { t: "Functional deficit on a validated scale", v: "met" },
    { t: "≥ 4 weeks of failed conservative care", v: "gap" },
    { t: "Imaging consistent with presentation", v: "met" },
    { t: "No active infection (attestation)", v: "gap" },
  ] as const;
  return (
    <div className="grid grid-cols-1 md:grid-cols-[1.35fr_1fr] [&>*]:min-w-0">
      <div className="border-b border-border p-4 md:border-b-0 md:border-r">
        <div className="flex items-center gap-3">
          <span className="relative flex size-11 items-center justify-center rounded-full">
            <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90" aria-hidden>
              <circle cx="22" cy="22" r="19" fill="none" stroke="var(--surface-3)" strokeWidth="4" />
              <circle cx="22" cy="22" r="19" fill="none" stroke="var(--insufficient)" strokeWidth="4" strokeLinecap="round" strokeDasharray={119.4} strokeDashoffset={119.4 * 0.29} />
            </svg>
            <span className="tabular text-[12px] font-semibold text-fg">71</span>
          </span>
          <div className="grid leading-tight">
            <span className="text-[13px] font-semibold text-fg">Right L5-S1 transforaminal ESI</span>
            <span className="text-xs text-muted">Medicare Part B · LCD L36920 · Gaps: 2</span>
          </div>
          <span className="ml-auto hidden items-center gap-1 rounded-full bg-insufficient-soft px-2 py-0.5 text-[11px] font-medium text-insufficient-fg sm:inline-flex">
            <Clock className="size-3" /> 2d 4h
          </span>
        </div>
        <div className="mt-4 rounded-lg border border-border">
          <p className="border-b border-border px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-wider text-subtle">All of</p>
          <ul className="divide-y divide-border/70">
            {rows.map((r) => (
              <li key={r.t} className="flex items-center gap-2.5 px-3 py-2 text-[12.5px]">
                {r.v === "met" ? <CircleCheck className="size-4 shrink-0 text-met" /> : <CircleAlert className="size-4 shrink-0 text-insufficient" />}
                <span className="min-w-0 flex-1 truncate text-fg">{r.t}</span>
                <span className={cn("shrink-0 rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-medium", r.v === "met" ? "bg-met-soft text-met-fg" : "bg-insufficient-soft text-insufficient-fg")}>
                  {r.v === "met" ? "Met" : "Insufficient"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="grid content-start gap-3 bg-surface-2/40 p-4">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">
          <Sparkles className="size-3 text-ai-2" /> Next best actions
        </p>
        {[
          ["Add PT dates and outcome", "Policy requires ≥ 4 weeks; chart shows 3."],
          ["Request infection attestation", "Absence of evidence isn’t met."],
          ["Draft letter of medical necessity", "Available once gaps close."],
        ].map(([t, d], i) => (
          <div key={t} className={cn("rounded-lg border border-border bg-surface p-3 shadow-e1", i === 2 && "opacity-60")}>
            <p className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
              {t}
              <ArrowRight className="ml-auto size-3.5 text-subtle" />
            </p>
            <p className="mt-0.5 text-[11.5px] text-muted">{d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Evidence() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 [&>*]:min-w-0">
      <div className="border-b border-border p-4 md:border-b-0 md:border-r">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">
          <BookOpen className="size-3" /> LCD L36920 · Indications
        </p>
        <p className="mt-3 text-[12.5px] leading-[1.8] text-fg">
          Epidural steroid injections are covered when{" "}
          <mark className="mark-policy text-fg">radicular pain has been present for at least 4 weeks despite conservative care</mark>, including{" "}
          <mark className="mark-policy text-fg">physical therapy or a home exercise program</mark>, and the{" "}
          <mark className="mark-policy text-fg">imaging findings are consistent with the clinical presentation</mark>.
        </p>
      </div>
      <div className="p-4">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">
          <FileText className="size-3" /> Chart · PT discharge · de-identified
        </p>
        <p className="mt-3 text-[12.5px] leading-[1.8] text-fg">
          <span className="mx-px rounded-[4px] bg-surface-3 px-1 font-mono text-[10.5px] text-muted">patient name</span> completed{" "}
          <mark className="mark-evidence text-fg">8 sessions of physical therapy between 09/29 and 10/20</mark> with partial relief. MRI{" "}
          <mark className="mark-evidence text-fg">shows L5-S1 protrusion contacting the right S1 root</mark>.
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-insufficient-soft/70 px-3 py-2 text-[11.5px] text-insufficient-fg">
          <CircleAlert className="size-3.5 shrink-0" /> 3 weeks documented — policy asks for 4. Suggested fix ready.
        </div>
      </div>
    </div>
  );
}

function Assistant() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[1.25fr_1fr] [&>*]:min-w-0">
      <div className="grid content-start gap-3 border-b border-border p-4 md:border-b-0 md:border-r">
        <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-brand px-3 py-2 text-[12.5px] text-brand-contrast">Is E0601 covered in Ohio, and what documentation is needed?</div>
        <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-fg">
          Yes — under LCD L33718 when obstructive sleep apnea is confirmed by a qualifying sleep test
          <span className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-brand-soft px-1 font-mono text-[10px] font-semibold text-brand-fg">1</span>. Continued coverage needs a face-to-face re-evaluation between days 31 and 91 showing benefit
          <span className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-brand-soft px-1 font-mono text-[10px] font-semibold text-brand-fg">2</span>.
        </div>
      </div>
      <div className="grid content-start gap-2.5 bg-surface-2/40 p-4 text-[11.5px]">
        <p className="flex items-center gap-1.5 font-semibold uppercase tracking-[0.08em] text-subtle">
          <Layers className="size-3" /> Retrieval inspector
        </p>
        {[
          ["Intent", "S8 · multi-hop"],
          ["Filters", "state=OH · as-of 2026-11-13"],
          ["Retrievers", "graph + dense + BM25"],
          ["Fusion", "RRF k=60 → rerank"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 rounded-md bg-surface px-2.5 py-1.5 shadow-e1">
            <span className="text-muted">{k}</span>
            <span className="truncate font-mono text-fg">{v}</span>
          </div>
        ))}
        <div className="grid gap-1 pt-1">
          {[0.92, 0.81, 0.64].map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-12 font-mono text-subtle">#{i + 1}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                <span className="block h-full rounded-full bg-brand" style={{ width: `${v * 100}%` }} />
              </span>
              <span className="tabular w-8 text-right text-muted">{v.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ProductTour() {
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<TabId>("workspace");
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    if (!auto || reduce) return;
    const t = setInterval(() => setTab((cur) => TABS[(TABS.findIndex((x) => x.id === cur) + 1) % TABS.length]!.id), 6500);
    return () => clearInterval(t);
  }, [auto, reduce]);
  const active = TABS.find((t) => t.id === tab)!;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr] lg:gap-10 [&>*]:min-w-0">
      <div role="tablist" aria-label="Product tour" className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
        {TABS.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              aria-controls="tour-panel"
              onClick={() => {
                setTab(t.id);
                setAuto(false);
              }}
              className={cn(
                "group relative min-w-[220px] rounded-xl border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/30 lg:min-w-0",
                on ? "border-border bg-surface shadow-e2" : "border-transparent hover:bg-surface/60",
              )}
            >
              <span className="flex items-center gap-2 text-[14px] font-semibold text-fg">
                <t.icon className={cn("size-4", on ? "text-brand" : "text-subtle")} />
                {t.label}
              </span>
              <span className="mt-1 block text-[12.5px] leading-relaxed text-muted">{t.blurb}</span>
              {on && auto && !reduce ? (
                <motion.span key={t.id} className="absolute inset-x-4 bottom-0 h-[2px] origin-left rounded-full bg-brand/60" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 6.5, ease: "linear" }} />
              ) : null}
            </button>
          );
        })}
      </div>
      <div id="tour-panel" role="tabpanel" aria-label={active.label} className="min-w-0">
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
            <Chrome title={tab === "workspace" ? "necessa.app/cases/NC-2026-00042" : tab === "evidence" ? "necessa.app/cases/NC-2026-00042#evidence" : "necessa.app/assistant"}>
              {tab === "workspace" ? <Workspace /> : tab === "evidence" ? <Evidence /> : <Assistant />}
            </Chrome>
          </motion.div>
        </AnimatePresence>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-subtle">
          <ScanSearch className="size-3.5" /> Illustration with synthetic data. Every verdict in the product links to its quoted source.
        </p>
      </div>
    </div>
  );
}
