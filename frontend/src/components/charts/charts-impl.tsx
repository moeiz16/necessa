"use client";

/** Recharts implementations — import via `./charts` (lazy-loaded), never directly from pages. */

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import type { SqlResult } from "@/lib/api/types";
import { fmtNumber, titleCase } from "@/lib/format";
import { SERIES } from "./series";

const AXIS = { stroke: "var(--fg-subtle)", fontSize: 11, tickLine: false, axisLine: false } as const;

function ChartTooltip({ active, payload, label, format }: TooltipProps<number, string> & { format?: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-e3">
      {label !== undefined ? <p className="mb-1 font-medium text-fg">{String(label)}</p> : null}
      {payload.map((p) => (
        <p key={String(p.dataKey)} className="flex items-center gap-2 text-muted">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          {titleCase(String(p.name ?? p.dataKey))}
          <span className="tabular ml-auto pl-3 font-medium text-fg">{format ? format(Number(p.value)) : fmtNumber(Number(p.value))}</span>
        </p>
      ))}
    </div>
  );
}

export function AreaTrend({ data, x, y, height = 220, color = "var(--brand)", format }: { data: Record<string, unknown>[]; x: string; y: string; height?: number; color?: string; format?: (v: number) => string }) {
  const id = `g-${y}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.26} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey={x} {...AXIS} minTickGap={24} tickFormatter={(v: string) => (v.length === 10 ? v.slice(5) : v)} />
        <YAxis {...AXIS} allowDecimals={false} tickFormatter={(v: number) => (format ? format(v) : fmtNumber(v, { notation: "compact" }))} />
        <RTooltip content={<ChartTooltip format={format} />} cursor={{ stroke: "var(--border-strong)" }} />
        <Area type="monotone" dataKey={y} stroke={color} strokeWidth={2} fill={`url(#${id})`} activeDot={{ r: 4, strokeWidth: 0 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function LineTrend({ data, x, series, height = 220, format, domain }: { data: Record<string, unknown>[]; x: string; series: { key: string; label?: string; color?: string }[]; height?: number; format?: (v: number) => string; domain?: [number, number] }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey={x} {...AXIS} minTickGap={20} />
        <YAxis {...AXIS} domain={domain ?? ["auto", "auto"]} tickFormatter={(v: number) => (format ? format(v) : String(v))} />
        <RTooltip content={<ChartTooltip format={format} />} cursor={{ stroke: "var(--border-strong)" }} />
        {series.map((s, i) => (
          <Line key={s.key} name={s.label ?? s.key} type="monotone" dataKey={s.key} stroke={s.color ?? SERIES[i % SERIES.length]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function StackedBars({ data, x, series, height = 220 }: { data: Record<string, unknown>[]; x: string; series: { key: string; label: string; color: string }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="28%">
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey={x} {...AXIS} />
        <YAxis {...AXIS} allowDecimals={false} />
        <RTooltip content={<ChartTooltip />} cursor={{ fill: "var(--surface-2)" }} />
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color} radius={i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Bars({ data, x, y, height = 220, color = "var(--brand)", horizontal }: { data: Record<string, unknown>[]; x: string; y: string; height?: number; color?: string; horizontal?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={horizontal ? "vertical" : "horizontal"} margin={{ top: 8, right: 12, left: horizontal ? 8 : -18, bottom: 0 }}>
        <CartesianGrid horizontal={!horizontal} vertical={!!horizontal} stroke="var(--border)" strokeDasharray="3 3" />
        {horizontal ? (
          <>
            <XAxis type="number" {...AXIS} allowDecimals={false} />
            <YAxis type="category" dataKey={x} {...AXIS} width={140} tickFormatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : titleCase(v))} />
          </>
        ) : (
          <>
            <XAxis dataKey={x} {...AXIS} tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : titleCase(v))} />
            <YAxis {...AXIS} allowDecimals={false} />
          </>
        )}
        <RTooltip content={<ChartTooltip />} cursor={{ fill: "var(--surface-2)" }} />
        <Bar dataKey={y} fill={color} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Donut({ data, nameKey, valueKey, height = 200, colors = SERIES, center }: { data: Record<string, unknown>[]; nameKey: string; valueKey: string; height?: number; colors?: string[]; center?: React.ReactNode }) {
  const total = data.reduce((a, d) => a + Number(d[valueKey] ?? 0), 0);
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <RTooltip content={<ChartTooltip />} />
          <Pie data={data} dataKey={valueKey} nameKey={nameKey} innerRadius="62%" outerRadius="88%" paddingAngle={2} stroke="none">
            {data.map((_, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">{center ?? <span className="tabular text-xl font-semibold">{fmtNumber(total)}</span>}</div>
    </div>
  );
}

export function SqlChart({ result, height = 220 }: { result: SqlResult; height?: number }) {
  const hint = result.chartHint;
  if (!hint || hint.type === "table" || !hint.x || !hint.y || result.rows.length < 2) return null;
  const xi = result.columns.indexOf(hint.x);
  const yi = result.columns.indexOf(hint.y);
  if (xi < 0 || yi < 0) return null;
  const data = result.rows.map((r) => ({ [hint.x!]: String(r[xi]), [hint.y!]: Number(r[yi]) }));
  if (hint.type === "line") return <LineTrend data={data} x={hint.x} series={[{ key: hint.y }]} height={height} />;
  if (hint.type === "pie") return <Donut data={data} nameKey={hint.x} valueKey={hint.y} height={height} />;
  const long = data.some((d) => String(d[hint.x!]).length > 16);
  return <Bars data={data} x={hint.x} y={hint.y} height={height} horizontal={long} />;
}
