"use client";

import { Clock3, Database, Gauge, Gavel, ListChecks, Sparkles, TrendingUp, Users } from "lucide-react";
import { useState } from "react";
import { useAnalytics, useAskAnalytics, useTeam } from "@/lib/api/hooks";
import { fmtNumber, fmtPct, ROLE_LABEL, titleCase } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { SqlAnswer } from "@/components/assistant/chat";
import { AreaTrend, Bars, Donut, Legend, RankList, SERIES, StackedBars } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Avatar, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Progress, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/ui/widgets";

const PROMPTS = ["Top 5 gap criteria this month", "Denials by category this month", "Average turnaround hours by week", "Cases and readiness by payer"];

export default function AnalyticsPage() {
  const [range, setRange] = useState("30d");
  const a = useAnalytics(range);
  const team = useTeam();
  const ask = useAskAnalytics();
  const [question, setQuestion] = useState("");
  const d = a.data;

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Insights" }, { label: "Analytics" }]} />} wide>
      <PageHeader
        title="Analytics"
        description="Volume, readiness, turnaround and denials — computed from your own cases with row-level security."
        actions={<Segmented value={range} onValueChange={setRange} options={[{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "90d", label: "90 days" }]} />}
      />

      <Card className="ai-border mb-5">
        <CardHeader title="Ask a question about your data" description="Natural language → validated, read-only SQL over allowlisted, tenant-scoped views. The query is always shown." icon={<Sparkles className="text-ai-2" />} />
        <CardBody className="grid gap-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (question.trim()) ask.mutate(question.trim());
            }}
          >
            <Input leading={<Database />} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Which criteria caused the most gaps for Medicare FFS this month?" aria-label="Analytics question" />
            <Button type="submit" variant="primary" loading={ask.isPending} disabled={!question.trim()}>
              Ask
            </Button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setQuestion(p);
                  ask.mutate(p);
                }}
                className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted hover:border-border-strong hover:text-fg"
              >
                {p}
              </button>
            ))}
          </div>
          {ask.data ? (
            <div>
              {ask.data.summary ? <p className="text-[13px] text-fg">{ask.data.summary}</p> : null}
              <SqlAnswer sql={ask.data} />
            </div>
          ) : null}
        </CardBody>
      </Card>

      {!d ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Ready-to-submit rate" value={fmtPct(d.kpis.readyRate)} icon={<Gauge />} />
            <StatCard label="Avg readiness score" value={fmtPct(d.kpis.avgReadinessScore)} icon={<TrendingUp />} />
            <StatCard label="Avg time to submission" value={`${fmtNumber(d.kpis.avgTurnaroundHours, { maximumFractionDigits: 1 })} h`} icon={<Clock3 />} />
            <StatCard label="Appeals overturned" value={`${d.kpis.appealsOverturned} / ${d.kpis.deniedCases}`} icon={<Gavel />} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Case volume" description="New cases per day" />
              <CardBody>{d.trends.casesByDay.some((x) => x.count) ? <AreaTrend data={d.trends.casesByDay} x="date" y="count" /> : <EmptyState compact art="chart" title="No cases in this range" />}</CardBody>
            </Card>
            <Card>
              <CardHeader title="Readiness outcomes" description="Evaluated cases by week" />
              <CardBody>
                {d.trends.readinessByWeek.length ? (
                  <StackedBars
                    data={d.trends.readinessByWeek}
                    x="week"
                    series={[
                      { key: "ready", label: "Ready", color: "var(--met)" },
                      { key: "gaps", label: "Gaps", color: "var(--insufficient)" },
                      { key: "notSupported", label: "Not supported", color: "var(--notmet)" },
                    ]}
                  />
                ) : (
                  <EmptyState compact art="chart" title="No evaluations in this range" />
                )}
              </CardBody>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader title="Top gap criteria" icon={<ListChecks />} />
              <CardBody>{d.topGapCriteria.length ? <RankList items={d.topGapCriteria.map((g) => ({ label: g.criterionText, value: g.count }))} /> : <EmptyState compact art="chart" title="No gaps recorded" />}</CardBody>
            </Card>
            <Card>
              <CardHeader title="Denial categories" icon={<Gavel />} />
              <CardBody className="grid grid-cols-[130px_1fr] items-center gap-4">
                {d.denialReasons.length ? (
                  <>
                    <Donut data={d.denialReasons} nameKey="category" valueKey="count" height={130} />
                    <Legend items={d.denialReasons.map((r, i) => ({ label: titleCase(r.category), color: SERIES[i % SERIES.length]!, value: r.count }))} />
                  </>
                ) : (
                  <p className="col-span-2 py-8 text-center text-[13px] text-muted">No denials</p>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Payer mix" />
              <CardBody>{d.payerMix.length ? <Bars data={d.payerMix.map((p) => ({ ...p, payerType: titleCase(p.payerType) }))} x="payerType" y="count" height={170} horizontal /> : <EmptyState compact art="chart" title="No data" />}</CardBody>
            </Card>
          </div>
          <Card>
            <CardHeader title="Team workload" description="Open cases, near-due cases and 30-day throughput" icon={<Users />} />
            <CardBody className="px-0">
              <table className="w-full text-[13px]">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Member</th>
                    <th className="px-4 py-2 text-left font-medium">Open</th>
                    <th className="px-4 py-2 text-left font-medium">Due soon</th>
                    <th className="w-1/3 px-4 py-2 text-left font-medium">Completed (30 d)</th>
                  </tr>
                </thead>
                <tbody>
                  {(team.data ?? []).map((t) => (
                    <tr key={t.user.id} className="border-t border-border/70">
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-2">
                          <Avatar name={t.user.fullName} color={t.user.avatarColor} size={24} />
                          <span className="grid leading-tight">
                            <span className="font-medium text-fg">{t.user.fullName}</span>
                            <span className="text-xs text-subtle">{ROLE_LABEL[t.role]}</span>
                          </span>
                        </span>
                      </td>
                      <td className="tabular px-4 py-2.5">{t.open}</td>
                      <td className="tabular px-4 py-2.5">{t.dueSoon ? <span className="text-insufficient-fg">{t.dueSoon}</span> : 0}</td>
                      <td className="px-4 py-2.5">
                        <span className="flex items-center gap-3">
                          <Progress value={t.completed30d / 45} className="max-w-48" />
                          <span className="tabular text-xs text-muted">{t.completed30d}</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </div>
      )}
    </AppPage>
  );
}
