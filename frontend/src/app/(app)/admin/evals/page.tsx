"use client";

import { CircleCheck, CircleX, FlaskConical, GitCommit, Loader2, Play, ShieldAlert, TrendingDown, TrendingUp } from "lucide-react";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { useEvalRuns, useStartEval } from "@/lib/api/hooks";
import type { EvalRun } from "@/lib/api/types";
import { fmtDate, fmtRelative, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Skeleton } from "@/components/ui/display";

const SUITES: { id: EvalRun["suite"]; label: string; description: string; primary: string }[] = [
  { id: "retrieval", label: "Retrieval", description: "Recall@K, MRR, nDCG on the policy Q&A gold set (stratified by S1–S11)", primary: "recall@10" },
  { id: "verdicts", label: "Verdicts", description: "Criterion verdicts on counterfactual synthetic cases — false-met is the north-star safety metric", primary: "false_met_rate" },
  { id: "sql", label: "Text-to-SQL", description: "Execution accuracy on NL→SQL gold pairs over analytics views", primary: "execution_accuracy" },
  { id: "faithfulness", label: "Faithfulness", description: "Groundedness and citation precision (LLM judge from a different family, κ-calibrated)", primary: "faithfulness" },
  { id: "safety", label: "Safety", description: "Prompt-injection block rate, PHI leakage (must be 0) and refusal correctness", primary: "phi_leak_rate" },
];

const GatedTrend = dynamic(() => import("./_trend").then((m) => m.GatedTrend), { ssr: false, loading: () => <Skeleton className="h-[260px]" /> });

const LOWER_IS_BETTER = new Set(["false_met_rate", "phi_leak_rate", "ece"]);
const fmtMetric = (v?: number) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(3));

/** Per-intent retrieval quality: the API nests `by_intent`; older runs flatten as `intent.S1`. */
function intentBreakdown(run?: EvalRun): { intent: string; value: number; n?: number }[] {
  if (!run) return [];
  const nested = (run.metrics as unknown as Record<string, unknown>).by_intent as Record<string, { n?: number; "hit@10"?: number }> | undefined;
  if (nested && typeof nested === "object") return Object.entries(nested).map(([intent, v]) => ({ intent, value: v["hit@10"] ?? 0, n: v.n }));
  return Object.entries(run.metrics)
    .filter(([k]) => k.startsWith("intent."))
    .map(([k, v]) => ({ intent: k.slice(7), value: v }));
}

const INTENT_LABEL: Record<string, string> = {
  S1: "Exact identifier",
  S2: "Coverage facts (SQL/graph)",
  S3: "Analytics (text-to-SQL)",
  S4: "Conceptual policy",
  S5: "Lay language",
  S6: "Rare terms",
  S7: "Chart evidence",
  S8: "Multi-hop",
  S9: "Version diff",
  S10: "Denial → criteria",
  S11: "Out of scope (abstain)",
};

export default function EvalsPage() {
  const runs = useEvalRuns();
  const start = useStartEval();
  const [suite, setSuite] = useState<EvalRun["suite"]>("verdicts");
  const meta = SUITES.find((s) => s.id === suite)!;
  const suiteRuns = useMemo(() => (runs.data ?? []).filter((r) => r.suite === suite).sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [runs.data, suite]);
  const latest = suiteRuns[suiteRuns.length - 1];
  const metricKeys = latest ? Object.keys(latest.metrics).filter((k) => !k.startsWith("intent.") && typeof latest.metrics[k] === "number") : [];
  const latestBySuite = SUITES.map((s) => (runs.data ?? []).filter((r) => r.suite === s.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]);

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Administration" }, { label: "Evaluations" }]} />} wide>
      <PageHeader
        title="Evaluations"
        description="Quality is measured, not assumed. Deterministic retrieval evals gate every pull request; full LLM evals run nightly against the release gates below."
        actions={
          <Button variant="primary" onClick={() => start.mutate(suite)} loading={start.isPending}>
            <Play /> Run {meta.label.toLowerCase()} eval
          </Button>
        }
      />

      <div className="mb-5 grid gap-3 md:grid-cols-5">
        {SUITES.map((s, i) => {
          const r = latestBySuite[i];
          const gate = r?.gates?.[0];
          return (
            <button key={s.id} onClick={() => setSuite(s.id)} className={cn("grid gap-2 rounded-xl bg-surface p-4 text-left shadow-e1 transition-shadow hover:shadow-e2", suite === s.id && "shadow-[0_0_0_1.5px_var(--brand)]")}>
              <span className="flex items-center justify-between text-xs font-medium text-muted">
                {s.label}
                {r?.status === "running" ? <Loader2 className="size-3.5 animate-spin text-brand" /> : gate ? gate.passed ? <CircleCheck className="size-3.5 text-met" /> : <CircleX className="size-3.5 text-notmet" /> : null}
              </span>
              <span className="tabular text-2xl font-semibold tracking-tight text-fg">{r ? fmtMetric(r.metrics[s.primary]) : "—"}</span>
              <span className="font-mono text-[11px] text-subtle">
                {s.primary}
                {gate ? ` · gate ${gate.op} ${gate.threshold}` : ""}
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader
            title={`${meta.label} · ${meta.primary}`}
            description={meta.description}
            icon={suite === "verdicts" ? <ShieldAlert className="text-notmet" /> : <FlaskConical />}
          />
          <CardBody className="grid gap-4">
            {runs.isPending ? (
              <Skeleton className="h-[260px]" />
            ) : (
              <GatedTrend
                data={suiteRuns.filter((r) => r.status === "succeeded").map((r) => ({ date: fmtDate(r.startedAt, "MMM d"), value: r.metrics[meta.primary] ?? 0 }))}
                gate={latest?.gates?.find((g) => g.metric === meta.primary)?.threshold}
                op={latest?.gates?.find((g) => g.metric === meta.primary)?.op}
                lowerIsBetter={LOWER_IS_BETTER.has(meta.primary)}
              />
            )}
            {latest ? (
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {metricKeys
                  .filter((k) => typeof latest.metrics[k] === "number")
                  .map((k) => {
                    const prev = suiteRuns[suiteRuns.length - 2]?.metrics[k];
                    const d = prev != null ? latest.metrics[k]! - prev : null;
                    const good = d == null ? null : LOWER_IS_BETTER.has(k) ? d <= 0 : d >= 0;
                    return (
                      <div key={k} className={cn("grid gap-0.5 rounded-lg border p-2.5", k === "false_met_rate" ? "border-notmet/30 bg-notmet-soft/20" : "border-border")}>
                        <span className="truncate font-mono text-[11px] text-subtle">{k}</span>
                        <span className="tabular text-[15px] font-semibold text-fg">{fmtMetric(latest.metrics[k])}</span>
                        {d != null && Math.abs(d) >= 0.0005 ? (
                          <span className={cn("flex items-center gap-1 text-[11px]", good ? "text-met-fg" : "text-notmet-fg")}>
                            {d > 0 ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
                            {d > 0 ? "+" : ""}
                            {d.toFixed(3)} vs prev
                          </span>
                        ) : (
                          <span className="text-[11px] text-subtle">no change</span>
                        )}
                      </div>
                    );
                  })}
              </div>
            ) : null}
            {suite === "verdicts" ? (
              <p className="flex items-start gap-2 rounded-lg bg-surface-2/60 p-2.5 text-xs leading-relaxed text-muted">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-notmet" />
                <span>
                  <span className="font-medium text-fg">False-met is the north-star safety metric.</span> It counts criteria judged met when the ground truth is not met or undocumented — the error that turns into a denial or an unsupported claim. It gates every release.
                </span>
              </p>
            ) : null}
            {suite === "retrieval" && intentBreakdown(latest).length ? (
              <div className="grid gap-2">
                <p className="text-xs font-medium text-fg">hit@10 by query intent</p>
                {intentBreakdown(latest).map((x) => (
                  <div key={x.intent} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_40px] items-center gap-3 text-xs sm:grid-cols-[200px_1fr_48px]">
                    <span className="truncate text-muted">
                      <span className="font-mono text-fg">{x.intent}</span> {INTENT_LABEL[x.intent] ?? ""}
                    </span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <span className={cn("block h-full rounded-full", x.value >= 0.9 ? "bg-met" : x.value >= 0.7 ? "bg-insufficient" : "bg-notmet")} style={{ width: `${x.value * 100}%` }} />
                    </span>
                    <span className="tabular text-right text-muted">{x.value.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Release gates" description="A release ships only if every gate passes" />
          <CardBody className="grid gap-2">
            {latestBySuite.map((r, i) =>
              r?.gates?.map((g) => (
                <div key={`${r.id}-${g.metric}`} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                  {g.passed ? <CircleCheck className="size-4 text-met" /> : <CircleX className="size-4 text-notmet" />}
                  <span className="grid min-w-0 flex-1">
                    <span className="font-mono text-xs text-fg">{g.metric}</span>
                    <span className="text-[11px] text-subtle">{SUITES[i]!.label}</span>
                  </span>
                  <span className="tabular text-xs text-muted">
                    {r.metrics[g.metric]?.toFixed(3)} {g.op} {g.threshold}
                  </span>
                </div>
              )),
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Runs" description="Every run is persisted with its dataset version, metrics and commit" />
        <div className="overflow-x-auto px-4 pb-2 scrollbar-thin">
          <Segmented size="xs" value={suite} onValueChange={setSuite} options={SUITES.map((s) => ({ value: s.id, label: s.label }))} />
        </div>
        <CardBody className="overflow-x-auto px-0">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead className="text-xs text-muted">
              <tr>
                {["Run", "Status", "Dataset", "Metrics", "Commit", "When"].map((h) => (
                  <th key={h} className="px-4 py-2 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...suiteRuns].reverse().map((r) => (
                <tr key={r.id} className="border-t border-border/70 align-top">
                  <td className="px-4 py-2.5 font-mono text-xs">{r.id}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={r.status === "succeeded" ? "met" : r.status === "failed" ? "notmet" : "brand"} dot>
                      {titleCase(r.status)}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    {String(r.config.dataset ?? "—")} · {String(r.config.items ?? "")} items
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted">
                      {Object.entries(r.metrics).filter(([k, v]) => !k.startsWith("intent.") && typeof v === "number").map(([k, v]) => (
                        <span key={k}>
                          {k} <span className="text-fg">{v.toFixed(3)}</span>
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1 font-mono text-[11px] text-muted">
                      <GitCommit className="size-3" /> {r.gitSha}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-subtle">{fmtRelative(r.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </AppPage>
  );
}
