"use client";

import { Search } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useAnalytics, useAskAnalytics, useTeam } from "@/lib/api/hooks";
import type { AnalyticsOverview, SqlResult } from "@/lib/api/types";
import { fmtNumber, fmtPct, PAYER_LABEL, ROLE_LABEL, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { Legend, SqlChart } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Avatar, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/ui/widgets";

const VolumeChart = dynamic(() => import("./_charts").then((m) => m.VolumeChart), { ssr: false, loading: () => <Skeleton className="h-[230px] w-full rounded-lg" /> });
const ReadinessChart = dynamic(() => import("./_charts").then((m) => m.ReadinessChart), { ssr: false, loading: () => <Skeleton className="h-[230px] w-full rounded-lg" /> });

const PROMPTS = ["Top documentation gaps this month", "Denials by reason this month", "Average turnaround by week", "Cases by payer"];

const DENIAL_LABEL: Record<string, string> = {
  medical_necessity: "Medical necessity not shown",
  documentation: "Missing documentation",
  coding: "Coding mismatch",
  eligibility: "Eligibility",
  timely_filing: "Filed late",
  prior_authorization: "Prior authorization missing",
  other: "Other",
};

/** Hours from case created to submitted, against the payer decision deadlines (CMS-0057-F: 72 h urgent, 7 days standard). */
function Turnaround({ hours }: { hours: number | null | undefined }) {
  if (hours == null) return <p className="text-sm text-muted">Turnaround appears once cases have been submitted.</p>;
  const max = 168;
  const tone = hours <= 72 ? "bg-met" : hours <= 168 ? "bg-insufficient" : "bg-notmet";
  return (
    <div className="grid grid-cols-1 gap-4">
      <p className="tabular text-[28px] font-semibold leading-none tracking-tight text-fg">
        {hours >= 48 ? `${fmtNumber(hours / 24, { maximumFractionDigits: 1 })} days` : `${fmtNumber(hours, { maximumFractionDigits: 1 })} hours`}
        <span className="ml-2 text-sm font-normal text-muted">on average, from request to submission</span>
      </p>
      <div className="relative pb-6">
        <div className="h-2 overflow-hidden rounded-full bg-surface-3">
          <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(1, hours / max) * 100}%` }} />
        </div>
        <span className="absolute top-0 h-2 w-px bg-fg/50" style={{ left: `${(72 / max) * 100}%` }} aria-hidden />
        <span className="absolute top-3 -translate-x-1/2 whitespace-nowrap text-[11px] text-subtle" style={{ left: `${(72 / max) * 100}%` }}>
          72 h urgent
        </span>
        <span className="absolute right-0 top-3 whitespace-nowrap text-[11px] text-subtle">7 days standard</span>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {hours <= 72
          ? "Requests leave well inside even the urgent payer deadline, leaving time for a second look."
          : hours <= 168
            ? "Inside the 7-day standard deadline, but not the 72-hour urgent one. Prioritize urgent cases in the worklist."
            : "Slower than the standard payer deadline. Missing documentation is likely being requested after submission."}
      </p>
    </div>
  );
}

function BarList({ items, tone = "bg-insufficient" }: { items: { label: string; value: number; sub?: string }[]; tone?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ol className="grid gap-3.5">
      {items.map((it) => (
        <li key={it.label} className="grid gap-1.5">
          <div className="flex items-baseline gap-3 text-[13px]">
            <span className="flex-1 text-fg">{it.label}</span>
            {it.sub ? <span className="text-xs text-subtle">{it.sub}</span> : null}
            <span className="tabular font-medium text-fg">{it.value}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className={cn("h-full rounded-full", tone)} style={{ width: `${(it.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function PayerMix({ rows }: { rows: AnalyticsOverview["payerMix"] }) {
  const total = rows.reduce((a, r) => a + r.count, 0) || 1;
  return (
    <BarList
      tone="bg-brand"
      items={[...rows]
        .sort((a, b) => b.count - a.count)
        .map((r) => ({ label: PAYER_LABEL[r.payerType] ?? titleCase(r.payerType), value: r.count, sub: `${Math.round((r.count / total) * 100)}%` }))}
    />
  );
}

/** A plain answer: a sentence, a chart when it helps, and a table. How the answer was produced is never shown. */
function Answer({ result }: { result: SqlResult }) {
  const hasRows = result.rows.length > 0;
  return (
    <div className="grid gap-3">
      {result.summary ? <p className="text-[13.5px] leading-relaxed text-fg">{result.summary}</p> : null}
      {hasRows ? <SqlChart result={result} height={200} /> : null}
      {hasRows ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2/60 text-xs text-muted">
              <tr>
                {result.columns.map((c) => (
                  <th key={c} scope="col" className="px-3 py-2 text-left font-medium">
                    {titleCase(c.replace(/_/g, " "))}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.slice(0, 12).map((row, i) => (
                <tr key={i} className="border-t border-border/70">
                  {row.map((v, j) => (
                    <td key={j} className="tabular px-3 py-2 text-fg">
                      {v == null ? "–" : typeof v === "number" ? fmtNumber(v, { maximumFractionDigits: 2 }) : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted">No matching cases for that question yet.</p>
      )}
    </div>
  );
}

export default function InsightsPage() {
  const [range, setRange] = useState("30d");
  const a = useAnalytics(range);
  const team = useTeam();
  const ask = useAskAnalytics();
  const [question, setQuestion] = useState("");
  const d = a.data;
  const days = Number(range.replace("d", ""));
  const teamMax = Math.max(1, ...(team.data ?? []).map((t) => t.completed30d));
  const submit = (text: string) => {
    const q = text.trim();
    if (!q) return;
    setQuestion(q);
    ask.mutate(q);
  };

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Insights" }]} />} wide>
      <PageHeader
        title="Insights"
        description="How your prior-authorization work is performing: turnaround, documentation gaps, denials and team capacity."
        actions={<Segmented value={range} onValueChange={setRange} options={[{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "90d", label: "90 days" }]} />}
      />

      {!d ? (
        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}</div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-[300px] rounded-xl" />)}</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Ready to submit" value={fmtPct(d.kpis.readyRate)} hint="Cases with every requirement documented" />
            <StatCard
              label="Average turnaround"
              value={d.kpis.avgTurnaroundHours == null ? "–" : `${fmtNumber(d.kpis.avgTurnaroundHours, { maximumFractionDigits: 1 })} h`}
              hint="Payer deadlines: 72 h urgent, 7 days standard"
            />
            <StatCard label="Gaps fixed before submission" value={fmtNumber(d.kpis.gapsCaughtPreSubmission)} hint="Caught before the payer saw them" />
            <StatCard label="Staff time saved" value={`${fmtNumber(d.kpis.estimatedHoursSaved, { maximumFractionDigits: 1 })} h`} hint="Estimated from cases prepared in this period" />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="New cases" description={`Per day, last ${days} days`} />
              <CardBody>{d.trends.casesByDay.some((x) => x.count) ? <VolumeChart data={d.trends.casesByDay} /> : <EmptyState compact art="chart" title="No cases in this period" />}</CardBody>
            </Card>
            <Card>
              <CardHeader title="Documentation readiness" description="Cases checked each week" />
              <CardBody className="grid gap-2">
                {d.trends.readinessByWeek.length ? (
                  <>
                    <Legend items={[{ label: "Ready to submit", color: "var(--met)" }, { label: "Needs more documentation", color: "var(--insufficient)" }, { label: "Not supported by policy", color: "var(--notmet)" }]} />
                    <ReadinessChart data={d.trends.readinessByWeek} />
                  </>
                ) : (
                  <EmptyState compact art="chart" title="No cases checked in this period" />
                )}
              </CardBody>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Turnaround" description="Compared with payer decision deadlines" />
              <CardBody>
                <Turnaround hours={d.kpis.avgTurnaroundHours} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Why cases are denied" description="Reasons on denials you've recorded" />
              <CardBody className="grid gap-4">
                {d.denialReasons.length ? (
                  <BarList items={d.denialReasons.map((r) => ({ label: DENIAL_LABEL[r.category] ?? titleCase(r.category), value: r.count }))} />
                ) : (
                  <EmptyState compact art="chart" title="No denials recorded" />
                )}
                <p className="border-t border-border pt-3 text-[13px] text-muted">
                  Appeals overturned: <span className="tabular font-medium text-fg">{d.kpis.appealsOverturned}</span> of <span className="tabular font-medium text-fg">{d.kpis.deniedCases}</span>
                </p>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Payer mix" description="Cases by payer type" />
              <CardBody>{d.payerMix.length ? <PayerMix rows={d.payerMix} /> : <EmptyState compact art="chart" title="No data yet" />}</CardBody>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.2fr]">
            <Card>
              <CardHeader title="Most common documentation gaps" description="Requirements most often missing. Fix these at the source in your clinic workflow." />
              <CardBody>{d.topGapCriteria.length ? <BarList items={d.topGapCriteria.slice(0, 6).map((g) => ({ label: g.criterionText, value: g.count }))} /> : <EmptyState compact art="chart" title="No gaps recorded" />}</CardBody>
            </Card>
            <Card>
              <CardHeader title="Team workload" description="Open and near-due cases, and cases completed in 30 days" />
              <CardBody className="px-0 pb-2">
                {team.isPending ? (
                  <div className="grid gap-2 px-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[460px] text-[13px]">
                      <thead className="text-xs text-muted">
                        <tr>
                          <th scope="col" className="px-4 py-2 text-left font-medium">Person</th>
                          <th scope="col" className="px-4 py-2 text-right font-medium">Open</th>
                          <th scope="col" className="px-4 py-2 text-right font-medium">Due soon</th>
                          <th scope="col" className="w-2/5 px-4 py-2 text-left font-medium">Completed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(team.data ?? []).map((t) => (
                          <tr key={t.user.id} className="border-t border-border/70">
                            <td className="px-4 py-2.5">
                              <span className="flex items-center gap-2">
                                <Avatar name={t.user.fullName} color={t.user.avatarColor} size={26} />
                                <span className="grid leading-tight">
                                  <span className="font-medium text-fg">{t.user.fullName}</span>
                                  <span className="text-xs text-subtle">{ROLE_LABEL[t.role]}</span>
                                </span>
                              </span>
                            </td>
                            <td className="tabular px-4 py-2.5 text-right">{t.open}</td>
                            <td className="tabular px-4 py-2.5 text-right">{t.dueSoon ? <span className="font-medium text-insufficient-fg">{t.dueSoon}</span> : <span className="text-subtle">0</span>}</td>
                            <td className="px-4 py-2.5">
                              <span className="flex items-center gap-3">
                                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                                  <span className="block h-full rounded-full bg-brand" style={{ width: `${(t.completed30d / teamMax) * 100}%` }} />
                                </span>
                                <span className="tabular w-7 text-right text-xs text-muted">{t.completed30d}</span>
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader title="Ask a question about your cases" description="Get an answer as a table or chart, for example by payer, by month or by reason." />
            <CardBody className="grid gap-3">
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit(question);
                }}
              >
                <div className="min-w-0 flex-1">
                  <Input leading={<Search />} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Which requirements caused the most gaps for Medicare this month?" aria-label="Question about your cases" className="h-10" />
                </div>
                <Button type="submit" variant="primary" className="h-10 px-5" loading={ask.isPending} disabled={!question.trim()}>
                  Ask
                </Button>
              </form>
              <div className="flex flex-wrap gap-1.5">
                {PROMPTS.map((p) => (
                  <button key={p} onClick={() => submit(p)} className="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:border-border-strong hover:text-fg">
                    {p}
                  </button>
                ))}
              </div>
              {ask.isPending ? <Skeleton className="h-40 rounded-lg" /> : null}
              {ask.isError ? <p className="text-sm text-muted">We couldn&apos;t answer that one. Try rephrasing the question.</p> : null}
              {ask.data && !ask.isPending ? <Answer result={ask.data} /> : null}
            </CardBody>
          </Card>
        </div>
      )}
    </AppPage>
  );
}
