"use client";

import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtNumber, titleCase } from "@/lib/format";

const AXIS = { stroke: "var(--fg-subtle)", fontSize: 11, tickLine: false, axisLine: false } as const;
export const PALETTE = ["var(--brand)", "var(--ai-3)", "var(--ai-2)", "var(--insufficient)", "var(--met)", "var(--notmet)"];

type TipProps = { active?: boolean; payload?: { name?: string; value?: number; color?: string; dataKey?: string | number }[]; label?: string | number };
function Tip({ active, payload, label }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-e3">
      {label !== undefined ? <p className="mb-1 font-medium text-fg">{String(label)}</p> : null}
      {payload.map((p) => (
        <p key={String(p.dataKey ?? p.name)} className="flex items-center gap-2 text-muted">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          {titleCase(String(p.name ?? p.dataKey))}
          <span className="tabular ml-auto pl-3 font-medium text-fg">{fmtNumber(Number(p.value), { maximumFractionDigits: 1 })}</span>
        </p>
      ))}
    </div>
  );
}

/** Daily volume as bars with a trailing 7-day mean — bars never imply values that weren't observed. */
export function VolumeChart({ data, height = 230 }: { data: { date: string; count: number }[]; height?: number }) {
  const rows = data.map((d, i) => {
    const win = data.slice(Math.max(0, i - 6), i + 1);
    return { ...d, label: d.date.slice(5), avg: win.reduce((a, x) => a + x.count, 0) / win.length };
  });
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="label" {...AXIS} minTickGap={22} />
        <YAxis {...AXIS} allowDecimals={false} />
        <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
        <Bar dataKey="count" name="New cases" fill="var(--brand)" fillOpacity={0.28} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive />
        <Line dataKey="avg" name="7-day average" type="monotoneX" stroke="var(--brand)" strokeWidth={2} dot={false} activeDot={{ r: 3.5 }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function ReadinessChart({ data, height = 230 }: { data: { week: string; ready: number; gaps: number; notSupported: number }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="30%">
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="week" {...AXIS} />
        <YAxis {...AXIS} allowDecimals={false} />
        <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
        <Bar dataKey="ready" name="Ready" stackId="r" fill="var(--met)" />
        <Bar dataKey="gaps" name="Gaps" stackId="r" fill="var(--insufficient)" />
        <Bar dataKey="notSupported" name="Not supported" stackId="r" fill="var(--notmet)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DonutChart({ data, height = 150 }: { data: { name: string; value: number }[]; height?: number }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip content={<Tip />} />
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="92%" paddingAngle={2} stroke="none">
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="tabular text-xl font-semibold text-fg">{fmtNumber(total)}</span>
        <span className="text-[10px] uppercase tracking-wider text-subtle">denials</span>
      </div>
    </div>
  );
}
