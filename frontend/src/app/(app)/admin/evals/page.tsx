"use client";

import { CircleAlert, CircleCheck, CircleDashed } from "lucide-react";
import { useEvalRuns, useStartEval } from "@/lib/api/hooks";
import type { EvalRun } from "@/lib/api/types";
import { fmtPct, fmtRelative } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Breadcrumb, Card, PageHeader, Skeleton } from "@/components/ui/display";

const pick = (m: Record<string, number>, keys: string[]) => keys.map((k) => m[k]).find((v) => typeof v === "number");

/** Each area of quality we measure, described by what it means for a practice. */
const AREAS: { id: EvalRun["suite"]; name: string; does: string; headline: (m: Record<string, number>) => number | undefined; label: string; digits?: number }[] = [
  { id: "retrieval", name: "Finding the right policy", does: "Searches bring up the policy a reviewer would choose.", headline: (m) => pick(m, ["hit@10", "recall@10"]), label: "found" },
  { id: "verdicts", name: "Reading charts correctly", does: "A requirement is only marked met when the chart shows it.", headline: (m) => m.false_met_rate, label: "wrongly marked as met", digits: 1 },
  { id: "sql", name: "Answering questions about cases", does: "Questions about your cases return the right numbers.", headline: (m) => m.execution_accuracy, label: "answered correctly" },
  { id: "faithfulness", name: "Staying true to the policy", does: "Answers and letters only say what their sources support.", headline: (m) => pick(m, ["faithfulness", "citation_validity"]), label: "supported by sources" },
  { id: "safety", name: "Protecting patient information", does: "Suspicious requests are blocked and identifiers never leak.", headline: (m) => pick(m, ["pass_rate", "injection_block_rate"]), label: "safety checks passed" },
];

function statusOf(run?: EvalRun) {
  if (!run) return { label: "No result yet", Icon: CircleDashed, tone: "text-subtle" };
  if (run.status === "running" || run.status === "queued") return { label: "Running", Icon: CircleDashed, tone: "text-muted" };
  if (run.status === "failed") return { label: "Needs attention", Icon: CircleAlert, tone: "text-notmet-fg" };
  const gates = run.gates ?? [];
  if (gates.length && gates.some((g) => !g.passed)) return { label: "Needs attention", Icon: CircleAlert, tone: "text-insufficient-fg" };
  return { label: gates.length ? "Passing" : "Completed", Icon: CircleCheck, tone: "text-met-fg" };
}

export default function QualityReportPage() {
  const runs = useEvalRuns();
  const start = useStartEval();
  const latest = (id: EvalRun["suite"]) => [...(runs.data ?? [])].filter((r) => r.suite === id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Quality report" }]} />} wide>
      <PageHeader
        title="Quality report"
        description="Regular checks that Necessa finds the right policies, reads charts correctly and keeps patient information safe."
      />
      {runs.isPending ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border">
            {AREAS.map((a) => {
              const run = latest(a.id);
              const st = statusOf(run);
              const value = run ? a.headline(run.metrics) : undefined;
              return (
                <li key={a.id} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 px-4 py-4 sm:grid-cols-[1.5fr_1fr_1fr_auto]">
                  <div className="grid min-w-0">
                    <span className="text-[13.5px] font-medium text-fg">{a.name}</span>
                    <span className="text-xs text-muted">{a.does}</span>
                  </div>
                  <span className={`flex items-center gap-1.5 text-[13px] ${st.tone}`}>
                    <st.Icon className="size-3.5" /> {st.label}
                  </span>
                  <span className="text-xs text-muted sm:text-left">
                    {value != null ? (
                      <>
                        <span className="tabular text-[15px] font-semibold text-fg">{fmtPct(value, a.digits ?? 0)}</span> {a.label}
                      </>
                    ) : (
                      "–"
                    )}
                    {run?.startedAt ? <span className="block text-subtle">Last checked {fmtRelative(run.startedAt)}</span> : null}
                  </span>
                  <Button size="xs" variant="ghost" loading={start.isPending && start.variables === a.id} onClick={() => start.mutate(a.id)}>
                    Run now
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </AppPage>
  );
}
