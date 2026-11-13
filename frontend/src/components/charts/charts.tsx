"use client";

/**
 * Chart API. Recharts (~170 kB) is code-split: each chart reserves its exact height immediately and
 * renders a quiet skeleton until the library loads, so pages paint fast with zero layout shift.
 * `Legend`, `RankList` and `SERIES` are dependency-free and render instantly.
 */
import dynamic from "next/dynamic";
import type * as React from "react";
import type { SqlResult } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { SERIES } from "./series";

export { SERIES };

function ChartSkeleton() {
  return (
    <div className="flex h-full w-full items-end gap-1.5 px-2 pb-6 pt-4" aria-hidden>
      {[38, 52, 44, 66, 58, 72, 64, 80, 70].map((h, i) => (
        <span key={i} className="skeleton flex-1 rounded-t-[3px]" style={{ height: `${h}%`, opacity: 0.55 }} />
      ))}
    </div>
  );
}

const AreaTrendImpl = dynamic(() => import("./charts-impl").then((m) => m.AreaTrend), { ssr: false, loading: ChartSkeleton });
const LineTrendImpl = dynamic(() => import("./charts-impl").then((m) => m.LineTrend), { ssr: false, loading: ChartSkeleton });
const StackedBarsImpl = dynamic(() => import("./charts-impl").then((m) => m.StackedBars), { ssr: false, loading: ChartSkeleton });
const BarsImpl = dynamic(() => import("./charts-impl").then((m) => m.Bars), { ssr: false, loading: ChartSkeleton });
const DonutImpl = dynamic(() => import("./charts-impl").then((m) => m.Donut), { ssr: false, loading: ChartSkeleton });
const SqlChartImpl = dynamic(() => import("./charts-impl").then((m) => m.SqlChart), { ssr: false, loading: ChartSkeleton });

type Row = Record<string, unknown>;

function Frame({ height, children }: { height: number; children: React.ReactNode }) {
  return <div style={{ height }} className="w-full min-w-0">{children}</div>;
}

export function AreaTrend(props: { data: Row[]; x: string; y: string; height?: number; color?: string; format?: (v: number) => string }) {
  return (
    <Frame height={props.height ?? 220}>
      <AreaTrendImpl {...props} />
    </Frame>
  );
}

export function LineTrend(props: { data: Row[]; x: string; series: { key: string; label?: string; color?: string }[]; height?: number; format?: (v: number) => string; domain?: [number, number] }) {
  return (
    <Frame height={props.height ?? 220}>
      <LineTrendImpl {...props} />
    </Frame>
  );
}

export function StackedBars(props: { data: Row[]; x: string; series: { key: string; label: string; color: string }[]; height?: number }) {
  return (
    <Frame height={props.height ?? 220}>
      <StackedBarsImpl {...props} />
    </Frame>
  );
}

export function Bars(props: { data: Row[]; x: string; y: string; height?: number; color?: string; horizontal?: boolean }) {
  return (
    <Frame height={props.height ?? 220}>
      <BarsImpl {...props} />
    </Frame>
  );
}

export function Donut(props: { data: Row[]; nameKey: string; valueKey: string; height?: number; colors?: string[]; center?: React.ReactNode }) {
  return (
    <Frame height={props.height ?? 200}>
      <DonutImpl {...props} />
    </Frame>
  );
}

export function SqlChart({ result, height = 220 }: { result: SqlResult; height?: number }) {
  const hint = result.chartHint;
  if (!hint || hint.type === "table" || !hint.x || !hint.y || result.rows.length < 2) return null;
  return (
    <Frame height={height}>
      <SqlChartImpl result={result} height={height} />
    </Frame>
  );
}

export function Legend({ items, className }: { items: { label: string; color: string; value?: React.ReactNode }[]; className?: string }) {
  return (
    <ul className={cn("grid gap-1.5", className)}>
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-2 text-xs text-muted">
          <span className="size-2 shrink-0 rounded-full" style={{ background: i.color }} />
          <span className="min-w-0 flex-1 truncate">{i.label}</span>
          {i.value !== undefined ? <span className="tabular font-medium text-fg">{i.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Ranked horizontal meter list — denser than a bar chart for long labels. */
export function RankList({ items, max, color = "var(--insufficient)" }: { items: { label: string; value: number }[]; max?: number; color?: string }) {
  const m = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="grid gap-3">
      {items.map((i) => (
        <li key={i.label} className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate text-fg">{i.label}</span>
            <span className="tabular shrink-0 text-xs font-medium text-muted">{i.value}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full" style={{ width: `${(i.value / m) * 100}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

