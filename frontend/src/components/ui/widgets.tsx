"use client";

import { FileUp, GripVertical, TrendingDown, TrendingUp } from "lucide-react";
import * as React from "react";
import type { DiffHunk } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/* ── Sparkline (pure SVG, no chart lib) ─────────────────────────────────── */
export function Sparkline({ values, className, tone = "brand", height = 28, width = 96, fill = true }: { values: number[]; className?: string; tone?: "brand" | "met" | "notmet" | "insufficient"; height?: number; width?: number; fill?: boolean }) {
  const id = React.useId();
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * width, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const color = `var(--${tone === "brand" ? "brand" : tone})`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn("overflow-visible", className)} aria-hidden>
      {fill ? (
        <>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.22" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
        </>
      ) : null}
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1]![0]} cy={pts[pts.length - 1]![1]} r="2.2" fill={color} />
    </svg>
  );
}

/* ── Stat card ──────────────────────────────────────────────────────────── */
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
}: {
  label: string;
  value: React.ReactNode;
  delta?: number;
  deltaLabel?: string;
  goodWhen?: "up" | "down";
  spark?: number[];
  icon?: React.ReactNode;
  className?: string;
  hint?: string;
}) {
  const good = delta === undefined ? null : goodWhen === "up" ? delta >= 0 : delta <= 0;
  return (
    <div className={cn("flex flex-col justify-between gap-3 rounded-xl bg-surface p-4 shadow-e1", className)} title={hint}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {icon ? <span className="text-subtle [&_svg]:size-4">{icon}</span> : null}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="grid gap-1">
          <span className="tabular text-[26px] font-semibold leading-none tracking-[-0.03em] text-fg">{value}</span>
          {delta !== undefined ? (
            <span className={cn("inline-flex items-center gap-1 text-xs font-medium", good ? "text-met-fg" : "text-notmet-fg")}>
              {delta >= 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
              {delta > 0 ? "+" : ""}
              {delta}
              {deltaLabel ? <span className="font-normal text-subtle">{deltaLabel}</span> : null}
            </span>
          ) : null}
        </div>
        {spark ? <Sparkline values={spark} tone={good === false ? "notmet" : "brand"} /> : null}
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
        <p className="text-xs text-muted">{hint ?? "PDF, TXT or FHIR R4 JSON · up to 20 MB · scanned faxes are OCR’d"}</p>
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
