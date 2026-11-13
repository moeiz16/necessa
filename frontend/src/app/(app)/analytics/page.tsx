"use client";

import { CheckCheck, Clock3, Database, Gauge, Gavel, ListChecks, ShieldAlert, Sparkles, Timer, TrendingUp, Users } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { useAnalytics, useAskAnalytics, useTeam } from "@/lib/api/hooks";
import type { AnalyticsOverview } from "@/lib/api/types";
import { fmtNumber, fmtPct, PAYER_LABEL, ROLE_LABEL, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { SqlAnswer } from "@/components/assistant/chat";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Avatar, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { StatCard } from "@/components/ui/widgets";

const VolumeChart = dynamic(() => import("./_charts").then((m) => m.VolumeChart), { ssr: false, loading: () => <Skeleton className="h-[230px] w-full rounded-lg" /> });
const ReadinessChart = dynamic(() => import("./_charts").then((m) => m.ReadinessChart), { ssr: false, loading: () => <Skeleton className="h-[230px] w-full rounded-lg" /> });
const DonutChart = dynamic(() => import("./_charts").then((m) => m.DonutChart), { ssr: false, loading: () => <Skeleton className="h-[150px] w-full rounded-full" /> });

const PALETTE = ["var(--brand)", "var(--ai-3)", "var(--ai-2)", "var(--insufficient)", "var(--met)", "var(--notmet)"];
const PROMPTS = ["Top 5 gap criteria this month", "Denials by category this month", "Average turnaround hours by week", "Cases and readiness by payer"];

/** Average time-to-submission against the CMS-0057-F payer decision clocks (72 h expedited, 7 days standard). */
function ClockGauge({ hours }: { hours: number }) {
  const max = 168;
  const pct = Math.min(1, hours / max);
  const status = hours <= 72 ? "met" : hours <= 168 ? "insufficient" : "notmet";
  return (
    <div className="grid gap-3">
      <div className="flex items-end gap-2">
        <span className="tabular text-[28px] font-semibold leading-none tracking-[-0.03em] text-fg">{fmtNumber(hours, { maximumFractionDigits: 1 })}</span>
        <span className="pb-0.5 text-sm text-muted">hours, request created → submitted</span>
      </div>
      <div className="relative pt-5">
        <div className="relative h-2.5 overflow-hidden rounded-full bg-surface-3">
          <div className="absolute inset-y-0 left-0 bg-met/20" style={{ width: `${(72 / max) * 100}%` }} />
          <div className={cn("absolute inset-y-0 left-0 rounded-full", status === "met" ? "bg-met" : status === "insufficient" ? "bg-insufficient" : "bg-notmet")} style={{ width: `${pct * 100}%` }} />
        </div>
        {[
          { at: 72, label: "72 h · expedited clock" },
          { at: 168, label: "7 d · standard clock" },
        ].map((m) => (
          <div key={m.at} className="absolute top-0 -translate-x-full text-right" style={{ left: `${(m.at / max) * 100}%` }}>
            <span className="whitespace-nowrap pr-1 text-[10.5px] text-subtle">{m.label}</span>
            <span className="absolute right-0 top-4 h-[18px] w-px bg-border-strong" aria-hidden />
          </div>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted">
        {status === "met"
          ? "Packets leave well inside even the expedited payer window, leaving room for a second documentation pass."
          : status === "insufficient"
            ? "Faster than the 7-day standard clock, but not the 72-hour expedited one — prioritize expedited cases in the worklist."
            : "Slower than the standard payer clock — documentation is likely being requested after submission."}
      </p>
    </div>
  );
}

function PayerMix({ rows }: { rows: AnalyticsOverview["payerMix"] }) {
  const total = rows.reduce((a, r) => a + r.count, 0) || 1;
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  return (
    <div className="grid gap-3">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        {sorted.map((r, i) => (
          <span key={r.payerType} style={{ width: `${(r.count / total) * 100}%`, background: PALETTE[i % PALETTE.length] }} />
        ))}
      </div>
      <ul className="grid gap-2">
        {sorted.map((r, i) => (
          <li key={r.payerType} className="flex items-center gap-2 text-[13px]">
            <span className="size-2.5 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="text-fg">{PAYER_LABEL[r.payerType] ?? titleCase(r.payerType)}</span>
            <span className="tabular ml-auto text-muted">{r.count}</span>
            <span className="tabular w-10 text-right text-xs text-subtle">{Math.round((r.count / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GapRank({ items }: { items: AnalyticsOverview["topGapCriteria"] }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ol className="grid gap-3">
      {items.map((g, i) => (
        <li key={g.criterionText} className="grid gap-1.5">
          <div className="flex items-start gap-2 text-[13px]">
            <span className="tabular mt-px w-4 text-xs text-subtle">{i + 1}</span>
            <span className="flex-1 text-fg">{g.criterionText}</span>
            <span className="tabular font-medium text-fg">{g.count}</span>
          </div>
          <div className="ml-6 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-insufficient transition-[width] duration-700" style={{ width: `${(g.count / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: i.color }} /> {i.label}
        </span>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const [range, setRange] = useState("30d");
  const a = useAnalytics(range);
  const team = useTeam();
  const ask = useAskAnalytics();
  const [question, setQuestion] = useState("");
  const d = a.data;
  const days = Number(range.replace("d", ""));
  const run = (text: string) => {
    setQuestion(text);
    ask.mutate(text);
  };
  const teamMax = Math.max(1, ...(team.data ?? []).map((t) => t.completed30d));

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Insights" }, { label: "Analytics" }]} />} wide>
      <PageHeader
        title="Analytics"
        description="Volume, readiness, turnaround and denials — computed from your organization's own cases, isolated by tenant at the database."
        actions={<Segmented value={range} onValueChange={setRange} options={[{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "90d", label: "90 days" }]} />}
      />

      <Card className="ai-border mb-6">
        <CardHeader title="Ask a question about your data" description="Natural language → validated, read-only SQL over allowlisted, tenant-scoped views. The generated query is always shown." icon={<Sparkles className="text-ai-2" />} />
        <CardBody className="grid gap-3">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (question.trim()) ask.mutate(question.trim());
            }}
          >
            <div className="min-w-0 flex-1">
              <Input leading={<Database />} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Which criteria caused the most gaps for Medicare FFS this month?" aria-label="Analytics question" className="h-10" />
            </div>
            <Button type="submit" variant="primary" className="h-10 px-5" loading={ask.isPending} disabled={!question.trim()}>
              Ask
            </Button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {PROMPTS.map((p) => (
              <button key={p} onClick={() => run(p)} className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted transition-colors hover:border-border-strong hover:text-fg">
                {p}
              </button>
            ))}
          </div>
          {ask.isPending ? <Skeleton className="h-40 rounded-xl" /> : null}
          {ask.data && !ask.isPending ? (
            <div className="grid gap-2">
              {ask.data.summary ? <p className="text-[13px] leading-relaxed text-fg">{ask.data.summary}</p> : null}
              {ask.data.warnings?.length ? (
                <ul className="grid gap-1">
                  {ask.data.warnings.map((w) => (
                    <li key={w} className="flex items-start gap-2 rounded-md bg-insufficient-soft/60 px-2.5 py-1.5 text-xs text-insufficient-fg">
                      <ShieldAlert className="mt-px size-3.5 shrink-0" /> {w}
                    </li>
                  ))}
                </ul>
              ) : null}
              <SqlAnswer sql={ask.data} />
            </div>
          ) : null}
        </CardBody>
      </Card>

      {!d ? (
        <div className="grid grid-cols-1 gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)}</div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-[300px] rounded-xl" />)}</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Ready-to-submit rate" value={fmtPct(d.kpis.readyRate)} icon={<Gauge />} hint="Share of evaluated cases with every criterion documented" />
            <StatCard label="Avg readiness score" value={fmtPct(d.kpis.avgReadinessScore)} icon={<TrendingUp />} hint="Mean completeness across evaluated criteria" />
            <StatCard label="Gaps caught pre-submission" value={fmtNumber(d.kpis.gapsCaughtPreSubmission)} icon={<CheckCheck />} hint="Documentation gaps flagged before the packet left the practice" />
            <StatCard label="Appeals overturned" value={`${d.kpis.appealsOverturned} / ${d.kpis.deniedCases}`} icon={<Gavel />} hint="Denials overturned on appeal / total denials" />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Case volume" description={`New prior-authorization cases per day · last ${days} days`} />
              <CardBody className="grid gap-2">
                <Legend items={[{ label: "Daily", color: "color-mix(in srgb, var(--brand) 30%, transparent)" }, { label: "7-day average", color: "var(--brand)" }]} />
                {d.trends.casesByDay.some((x) => x.count) ? <VolumeChart data={d.trends.casesByDay} /> : <EmptyState compact art="chart" title="No cases in this range" />}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Readiness outcomes" description="Evaluated cases by week" />
              <CardBody className="grid gap-2">
                <Legend items={[{ label: "Ready", color: "var(--met)" }, { label: "Gaps", color: "var(--insufficient)" }, { label: "Not supported", color: "var(--notmet)" }]} />
                {d.trends.readinessByWeek.length ? <ReadinessChart data={d.trends.readinessByWeek} /> : <EmptyState compact art="chart" title="No evaluations in this range" />}
              </CardBody>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Turnaround vs payer clocks" description="CMS-0057-F decision timeframes, in force since Jan 2026" icon={<Timer />} />
              <CardBody>
                <ClockGauge hours={d.kpis.avgTurnaroundHours} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Denial categories" description="Recorded payer denials, by mapped reason" icon={<Gavel />} />
              <CardBody>
                {d.denialReasons.length ? (
                  <div className="grid grid-cols-[minmax(0,120px)_1fr] items-center gap-4 sm:grid-cols-[140px_1fr]">
                    <DonutChart data={d.denialReasons.map((r) => ({ name: titleCase(r.category), value: r.count }))} />
                    <ul className="grid gap-1.5">
                      {d.denialReasons.map((r, i) => (
                        <li key={r.category} className="flex items-center gap-2 text-[13px]">
                          <span className="size-2.5 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
                          <span className="text-fg">{titleCase(r.category)}</span>
                          <span className="tabular ml-auto text-muted">{r.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <EmptyState compact art="chart" title="No denials recorded" />
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Payer mix" description="Cases by payer type" icon={<Clock3 />} />
              <CardBody>{d.payerMix.length ? <PayerMix rows={d.payerMix} /> : <EmptyState compact art="chart" title="No data" />}</CardBody>
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.2fr]">
            <Card>
              <CardHeader title="Top gap criteria" description="The requirements most often missing from charts — target these in clinic workflows" icon={<ListChecks />} />
              <CardBody>{d.topGapCriteria.length ? <GapRank items={d.topGapCriteria} /> : <EmptyState compact art="chart" title="No gaps recorded" />}</CardBody>
            </Card>
            <Card>
              <CardHeader title="Team workload" description="Open cases, near-due cases and 30-day throughput" icon={<Users />} />
              <CardBody className="px-0 pb-2">
                {team.isPending ? (
                  <div className="grid gap-2 px-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[480px] text-[13px]">
                      <thead className="text-xs text-muted">
                        <tr>
                          <th scope="col" className="px-4 py-2 text-left font-medium">Member</th>
                          <th scope="col" className="px-4 py-2 text-right font-medium">Open</th>
                          <th scope="col" className="px-4 py-2 text-right font-medium">Due soon</th>
                          <th scope="col" className="w-2/5 px-4 py-2 text-left font-medium">Completed (30 d)</th>
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
        </div>
      )}
    </AppPage>
  );
}
