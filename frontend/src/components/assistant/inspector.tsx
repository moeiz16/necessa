"use client";

import { CircleSlash, Filter, Gauge, Layers, Route, Timer, TriangleAlert, Wand2 } from "lucide-react";
import type { RetrievalChunk, RouteTrace, StageScores } from "@/lib/api/types";
import { fmtMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge, SectionLabel } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Tooltip } from "@/components/ui/overlays";

/** Plain-language names for the retrieval strategy matrix (docs/ARCHITECTURE.md §6.2). */
export const STRATEGY_NAME: Record<string, string> = {
  S1: "Exact identifier",
  S2: "Coverage facts (tools/graph)",
  S3: "Analytics (text-to-SQL)",
  S4: "Hybrid + rerank",
  S5: "Lay language (expanded)",
  S6: "Keyword-weighted",
  S7: "Chart evidence",
  S8: "Multi-hop",
  S9: "Version comparison",
  S10: "Denial → criteria",
  S11: "Out of scope · abstain",
};
export function strategyLabel(strategy?: string | null) {
  if (!strategy) return "—";
  const code = /S\d{1,2}/.exec(strategy)?.[0];
  return code && STRATEGY_NAME[code] ? `${code} · ${STRATEGY_NAME[code]}` : strategy;
}

const STAGES: { key: keyof StageScores; label: string; max: number; color: string }[] = [
  { key: "dense", label: "Dense", max: 1, color: "var(--ai-1)" },
  { key: "sparse", label: "Sparse", max: 1, color: "var(--ai-3)" },
  { key: "bm25", label: "BM25", max: 20, color: "var(--insufficient)" },
  { key: "fused", label: "RRF", max: 1, color: "var(--ai-2)" },
  { key: "rerank", label: "Rerank", max: 1, color: "var(--met)" },
];

function ScoreBars({ scores }: { scores: StageScores }) {
  return (
    <div className="grid grid-cols-5 gap-1">
      {STAGES.map((s) => {
        const v = scores[s.key];
        return (
          <Tooltip key={s.key} content={`${s.label}: ${v ?? "—"}`}>
            <div className="grid gap-0.5">
              <div className="h-1 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full" style={{ width: `${v == null ? 0 : Math.min(1, v / s.max) * 100}%`, background: s.color }} />
              </div>
              <span className="text-center text-[9px] uppercase tracking-wide text-subtle">{s.label}</span>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function RetrievalInspector({ route, chunks, timings, className }: { route?: RouteTrace | null; chunks?: RetrievalChunk[]; timings?: Record<string, number>; className?: string }) {
  if (!route) return <EmptyState compact art="search" title="Select an answer" description="The route, filters and per-stage scores behind each answer appear here." className={className} />;
  const total = timings ? Object.values(timings).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className={cn("grid gap-5", className)}>
      <div className="grid gap-2">
        <SectionLabel>Route</SectionLabel>
        <div className="rounded-lg border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="brand">
              <Route /> {strategyLabel(route.strategy)}
            </Badge>
            <span className="text-xs text-muted">
              intent <span className="font-mono text-fg">{route.intent}</span> · {Math.round(route.confidence * 100)}%
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">{route.reason}</p>
          {route.abstained ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-insufficient-fg">
              <CircleSlash className="size-3.5" /> Abstained — confidence below the calibrated threshold
            </p>
          ) : null}
          {route.degraded?.length ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-degraded-fg">
              <TriangleAlert className="size-3.5" /> Degraded: {route.degraded.join(", ")}
            </p>
          ) : null}
        </div>
      </div>

      <div className="grid gap-2">
        <SectionLabel>Flow</SectionLabel>
        <ol className="flex flex-wrap items-center gap-1 text-[11px]" aria-label="Retrieval pipeline">
          {[
            { k: "Understand", on: true },
            ...(route.retrievers?.length ? route.retrievers : ["retrieve"]).map((r) => ({ k: r, on: !route.degraded?.includes(r) })),
            { k: route.fusion ? "Fuse" : "Fuse", on: !!route.fusion },
            { k: "Rerank", on: !!route.rerank && !route.degraded?.includes("rerank") },
            { k: route.abstained ? "Abstain" : "Answer", on: true },
          ].map((step, i, arr) => (
            <li key={`${step.k}-${i}`} className="flex items-center gap-1">
              <span className={cn("rounded-md px-1.5 py-0.5 font-medium ring-1 ring-inset", step.on ? "bg-brand-soft text-brand-fg ring-brand/20" : "bg-surface-2 text-subtle line-through ring-border")}>{step.k}</span>
              {i < arr.length - 1 ? <span className="text-subtle">→</span> : null}
            </li>
          ))}
        </ol>
      </div>

      <div className="grid gap-2">
        <SectionLabel>Pipeline</SectionLabel>
        <dl className="grid gap-1.5 text-xs">
          {[
            { icon: Wand2, k: "Transforms", v: route.transforms.length ? route.transforms.join(" → ") : "none" },
            { icon: Filter, k: "Filters", v: Object.entries(route.filters ?? {}).filter(([, v]) => (Array.isArray(v) ? v.length : v)).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(" · ") || "none" },
            { icon: Layers, k: "Retrievers", v: route.retrievers?.join(" + ") || "—" },
            { icon: Gauge, k: "Fusion → rerank", v: `${route.fusion ?? "—"} → ${route.rerank ?? "—"}` },
            { icon: Route, k: "Corrective passes", v: String(route.correctiveIterations ?? 0) },
          ].map((row) => (
            <div key={row.k} className="grid grid-cols-[18px_96px_1fr] items-baseline gap-2">
              <row.icon className="size-3.5 translate-y-0.5 text-subtle" />
              <dt className="text-subtle">{row.k}</dt>
              <dd className="break-words font-mono text-[11px] text-fg">{row.v}</dd>
            </div>
          ))}
        </dl>
      </div>

      {timings && total ? (
        <div className="grid gap-2">
          <SectionLabel action={<span className="tabular text-xs text-muted">{fmtMs(total)}</span>}>
            <span className="flex items-center gap-1.5">
              <Timer className="size-3" /> Latency
            </span>
          </SectionLabel>
          <div className="flex h-2 overflow-hidden rounded-full bg-surface-3">
            {Object.entries(timings).map(([k, v], i) => (
              <Tooltip key={k} content={`${k.replace(/Ms$/, "")}: ${fmtMs(v)}`}>
                <div style={{ width: `${(v / total) * 100}%`, background: ["var(--ai-1)", "var(--ai-3)", "var(--met)"][i % 3] }} />
              </Tooltip>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 text-[11px] text-muted">
            {Object.entries(timings).map(([k, v]) => (
              <span key={k}>
                {k.replace(/Ms$/, "")} <span className="tabular text-fg">{fmtMs(v)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {chunks?.length ? (
        <div className="grid gap-2">
          <SectionLabel>Retrieved passages · top {chunks.length}</SectionLabel>
          <ol className="grid gap-2">
            {chunks.map((c, i) => (
              <li key={c.chunkId} className="rounded-lg border border-border bg-surface p-2.5">
                <div className="flex items-center gap-2">
                  <span className="tabular font-mono text-[11px] text-subtle">#{i + 1}</span>
                  <span className="font-mono text-xs font-medium text-fg">{c.sourceKey}</span>
                  <span className="truncate text-[11px] text-muted">{c.sectionKey.replace(/_/g, " ")}</span>
                  <span className="tabular ml-auto text-xs font-medium text-fg">{c.score.toFixed(2)}</span>
                </div>
                {c.text || (c as { snippet?: string }).snippet ? <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted">{c.text ?? (c as { snippet?: string }).snippet}</p> : null}
                <div className="mt-2">
                  <ScoreBars scores={c.scores} />
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
