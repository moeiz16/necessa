"use client";

import { CircleCheck, CircleX, FlaskConical, GitCommit, Loader2, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { useEvalRuns, useStartEval } from "@/lib/api/hooks";
import type { EvalRun } from "@/lib/api/types";
import { fmtDate, fmtRelative, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { LineTrend } from "@/components/charts/charts";
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

export default function EvalsPage() {
  const runs = useEvalRuns();
  const start = useStartEval();
  const [suite, setSuite] = useState<EvalRun["suite"]>("verdicts");
  const meta = SUITES.find((s) => s.id === suite)!;
  const suiteRuns = useMemo(() => (runs.data ?? []).filter((r) => r.suite === suite).sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [runs.data, suite]);
  const latest = suiteRuns[suiteRuns.length - 1];
  const metricKeys = latest ? Object.keys(latest.metrics) : [];
  const trend = suiteRuns.filter((r) => r.status === "succeeded").map((r) => ({ date: fmtDate(r.startedAt, "MMM d"), ...r.metrics }));
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
              <span className="tabular text-2xl font-semibold tracking-tight text-fg">{r ? r.metrics[s.primary]?.toFixed(3) ?? "—" : "—"}</span>
              <span className="font-mono text-[11px] text-subtle">{s.primary}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader title={`${meta.label} trend`} description={meta.description} icon={<FlaskConical />} />
          <CardBody>
            {runs.isPending ? (
              <Skeleton className="h-[260px]" />
            ) : (
              <LineTrend
                data={trend}
                x="date"
                height={260}
                series={metricKeys.filter((k) => !["phi_leak_rate"].includes(k)).slice(0, 4).map((k) => ({ key: k, label: k }))}
                format={(v) => v.toFixed(2)}
              />
            )}
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
        <CardHeader title="Runs" actions={<Segmented size="xs" value={suite} onValueChange={setSuite} options={SUITES.map((s) => ({ value: s.id, label: s.label }))} />} />
        <CardBody className="px-0">
          <table className="w-full text-[13px]">
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
                      {Object.entries(r.metrics).map(([k, v]) => (
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
