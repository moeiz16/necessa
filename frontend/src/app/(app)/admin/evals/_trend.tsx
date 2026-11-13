"use client";

import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Row = { date: string; value: number };

export function GatedTrend({ data, gate, op, lowerIsBetter, height = 260 }: { data: Row[]; gate?: number; op?: string; lowerIsBetter?: boolean; height?: number }) {
  const values = data.map((d) => d.value).concat(gate != null ? [gate] : []);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(0.01, (max - min) * 0.25);
  const domain: [number, number] = [Math.max(0, +(min - pad).toFixed(3)), Math.min(1, +(max + pad).toFixed(3))];
  const color = "var(--brand)";
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 12, right: 12, left: -6, bottom: 0 }}>
        <defs>
          <linearGradient id="gate-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.2} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="date" stroke="var(--fg-subtle)" fontSize={11} tickLine={false} axisLine={false} minTickGap={20} />
        <YAxis domain={domain} stroke="var(--fg-subtle)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v: number) => v.toFixed(2)} width={44} />
        <Tooltip
          cursor={{ stroke: "var(--border-strong)" }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-e3">
                <p className="font-medium text-fg">{String(label)}</p>
                <p className="tabular text-muted">
                  {Number(payload[0]!.value).toFixed(3)}
                  {gate != null ? ` · gate ${op} ${gate}` : ""}
                </p>
              </div>
            ) : null
          }
        />
        {gate != null ? (
          <ReferenceLine
            y={gate}
            stroke={lowerIsBetter ? "var(--notmet)" : "var(--insufficient)"}
            strokeDasharray="5 4"
            label={{ value: `gate ${op} ${gate}`, position: "insideTopRight", fill: "var(--fg-subtle)", fontSize: 11 }}
          />
        ) : null}
        <Area type="monotoneX" dataKey="value" stroke="none" fill="url(#gate-fill)" />
        <Line type="monotoneX" dataKey="value" stroke={color} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: color }} activeDot={{ r: 4 }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
