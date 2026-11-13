"use client";

import { ArrowRight, BookOpen, CircleCheck, Clock3, FilePlus2, Gauge, Hourglass, ListChecks, Sparkles, Timer } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useActivity, useAnalytics, useCases, useCriteriaSets, useNotifications } from "@/lib/api/hooks";
import { Can, useSession } from "@/lib/api/session";
import type { CaseSummary } from "@/lib/api/types";
import { fmtNumber, fmtPct, fmtRelative, slaParts, titleCase } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { Bars, Donut, Legend, RankList, SERIES, StackedBars } from "@/components/charts/charts";
import { CodeChip, ReadinessRing, SlaTimer, StatusChip } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { Avatar, Breadcrumb, Card, CardBody, CardHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { StatCard } from "@/components/ui/widgets";

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function Briefing({ cases, reviewCount, policyAlert }: { cases: CaseSummary[]; reviewCount: number; policyAlert?: { title: string; link?: string | null } }) {
  const due = cases.filter((c) => {
    const p = slaParts(c.dueAt);
    return p && p.minutes < 24 * 60 && !["approved", "closed", "denied"].includes(c.status);
  });
  const gaps = cases.filter((c) => c.readiness === "gaps");
  const ready = cases.filter((c) => c.status === "ready");
  const items: { icon: React.ReactNode; text: React.ReactNode; href: string }[] = [];
  if (due.length)
    items.push({
      icon: <Timer className="text-notmet" />,
      text: (
        <>
          <b className="font-semibold text-fg">{due.length} case{due.length > 1 ? "s" : ""}</b> due within 24 hours — {due.map((c) => c.number.slice(-5)).join(", ")}
        </>
      ),
      href: "/cases?view=due",
    });
  if (gaps.length)
    items.push({
      icon: <ListChecks className="text-insufficient" />,
      text: (
        <>
          <b className="font-semibold text-fg">{gaps.length} cases</b> have documentation gaps Necessa can help close before submission
        </>
      ),
      href: "/cases?view=gaps",
    });
  if (ready.length)
    items.push({
      icon: <CircleCheck className="text-met" />,
      text: (
        <>
          <b className="font-semibold text-fg">{ready.length} ready to submit</b> — letters drafted with citations
        </>
      ),
      href: "/cases?view=ready",
    });
  if (reviewCount)
    items.push({
      icon: <BookOpen className="text-brand" />,
      text: (
        <>
          <b className="font-semibold text-fg">{reviewCount} criteria sets</b> compiled below the 0.9 agreement bar await review
        </>
      ),
      href: "/knowledge?tab=criteria",
    });
  if (policyAlert) items.push({ icon: <BookOpen className="text-ai-3" />, text: policyAlert.title, href: policyAlert.link ?? "/policies" });

  return (
    <div className="ai-border relative overflow-hidden rounded-xl p-4 shadow-e1">
      <div className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--ai-2)_16%,transparent),transparent_70%)]" />
      <div className="relative flex items-center gap-2">
        <Sparkles className="size-4 text-ai-2" />
        <h2 className="text-[13px] font-semibold">Today&apos;s briefing</h2>
        <span className="text-xs text-subtle">· generated from your worklist, SLAs and policy feed</span>
      </div>
      <ul className="relative mt-3 grid gap-1">
        {items.length === 0 ? <li className="text-[13px] text-muted">Nothing urgent. Nice.</li> : null}
        {items.map((it, i) => (
          <li key={i}>
            <Link href={it.href} className="group flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface-2">
              <span className="[&_svg]:size-4">{it.icon}</span>
              <span className="min-w-0 flex-1">{it.text}</span>
              <ArrowRight className="size-3.5 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function DashboardPage() {
  const { me } = useSession();
  const cases = useCases({ sort: "dueAt", limit: 200 });
  const analytics = useAnalytics("30d");
  const activity = useActivity();
  const review = useCriteriaSets("needs_review");
  const notifications = useNotifications();

  const all = useMemo(() => cases.data?.items ?? [], [cases.data]);
  const attention = useMemo(
    () =>
      all
        .filter((c) => ["needs_review", "draft", "evaluating", "ready"].includes(c.status))
        .sort((a, b) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9"))
        .slice(0, 6),
    [all],
  );
  const a = analytics.data;
  const spark = a?.trends.casesByDay.map((d) => d.count) ?? [];
  const firstName = me?.user.fullName.replace(/^Dr\.\s*/, "").split(" ")[0];

  const actions = useMemo(() => {
    const out: { title: string; detail: string; href: string; tone: "high" | "medium" }[] = [];
    for (const c of all) {
      if (c.status === "draft" && c.readiness === "unknown") out.push({ title: `Run a medical-necessity check on ${c.number}`, detail: c.title, href: `/cases/${c.id}`, tone: "medium" });
      if (c.readiness === "gaps" && c.status === "needs_review") out.push({ title: `Close gaps on ${c.number}`, detail: `${c.title} · readiness ${fmtPct(c.readinessScore)}`, href: `/cases/${c.id}?tab=gaps`, tone: c.priority === "expedited" ? "high" : "medium" });
      if (c.status === "denied") out.push({ title: `Start an appeal for ${c.number}`, detail: "Denial maps to a documentation criterion", href: `/cases/${c.id}?tab=denials`, tone: "high" });
    }
    return out.sort((x, y) => (x.tone === y.tone ? 0 : x.tone === "high" ? -1 : 1)).slice(0, 5);
  }, [all]);

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Dashboard" }]} />}>
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs text-subtle">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
          <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.02em]">
            {greeting()}
            {firstName ? `, ${firstName}` : ""}
          </h1>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="secondary">
            <Link href="/assistant">
              <Sparkles className="text-ai-2" /> Ask Necessa
            </Link>
          </Button>
          <Can perm="cases:write">
            <Button asChild variant="primary">
              <Link href="/cases/new">
                <FilePlus2 /> New case
              </Link>
            </Button>
          </Can>
        </div>
      </div>

      <div className="grid gap-4">
        {cases.isPending ? <Skeleton className="h-36 rounded-xl" /> : <Briefing cases={all} reviewCount={review.data?.total ?? 0} policyAlert={notifications.data?.find((n) => n.type === "policy")} />}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {a ? (
            <>
              <StatCard label="Open cases" value={fmtNumber(a.kpis.openCases)} delta={a.kpis.dueSoon} deltaLabel=" due soon" goodWhen="down" spark={spark} icon={<Hourglass />} />
              <StatCard label="Ready-to-submit rate" value={fmtPct(a.kpis.readyRate)} delta={6} deltaLabel=" pts vs. prior 30d" spark={a.trends.readinessByWeek.map((w) => w.ready / Math.max(1, w.ready + w.gaps + w.notSupported))} icon={<Gauge />} />
              <StatCard label="Gaps caught pre-submission" value={fmtNumber(a.kpis.gapsCaughtPreSubmission)} delta={11} deltaLabel=" this month" icon={<ListChecks />} hint="Criteria flagged Insufficient or Not met before the packet went to the payer" />
              <StatCard label="Est. staff hours saved" value={fmtNumber(a.kpis.estimatedHoursSaved, { maximumFractionDigits: 1 })} delta={Math.round(a.kpis.avgTurnaroundHours)} deltaLabel=" h avg turnaround" goodWhen="down" icon={<Clock3 />} hint="Benchmarked against ~13 h/week per physician (AMA 2025)" />
            </>
          ) : (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px] rounded-xl" />)
          )}
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <Card>
            <CardHeader
              title="Needs attention"
              description="Sorted by payer clock"
              actions={
                <Button asChild variant="ghost" size="xs">
                  <Link href="/cases">
                    View all <ArrowRight />
                  </Link>
                </Button>
              }
            />
            <CardBody className="px-0 pb-1">
              {cases.isPending ? (
                <div className="grid gap-2 px-4 pb-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
              ) : attention.length === 0 ? (
                <EmptyState compact art="cases" title="No cases need attention" description="New cases and evaluations will show up here." />
              ) : (
                <ul>
                  {attention.map((c) => (
                    <li key={c.id}>
                      <Link href={`/cases/${c.id}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t border-border/70 px-4 py-2.5 transition-colors hover:bg-surface-2/60 sm:grid-cols-[auto_1fr_auto_auto]">
                        <ReadinessRing size={32} stroke={3} readiness={c.readiness} score={c.readinessScore} />
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-fg">{c.title}</p>
                          <p className="flex items-center gap-1.5 truncate text-xs text-muted">
                            <span className="font-mono">{c.number}</span>· {c.patient.displayName} · {c.payerName}
                            <span className="hidden gap-1 md:inline-flex">
                              {c.serviceCodes.slice(0, 1).map((s) => (
                                <CodeChip key={s} code={s} className="h-4 text-[10.5px]" />
                              ))}
                            </span>
                          </p>
                        </div>
                        <span className="hidden sm:block">
                          <StatusChip status={c.status} />
                        </span>
                        <SlaTimer dueAt={c.dueAt} compact />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Next best actions" description="Ranked by impact on readiness and SLA" icon={<Sparkles className="text-ai-2" />} />
            <CardBody className="grid gap-1.5">
              {actions.length === 0 ? <p className="py-6 text-center text-[13px] text-muted">You&apos;re ahead of the queue.</p> : null}
              {actions.map((x) => (
                <Link key={x.title} href={x.href} className="group flex items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:border-border-strong hover:bg-surface-2/50">
                  <span className={`mt-1 size-2 shrink-0 rounded-full ${x.tone === "high" ? "bg-notmet" : "bg-insufficient"}`} />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="text-[13px] font-medium text-fg">{x.title}</span>
                    <span className="truncate text-xs text-muted">{x.detail}</span>
                  </span>
                  <ArrowRight className="ml-auto mt-0.5 size-3.5 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </CardBody>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Documentation readiness by week" description="Evaluated cases · last 30 days" />
            <CardBody>
              {a ? (
                a.trends.readinessByWeek.length ? (
                  <StackedBars
                    data={a.trends.readinessByWeek}
                    x="week"
                    series={[
                      { key: "ready", label: "Ready", color: "var(--met)" },
                      { key: "gaps", label: "Gaps", color: "var(--insufficient)" },
                      { key: "notSupported", label: "Not supported", color: "var(--notmet)" },
                    ]}
                  />
                ) : (
                  <EmptyState compact art="chart" title="No evaluations yet" />
                )
              ) : (
                <Skeleton className="h-[220px]" />
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Most frequent gaps" description="Criteria flagged before submission this month" />
            <CardBody>
              {a ? (
                a.topGapCriteria.length ? (
                  <RankList items={a.topGapCriteria.map((g) => ({ label: g.criterionText, value: g.count }))} />
                ) : (
                  <EmptyState compact art="chart" title="No gaps recorded yet" />
                )
              ) : (
                <Skeleton className="h-[220px]" />
              )}
            </CardBody>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1.2fr]">
          <Card>
            <CardHeader title="Denial reasons" description="Last 90 days" />
            <CardBody className="grid grid-cols-[140px_1fr] items-center gap-4">
              {a && a.denialReasons.length ? (
                <>
                  <Donut data={a.denialReasons} nameKey="category" valueKey="count" height={140} />
                  <Legend items={a.denialReasons.map((d, i) => ({ label: titleCase(d.category), color: SERIES[i % SERIES.length]!, value: d.count }))} />
                </>
              ) : a ? (
                <p className="col-span-2 py-6 text-center text-[13px] text-muted">No denials. Keep it up.</p>
              ) : (
                <Skeleton className="col-span-2 h-[140px]" />
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Payer mix" description="Cases by payer type" />
            <CardBody>{a && a.payerMix.length ? <Bars data={a.payerMix.map((p) => ({ ...p, payerType: titleCase(p.payerType) }))} x="payerType" y="count" height={150} /> : <Skeleton className="h-[150px]" />}</CardBody>
          </Card>
          <Card>
            <CardHeader title="Activity" description="Across your organization" />
            <CardBody className="grid gap-3">
              {(activity.data ?? []).slice(0, 6).map((e) => (
                <Link key={e.id} href={e.link ?? "#"} className="flex items-start gap-2.5 text-[13px]">
                  <Avatar name={e.actor?.fullName ?? "Necessa"} color={e.actor?.avatarColor ?? "var(--brand)"} size={22} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-fg">{e.actor?.fullName ?? "Necessa"}</span> <span className="text-muted">{e.verb}</span> <span className="text-fg">{e.target}</span>
                    <span className="block text-xs text-subtle">{fmtRelative(e.createdAt)}</span>
                  </span>
                </Link>
              ))}
              {activity.isPending ? <Skeleton className="h-40" /> : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </AppPage>
  );
}
