"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight, FileUp, GripVertical } from "lucide-react";
import * as React from "react";
import type { DiffHunk } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { CountUp } from "./motion";

/* ── Sparkline (pure SVG, no chart lib) ─────────────────────────────────── */
/** Monotone cubic smoothing so noisy daily counts read as a trend, not a seismograph. */
function smoothPath(pts: readonly (readonly [number, number])[]) {
  if (pts.length < 3) return pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const t = 0.18;
    const c1 = [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    d += ` C${c1[0]!.toFixed(1)},${c1[1]!.toFixed(1)} ${c2[0]!.toFixed(1)},${c2[1]!.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Light moving average to tame day-to-day noise in tiny charts. */
function soften(values: number[], window = 3) {
  if (values.length < window + 2) return values;
  return values.map((_, i) => {
    const a = Math.max(0, i - Math.floor(window / 2));
    const b = Math.min(values.length, a + window);
    const slice = values.slice(a, b);
    return slice.reduce((x, y) => x + y, 0) / slice.length;
  });
}

export function Sparkline({
  values,
  className,
  tone = "brand",
  height = 28,
  width = 96,
  fill = true,
  smooth = true,
}: {
  values: number[];
  className?: string;
  tone?: "brand" | "met" | "notmet" | "insufficient" | "neutral";
  height?: number;
  width?: number;
  fill?: boolean;
  smooth?: boolean;
}) {
  const id = React.useId();
  if (values.length < 2) return null;
  const series = smooth ? soften(values) : values;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const pts = series.map((v, i) => [(i / (series.length - 1)) * width, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const d = smooth ? smoothPath(pts) : pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const color = tone === "neutral" ? "var(--fg-subtle)" : `var(--${tone})`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("overflow-visible", className)} aria-hidden>
      {fill ? (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.2" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
        </>
      ) : null}
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r="2.4" fill={color} stroke="var(--surface)" strokeWidth="1.2" />
    </svg>
  );
}

/* ── Stat card ──────────────────────────────────────────────────────────── */
/**
 * KPI tile. Arrow direction shows the sign of the change; color + the word "better/worse" (screen
 * readers) show whether that is good — so "+3 due soon" is an up-arrow in the caution color, and
 * "+11 gaps caught" is an up-arrow in green. Numbers count up on first view.
 */
export function StatCard({
  label,
  value,
  delta,
  deltaLabel,
  goodWhen = "up",
  spark,
  icon,
  className,
  hint,
  countUp,
  format,
}: {
  label: string;
  value: React.ReactNode;
  delta?: number;
  deltaLabel?: string;
  goodWhen?: "up" | "down" | "neutral";
  spark?: number[];
  icon?: React.ReactNode;
  className?: string;
  hint?: string;
  /** Animate numeric `value` (or pass a number and `format`). */
  countUp?: boolean;
  format?: (n: number) => string;
}) {
  const good = delta === undefined || goodWhen === "neutral" ? null : goodWhen === "up" ? delta >= 0 : delta <= 0;
  const deltaTone = good === null ? "text-muted" : good ? "text-met-fg" : "text-insufficient-fg";
  const sparkTone = good === false ? "insufficient" : "brand";
  return (
    <div className={cn("group flex flex-col justify-between gap-3 rounded-lg bg-surface p-4 shadow-e1 transition-shadow duration-150 hover:shadow-e2", className)} title={hint}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {icon ? <span className="text-subtle transition-colors group-hover:text-muted [&_svg]:size-4">{icon}</span> : null}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <span className="tabular text-[26px] font-semibold leading-none tracking-[-0.02em] text-fg">
            {countUp && typeof value === "number" ? <CountUp value={value} format={format} /> : value}
          </span>
          {delta !== undefined ? (
            <span className={cn("inline-flex items-center gap-1 text-xs font-medium", deltaTone)}>
              {delta > 0 ? <ArrowUpRight className="size-3.5" /> : delta < 0 ? <ArrowDownRight className="size-3.5" /> : <ArrowRight className="size-3.5" />}
              <span className="tabular">
                {delta > 0 ? "+" : ""}
                {delta}
              </span>
              {deltaLabel ? <span className="truncate font-normal text-subtle">{deltaLabel}</span> : null}
              {good !== null ? <span className="sr-only">{good ? "(better)" : "(worse)"}</span> : null}
            </span>
          ) : null}
        </div>
        {spark ? <Sparkline values={spark} tone={sparkTone} className="shrink-0" /> : null}
      </div>
    </div>
  );
}

/* ── Timeline ───────────────────────────────────────────────────────────── */
export function Timeline({ items }: { items: { id: string; icon: React.ReactNode; title: React.ReactNode; meta?: React.ReactNode; body?: React.ReactNode; tone?: "neutral" | "brand" | "met" | "notmet" | "insufficient" }[] }) {
  return (
    <ol className="relative grid gap-0">
      {items.map((it, i) => (
        <li key={it.id} className="relative grid grid-cols-[28px_1fr] gap-3 pb-5 last:pb-0">
          {i < items.length - 1 ? <span className="absolute left-[13.5px] top-7 h-[calc(100%-22px)] w-px bg-border" aria-hidden /> : null}
          <span
            className={cn(
              "z-[1] mt-0.5 flex size-7 items-center justify-center rounded-full border bg-surface [&_svg]:size-3.5",
              it.tone === "brand" && "border-brand/30 text-brand",
              it.tone === "met" && "border-met/30 text-met",
              it.tone === "notmet" && "border-notmet/30 text-notmet",
              it.tone === "insufficient" && "border-insufficient/30 text-insufficient",
              (!it.tone || it.tone === "neutral") && "border-border text-subtle",
            )}
          >
            {it.icon}
          </span>
          <div className="min-w-0 pt-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <p className="text-[13px] text-fg">{it.title}</p>
              {it.meta ? <span className="text-xs text-subtle">{it.meta}</span> : null}
            </div>
            {it.body ? <div className="mt-1.5 text-[13px] text-muted">{it.body}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ── Diff viewer ────────────────────────────────────────────────────────── */
export function DiffViewer({ hunks, className }: { hunks: DiffHunk[]; className?: string }) {
  return (
    <p className={cn("whitespace-pre-wrap text-[13px] leading-relaxed text-fg", className)}>
      {hunks.map((h, i) =>
        h.op === "equal" ? (
          <span key={i}>{h.text}</span>
        ) : h.op === "insert" ? (
          <ins key={i} className="rounded-[3px] bg-met-soft px-0.5 text-met-fg no-underline decoration-met/50">
            {h.text}
          </ins>
        ) : (
          <del key={i} className="rounded-[3px] bg-notmet-soft px-0.5 text-notmet-fg decoration-notmet/60">
            {h.text}
          </del>
        ),
      )}
    </p>
  );
}

/* ── Split pane (resizable, keyboard accessible) ────────────────────────── */
export function SplitPane({ left, right, initial = 0.5, min = 0.25, className }: { left: React.ReactNode; right: React.ReactNode; initial?: number; min?: number; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = React.useState(initial);
  const dragging = React.useRef(false);
  React.useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current || !ref.current) return;
      const r = ref.current.getBoundingClientRect();
      setRatio(Math.min(1 - min, Math.max(min, (e.clientX - r.left) / r.width)));
    };
    const up = () => (dragging.current = false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [min]);
  return (
    <div ref={ref} className={cn("flex min-h-0 flex-col lg:flex-row", className)}>
      <div className="min-h-0 min-w-0 lg:basis-[var(--split)]" style={{ "--split": `${ratio * 100}%` } as React.CSSProperties}>
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={min * 100}
        aria-valuemax={(1 - min) * 100}
        tabIndex={0}
        onPointerDown={() => (dragging.current = true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setRatio((r) => Math.max(min, r - 0.04));
          if (e.key === "ArrowRight") setRatio((r) => Math.min(1 - min, r + 0.04));
        }}
        className="group hidden w-3 shrink-0 cursor-col-resize items-center justify-center outline-none lg:flex"
      >
        <span className="flex h-10 w-1.5 items-center justify-center rounded-full bg-border text-subtle transition-colors group-hover:bg-border-strong group-focus-visible:bg-brand">
          <GripVertical className="size-3 opacity-0 group-hover:opacity-100" />
        </span>
      </div>
      <div className="min-h-0 min-w-0 flex-1">{right}</div>
    </div>
  );
}

/* ── File dropzone ──────────────────────────────────────────────────────── */
export function Dropzone({ onFiles, accept, multiple = true, className, hint }: { onFiles: (files: File[]) => void; accept?: string; multiple?: boolean; className?: string; hint?: string }) {
  const [over, setOver] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") input.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface-2/40 px-4 py-8 text-center outline-none transition-colors hover:border-brand/60 hover:bg-brand-soft/30 focus-visible:border-brand",
        over && "border-brand bg-brand-soft/40",
        className,
      )}
    >
      <span className="flex size-9 items-center justify-center rounded-full bg-surface text-brand shadow-e1">
        <FileUp className="size-4" />
      </span>
      <div className="grid gap-0.5">
        <p className="text-[13px] font-medium text-fg">
          Drop files here or <span className="text-brand">browse</span>
        </p>
        <p className="text-xs text-muted">{hint ?? "PDF, text or EHR export · up to 20 MB · scanned faxes are read automatically"}</p>
      </div>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
