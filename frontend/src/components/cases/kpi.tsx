"use client";

/**
 * Dashboard KPI tile with explicit semantics: a *trend* (arrow, judged good/bad by `goodWhen`) is kept
 * separate from a plain *note* ("3 due within 24 h"), so counts are never dressed up as trends.
 */
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { CountUp } from "@/components/ui/motion";
import { Tooltip } from "@/components/ui/overlays";
import { Sparkline } from "@/components/ui/widgets";

export function KpiTile({
  label,
  value,
  format,
  icon,
  trend,
  note,
  spark,
  hint,
  className,
}: {
  label: string;
  value: number;
  format?: (n: number) => string;
  icon?: React.ReactNode;
  trend?: { delta: number; label: string; goodWhen: "up" | "down"; format?: (n: number) => string };
  note?: { text: React.ReactNode; tone?: "neutral" | "warn" | "good" };
  spark?: number[];
  hint?: string;
  className?: string;
}) {
  const good = trend ? (trend.goodWhen === "up" ? trend.delta >= 0 : trend.delta <= 0) : null;
  const Arrow = !trend ? ArrowRight : trend.delta > 0 ? ArrowUpRight : trend.delta < 0 ? ArrowDownRight : ArrowRight;
  const body = (
    <div className={cn("group flex h-full flex-col justify-between gap-3 rounded-xl bg-surface p-4 shadow-e1 transition-shadow duration-200 hover:shadow-e2", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {icon ? <span className="text-subtle transition-colors group-hover:text-muted [&_svg]:size-4">{icon}</span> : null}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="grid min-w-0 gap-1.5">
          <span className="text-[26px] font-semibold leading-none tracking-[-0.03em] text-fg">
            <CountUp value={value} format={format} />
          </span>
          {trend ? (
            <span className={cn("inline-flex items-center gap-1 text-xs font-medium", good ? "text-met-fg" : "text-insufficient-fg")}>
              <Arrow className="size-3.5" />
              <span className="tabular">
                {trend.delta > 0 ? "+" : ""}
                {trend.format ? trend.format(trend.delta) : trend.delta}
              </span>
              <span className="truncate font-normal text-subtle">{trend.label}</span>
              <span className="sr-only">{good ? "(better)" : "(worse)"}</span>
            </span>
          ) : null}
          {note ? (
            <span className={cn("truncate text-xs", note.tone === "warn" ? "font-medium text-insufficient-fg" : note.tone === "good" ? "text-met-fg" : "text-subtle")}>{note.text}</span>
          ) : null}
        </div>
        {spark && spark.length > 1 ? <Sparkline values={spark} tone="brand" width={72} className="shrink-0" /> : null}
      </div>
    </div>
  );
  return hint ? <Tooltip content={hint}>{body}</Tooltip> : body;
}

/** 7-point moving average so daily noise doesn't read as volatility in a 96px sparkline. */
export function smooth(values: number[], window = 7) {
  if (values.length <= window) return values;
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}
