"use client";

import { CircleAlert, CircleCheck, CircleDashed, CircleX, Clock, Flame, Quote } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import * as React from "react";
import type { CaseStatus, Citation, DocType, PayerType, Priority, Readiness, Verdict } from "@/lib/api/types";
import { PAYER_LABEL, STATUS_LABEL, slaParts } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/display";
import { HoverCard, HoverCardContent, HoverCardTrigger, Tooltip } from "@/components/ui/overlays";

/* ── Verdict ────────────────────────────────────────────────────────────── */
export const VERDICT_META: Record<Verdict, { label: string; tone: "met" | "notmet" | "insufficient"; icon: typeof CircleCheck; short: string }> = {
  MET: { label: "Met", short: "Met", tone: "met", icon: CircleCheck },
  NOT_MET: { label: "Not met", short: "Not met", tone: "notmet", icon: CircleX },
  INSUFFICIENT: { label: "Insufficient evidence", short: "Insufficient", tone: "insufficient", icon: CircleAlert },
};

export function VerdictIcon({ verdict, className, pending }: { verdict?: Verdict | null; className?: string; pending?: boolean }) {
  if (pending) return <CircleDashed className={cn("size-4 animate-spin text-brand [animation-duration:2.4s]", className)} aria-label="Evaluating" />;
  if (!verdict) return <CircleDashed className={cn("size-4 text-subtle", className)} aria-label="Not evaluated" />;
  const m = VERDICT_META[verdict];
  const Icon = m.icon;
  return <Icon className={cn("size-4", m.tone === "met" ? "text-met" : m.tone === "notmet" ? "text-notmet" : "text-insufficient", className)} aria-label={m.label} />;
}

export function VerdictBadge({ verdict, overridden, size = "sm", short }: { verdict: Verdict; overridden?: boolean; size?: "xs" | "sm" | "md"; short?: boolean }) {
  const m = VERDICT_META[verdict];
  const Icon = m.icon;
  return (
    <Badge tone={m.tone} size={size} className={cn(overridden && "ring-1 ring-inset ring-current/30")}>
      <Icon />
      {short ? m.short : m.label}
      {overridden ? <span className="font-normal opacity-75">· override</span> : null}
    </Badge>
  );
}

/* ── Readiness ring ─────────────────────────────────────────────────────── */
const READINESS_META: Record<Readiness, { label: string; color: string; tone: "met" | "insufficient" | "notmet" | "degraded" }> = {
  ready: { label: "Ready", color: "var(--met)", tone: "met" },
  gaps: { label: "Gaps", color: "var(--insufficient)", tone: "insufficient" },
  not_supported: { label: "Not supported", color: "var(--notmet)", tone: "notmet" },
  unknown: { label: "Not evaluated", color: "var(--degraded)", tone: "degraded" },
};

export function ReadinessRing({ score, readiness, size = 44, stroke = 4, showLabel = false, className }: { score?: number | null; readiness: Readiness; size?: number; stroke?: number; showLabel?: boolean; className?: string }) {
  const reduce = useReducedMotion();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = readiness === "unknown" ? 0 : Math.max(0, Math.min(1, score ?? 0));
  const meta = READINESS_META[readiness];
  return (
    <div className={cn("inline-flex items-center gap-2.5", className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`Readiness ${meta.label}${score != null ? `, ${Math.round(pct * 100)}%` : ""}`}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={meta.color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            initial={reduce ? false : { strokeDashoffset: c }}
            animate={{ strokeDashoffset: c * (1 - pct) }}
            transition={{ duration: 0.9, ease: [0.25, 1, 0.5, 1] }}
          />
        </svg>
        <span className="tabular absolute inset-0 flex items-center justify-center font-semibold text-fg" style={{ fontSize: Math.max(10, size * 0.27) }}>
          {readiness === "unknown" ? "—" : Math.round(pct * 100)}
        </span>
      </div>
      {showLabel ? (
        <div className="grid leading-tight">
          <span className="text-[13px] font-medium text-fg">{meta.label}</span>
          <span className="text-xs text-muted">Documentation readiness</span>
        </div>
      ) : null}
    </div>
  );
}

export function ReadinessBadge({ readiness, score }: { readiness: Readiness; score?: number | null }) {
  const m = READINESS_META[readiness];
  return (
    <Badge tone={m.tone} dot>
      {m.label}
      {score != null && readiness !== "unknown" ? <span className="tabular font-normal opacity-80">{Math.round(score * 100)}%</span> : null}
    </Badge>
  );
}

/* ── Confidence meter ───────────────────────────────────────────────────── */
export function ConfidenceMeter({ value, className }: { value: number; className?: string }) {
  const bars = 5;
  const filled = Math.round(value * bars);
  return (
    <Tooltip content={`Model confidence ${Math.round(value * 100)}% (calibrated on the verdict eval set)`}>
      <span className={cn("inline-flex items-end gap-[2px]", className)} aria-label={`Confidence ${Math.round(value * 100)}%`}>
        {Array.from({ length: bars }).map((_, i) => (
          <span key={i} className={cn("w-[3px] rounded-[1px]", i < filled ? "bg-fg/70" : "bg-surface-3")} style={{ height: 5 + i * 2 }} />
        ))}
      </span>
    </Tooltip>
  );
}

/* ── Case chips ─────────────────────────────────────────────────────────── */
const STATUS_TONE: Record<CaseStatus, "neutral" | "brand" | "met" | "notmet" | "insufficient" | "info"> = {
  draft: "neutral",
  evaluating: "brand",
  needs_review: "insufficient",
  ready: "met",
  submitted: "info",
  pending_payer: "info",
  approved: "met",
  denied: "notmet",
  appealing: "brand",
  closed: "neutral",
};

export function StatusChip({ status }: { status: CaseStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function PriorityChip({ priority }: { priority: Priority }) {
  if (priority !== "expedited") return null;
  return (
    <Badge tone="notmet" size="xs">
      <Flame />
      Expedited
    </Badge>
  );
}

export function PayerChip({ payerType, payerName }: { payerType: PayerType; payerName?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-fg">
      <span className={cn("size-1.5 shrink-0 rounded-full", payerType === "medicare_ffs" ? "bg-brand" : payerType === "medicare_advantage" ? "bg-ai-2" : payerType === "commercial" ? "bg-ai-3" : "bg-insufficient")} />
      <span className="truncate">{payerName ?? PAYER_LABEL[payerType]}</span>
    </span>
  );
}

export function DocTypeBadge({ docType }: { docType: DocType }) {
  const short = docType === "Billing and Coding" ? "B&C Article" : docType;
  const tone = docType === "LCD" ? "brand" : docType === "NCD" ? "info" : "neutral";
  return (
    <Badge tone={tone} size="xs">
      {short}
    </Badge>
  );
}

export function CodeChip({ code, className }: { code: string; className?: string }) {
  return <span className={cn("inline-flex h-5 items-center rounded-[4px] bg-surface-2 px-1.5 font-mono text-[11.5px] text-fg ring-1 ring-inset ring-border", className)}>{code}</span>;
}

/* ── SLA timer (live) ───────────────────────────────────────────────────── */
export function SlaTimer({ dueAt, compact, className }: { dueAt?: string | null; compact?: boolean; className?: string }) {
  const [, tick] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);
  const p = slaParts(dueAt);
  if (!p) return <span className="text-xs text-subtle">—</span>;
  return (
    <Tooltip content={`Due ${new Date(dueAt!).toLocaleString()} · payer clock (CMS-0057-F: 72 h expedited / 7 days standard)`}>
      <span
        className={cn(
          "tabular inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium",
          p.tone === "danger" && "text-notmet-fg",
          p.tone === "warn" && "text-insufficient-fg",
          p.tone === "ok" && "text-muted",
          className,
        )}
      >
        <Clock className="size-3.5" />
        {p.overdue ? "Overdue " : compact ? "" : "Due in "}
        {p.label}
      </span>
    </Tooltip>
  );
}

/* ── Citations ──────────────────────────────────────────────────────────── */
export function CitationChip({ citation, onOpen }: { citation: Citation; onOpen?: (c: Citation) => void }) {
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={() => onOpen?.(citation)}
          className="mx-0.5 inline-flex h-[17px] min-w-[17px] -translate-y-px items-center justify-center rounded-[4px] bg-brand-soft px-1 align-middle font-mono text-[10.5px] font-semibold text-brand-fg ring-1 ring-inset ring-brand/20 transition-colors hover:bg-brand hover:text-brand-contrast"
          aria-label={`Citation ${citation.n}: ${citation.sourceKey}`}
        >
          {citation.n}
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-96">
        <div className="flex items-center gap-2">
          <Badge tone="brand" size="xs">
            {citation.sourceKey}
          </Badge>
          <span className="text-xs text-subtle">
            v{citation.version} · {citation.sectionKey.replace(/_/g, " ")}
          </span>
        </div>
        <p className="mt-1.5 text-[13px] font-medium leading-snug text-fg">{citation.title}</p>
        <blockquote className="mt-2 flex gap-2 rounded-md bg-surface-2 p-2.5 text-[12.5px] leading-relaxed text-muted">
          <Quote className="mt-0.5 size-3.5 shrink-0 text-subtle" />
          <span>{citation.quote}</span>
        </blockquote>
      </HoverCardContent>
    </HoverCard>
  );
}

/* ── Evidence highlighting ──────────────────────────────────────────────── */
export interface HighlightSpan {
  start: number;
  end: number;
  id: string;
  tone: "evidence" | "policy";
  label?: string;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** Renders text with non-overlapping highlighted spans; active span gets a focus ring and is scrolled into view. */
export function HighlightedText({ text, spans, activeId, className, onSpanClick }: { text: string; spans: HighlightSpan[]; activeId?: string | null; className?: string; onSpanClick?: (id: string) => void }) {
  const sorted = [...spans].filter((s) => s.start >= 0 && s.end > s.start).sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  const activeRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    // Center the active span inside its own scroll pane only — `scrollIntoView` would also scroll
    // every ancestor, jerking the whole page while someone is reading the other pane.
    const el = activeRef.current;
    const pane = el ? scrollParent(el) : null;
    if (!el || !pane) return;
    const delta = el.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 2 + el.offsetHeight / 2;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    pane.scrollBy({ top: delta, behavior: smooth ? "smooth" : "auto" });
  }, [activeId]);
  sorted.forEach((s, i) => {
    if (s.start < cursor) return;
    if (s.start > cursor) parts.push(<span key={`t${i}`}>{text.slice(cursor, s.start)}</span>);
    const active = s.id === activeId;
    parts.push(
      <mark
        key={`m${i}`}
        ref={active ? (el) => void (activeRef.current = el) : undefined}
        data-span={s.id}
        title={s.label}
        onClick={onSpanClick ? () => onSpanClick(s.id) : undefined}
        className={cn("text-fg", s.tone === "evidence" ? "mark-evidence" : "mark-policy", active && "mark-active", onSpanClick && "cursor-pointer")}
      >
        {text.slice(s.start, s.end)}
      </mark>,
    );
    cursor = s.end;
  });
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return <div className={cn("whitespace-pre-wrap text-[13px] leading-[1.75] text-fg", className)}>{parts}</div>;
}

/** Highlights PHI tokens like [PATIENT_NAME] as redaction pills. */
export function DeidText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(\[[A-Z_]+\])/g);
  return (
    <div className={cn("whitespace-pre-wrap text-[13px] leading-[1.75] text-fg", className)}>
      {parts.map((p, i) =>
        /^\[[A-Z_]+\]$/.test(p) ? (
          <span key={i} className="mx-px rounded-[4px] bg-surface-3 px-1 py-px font-mono text-[11px] text-muted" title="De-identified (PHI token)">
            {p.slice(1, -1).toLowerCase().replace(/_/g, " ")}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </div>
  );
}

export { motion };
