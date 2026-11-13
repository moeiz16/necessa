"use client";

import { ArrowRight, BellRing, BookOpen, CircleCheck, Clock3, FilePlus2, Gauge, Gavel, Hourglass, ListChecks, MessageSquareText, ScrollText, Sparkles, Timer } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useActivity, useAnalytics, useCases, useCriteriaSets, useNotifications } from "@/lib/api/hooks";
import { Can, useSession } from "@/lib/api/session";
import type { CaseSummary } from "@/lib/api/types";
import { fmtNumber, fmtPct, fmtRelative, slaParts, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { Bars, Donut, Legend, RankList, SERIES, StackedBars } from "@/components/charts/charts";
import { KpiTile, smooth } from "@/components/cases/kpi";
import { AiBadge } from "@/components/domain/trust";
import { CodeChip, ReadinessRing, SlaTimer, StatusChip } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { Avatar, Badge, Breadcrumb, Card, CardBody, CardHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";

const CLOSED = ["approved", "closed", "denied"];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Urgency tier from the payer clock (CMS-0057-F: 72 h expedited / 7 d standard). */
function urgency(c: CaseSummary): { tier: "breached" | "today" | "soon" | "ok"; label: string } {
  if (CLOSED.includes(c.status)) return { tier: "ok", label: "" };
  const p = slaParts(c.dueAt);
  if (!p) return { tier: "ok", label: "" };
  if (p.overdue) return { tier: "breached", label: "Past payer clock" };
  if (p.minutes < 24 * 60) return { tier: "today", label: "Due within 24 h" };
  if (p.minutes < 72 * 60) return { tier: "soon", label: "Due within 3 days" };
  return { tier: "ok", label: "" };
}
const TIER_RAIL = { breached: "bg-notmet", today: "bg-notmet/70", soon: "bg-insufficient", ok: "bg-transparent" } as const;

type BriefItem = { tier: "Urgent" | "Today" | "This week" | "FYI"; icon: React.ReactNode; text: React.ReactNode; action: string; href: string };

function Briefing({ cases, reviewCount, policyAlert, firstName }: { cases: CaseSummary[]; reviewCount: number; policyAlert?: { title: string; link?: string | null }; firstName?: string }) {
  const open = cases.filter((c) => !CLOSED.includes(c.status));
  const breached = open.filter((c) => urgency(c).tier === "breached");
  const due = open.filter((c) => urgency(c).tier === "today");
  const gaps = open.filter((c) => c.readiness === "gaps" && c.status === "needs_review");
  const ready = open.filter((c) => c.status === "ready");
  const unknown = open.filter((c) => c.readiness === "unknown" && c.status !== "draft");
  const items: BriefItem[] = [];
  const nums = (cs: CaseSummary[]) => cs.map((c) => c.number.slice(-5)).join(", ");
  if (breached.length)
    items.push({ tier: "Urgent", icon: <Timer className="text-notmet" />, text: <><b className="font-semibold text-fg">{breached.length} past the payer clock</b> — {nums(breached)}</>, action: "Open", href: "/cases?view=due" });
  if (due.length)
    items.push({ tier: "Urgent", icon: <Timer className="text-notmet" />, text: <><b className="font-semibold text-fg">{due.length} case{due.length > 1 ? "s" : ""} due within 24 hours</b> — {nums(due)}</>, action: "Triage", href: "/cases?view=due" });
  if (gaps.length)
    items.push({ tier: "Today", icon: <ListChecks className="text-insufficient" />, text: <><b className="font-semibold text-fg">{gaps.length} case{gaps.length > 1 ? "s have" : " has"} documentation gaps</b> Necessa can help close before submission</>, action: "Review gaps", href: "/cases?view=gaps" });
  if (unknown.length)
    items.push({ tier: "Today", icon: <BookOpen className="text-insufficient" />, text: <><b className="font-semibold text-fg">{unknown.length} case{unknown.length > 1 ? "s" : ""} couldn&apos;t be evaluated</b> — the applicable policy has no approved criteria yet</>, action: "Open queue", href: "/knowledge?tab=criteria" });
  if (ready.length)
    items.push({ tier: "This week", icon: <CircleCheck className="text-met" />, text: <><b className="font-semibold text-fg">{ready.length} ready to submit</b> — every criterion documented, letters cite chart and policy</>, action: "Submit", href: "/cases?view=ready" });
  if (reviewCount)
    items.push({ tier: "This week", icon: <BookOpen className="text-brand" />, text: <><b className="font-semibold text-fg">{reviewCount} criteria set{reviewCount > 1 ? "s" : ""}</b> await clinical review before they can be used</>, action: "Review", href: "/knowledge?tab=criteria" });
  if (policyAlert) items.push({ tier: "FYI", icon: <ScrollText className="text-ai-3" />, text: policyAlert.title, action: "View", href: policyAlert.link ?? "/policies" });

  const top = items[0];
  const headline = !top
    ? "Nothing urgent on your worklist. A good moment to clear the criteria review queue."
    : breached.length || due.length
      ? `Start with the ${breached.length + due.length} case${breached.length + due.length > 1 ? "s" : ""} on a payer clock today${gaps.length ? `, then close documentation gaps on ${gaps.length} more` : ""}.`
      : gaps.length
        ? `No clocks at risk today. Closing gaps on ${gaps.length} case${gaps.length > 1 ? "s" : ""} is the highest-impact work.`
        : `Your worklist is in good shape${ready.length ? ` — ${ready.length} ready to submit` : ""}.`;
  const tierTone = { Urgent: "notmet", Today: "insufficient", "This week": "neutral", FYI: "info" } as const;

  return (
    <section aria-label="Today's briefing" className="ai-border relative overflow-hidden rounded-xl p-4 shadow-e1 sm:p-5">
      <div className="pointer-events-none absolute -right-24 -top-28 size-72 rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--ai-2)_14%,transparent),transparent_70%)]" />
      <div className="relative flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-ai-2" />
        <h2 className="text-[13px] font-semibold">Today&apos;s briefing</h2>
        <AiBadge label="Generated" detail="Assembled from your worklist, payer clocks and the policy feed. It reflects data, not a clinical judgment." />
        <Button asChild variant="ghost" size="xs" className="ml-auto">
          <Link href="/assistant">
            <MessageSquareText /> Ask a follow-up
          </Link>
        </Button>
      </div>
      <p className="relative mt-2 max-w-3xl text-[15px] leading-relaxed text-fg">
        {firstName ? `${firstName}, ` : ""}
        {headline.charAt(0).toLowerCase() === headline.charAt(0) || !firstName ? headline : headline.charAt(0).toLowerCase() + headline.slice(1)}
      </p>
      <Stagger as="ul" className="relative mt-3 grid gap-0.5">
        {items.map((it, i) => (
          <StaggerItem as="li" key={i}>
            <Link href={it.href} className="group flex items-center gap-3 rounded-md px-2 py-1.5 text-[13px] text-muted outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2">
              <Badge tone={tierTone[it.tier]} size="xs" className="w-[70px] justify-center">
                {it.tier}
              </Badge>
              <span className="shrink-0 [&_svg]:size-4">{it.icon}</span>
              <span className="min-w-0 flex-1">{it.text}</span>
              <span className="hidden shrink-0 items-center gap-1 text-xs font-medium text-brand-fg opacity-70 transition-opacity group-hover:opacity-100 sm:inline-flex">
                {it.action} <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
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
  const firstName = me?.user.fullName.replace(/^Dr\.\s*/, "").split(" ")[0];
  const dueToday = all.filter((c) => urgency(c).tier === "today" || urgency(c).tier === "breached").length;
  const policyNotes = (notifications.data ?? []).filter((n) => n.type === "policy");

  const actions = useMemo(() => {
    const out: { title: string; why: string; href: string; tone: "high" | "medium"; cta: string }[] = [];
    for (const c of all) {
      const u = urgency(c);
      if (c.status === "draft" && c.readiness === "unknown")
        out.push({ title: `Run a medical-necessity check on ${c.number}`, why: `${c.title} hasn't been evaluated yet${u.label ? ` · ${u.label.toLowerCase()}` : ""}`, href: `/cases/${c.id}?evaluate=1`, tone: u.tier === "ok" ? "medium" : "high", cta: "Evaluate" });
      if (c.readiness === "gaps" && c.status === "needs_review")
        out.push({ title: `Close gaps on ${c.number}`, why: `Readiness ${fmtPct(c.readinessScore)} · ${c.priority === "expedited" ? "expedited, 72 h clock" : "standard, 7 d clock"}${u.label ? ` · ${u.label.toLowerCase()}` : ""}`, href: `/cases/${c.id}?tab=gaps`, tone: c.priority === "expedited" || u.tier !== "ok" ? "high" : "medium", cta: "Fix gaps" });
      if (c.status === "denied") out.push({ title: `Start an appeal for ${c.number}`, why: "The denial reason maps to a documentation criterion that can be addressed", href: `/cases/${c.id}?tab=denials`, tone: "high", cta: "Appeal" });
      if (c.status === "ready") out.push({ title: `Submit ${c.number}`, why: "Every criterion is documented and the letter cites chart and policy", href: `/cases/${c.id}?tab=letters`, tone: "medium", cta: "Review & submit" });
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
        {cases.isPending ? (
          <Skeleton className="h-44 rounded-xl" />
        ) : (
          <FadeIn>
            <Briefing cases={all} reviewCount={review.data?.total ?? 0} policyAlert={policyNotes[0]} firstName={firstName} />
          </FadeIn>
        )}

        <Stagger className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {a ? (
            <>
              <StaggerItem>
                <KpiTile
                  label="Open cases"
                  value={a.kpis.openCases}
                  icon={<Hourglass />}
                  note={dueToday ? { text: `${dueToday} due within 24 h`, tone: "warn" } : { text: "No payer clocks at risk today", tone: "good" }}
                  spark={smooth(a.trends.casesByDay.map((d) => d.count))}
                  hint="New cases per day, 7-day average"
                />
              </StaggerItem>
              <StaggerItem>
                <KpiTile
                  label="Ready-to-submit rate"
                  value={Math.round(a.kpis.readyRate * 100)}
                  format={(n) => `${Math.round(n)}%`}
                  icon={<Gauge />}
                  trend={{ delta: 6, label: "pts vs. prior 30d", goodWhen: "up" }}
                  spark={a.trends.readinessByWeek.map((w) => w.ready / Math.max(1, w.ready + w.gaps + w.notSupported))}
                  hint="Share of evaluated cases with every criterion documented"
                />
              </StaggerItem>
              <StaggerItem>
                <KpiTile
                  label="Gaps caught pre-submission"
                  value={a.kpis.gapsCaughtPreSubmission}
                  icon={<ListChecks />}
                  trend={{ delta: 11, label: "this month", goodWhen: "up" }}
                  note={{ text: "Fixed before the payer saw them" }}
                  hint="Criteria flagged Insufficient or Not met before the packet went to the payer"
                />
              </StaggerItem>
              <StaggerItem>
                <KpiTile
                  label="Est. staff hours saved"
                  value={a.kpis.estimatedHoursSaved}
                  format={(n) => fmtNumber(n, { maximumFractionDigits: 1 })}
                  icon={<Clock3 />}
                  note={{ text: `Avg. turnaround ${Math.round(a.kpis.avgTurnaroundHours)} h` }}
                  hint="Estimate against the AMA 2025 benchmark of ~13 staff hours per physician per week"
                />
              </StaggerItem>
            </>
          ) : (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px] rounded-xl" />)
          )}
        </Stagger>

        <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <Card>
            <CardHeader
              title="Needs attention"
              description="Ordered by payer clock · 72 h expedited, 7 d standard"
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
                <Stagger as="ul">
                  {attention.map((c) => {
                    const u = urgency(c);
                    return (
                      <StaggerItem as="li" key={c.id}>
                        <Link
                          href={`/cases/${c.id}`}
                          className="relative grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t border-border/70 px-4 py-2.5 outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2/60 sm:grid-cols-[auto_1fr_auto_auto]"
                        >
                          <span aria-hidden className={cn("absolute inset-y-1.5 left-0 w-[3px] rounded-r-full", TIER_RAIL[u.tier])} />
                          <ReadinessRing size={32} stroke={3} readiness={c.readiness} score={c.readinessScore} />
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-fg">
                              {c.title}
                              {u.label ? <span className="sr-only"> — {u.label}</span> : null}
                            </p>
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
                      </StaggerItem>
                    );
                  })}
                </Stagger>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Next best actions" description="Ranked by payer clock and readiness impact" icon={<Sparkles className="text-ai-2" />} />
            <CardBody className="grid gap-1.5">
              {actions.length === 0 ? <p className="py-6 text-center text-[13px] text-muted">You&apos;re ahead of the queue.</p> : null}
              <Stagger className="grid gap-1.5">
                {actions.map((x) => (
                  <StaggerItem key={x.title}>
                    <Link href={x.href} className="group flex items-start gap-3 rounded-lg border border-border p-3 outline-none transition-[border-color,background-color] hover:border-border-strong hover:bg-surface-2/50 focus-visible:border-brand">
                      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", x.tone === "high" ? "bg-notmet" : "bg-insufficient")} aria-label={x.tone === "high" ? "High priority" : "Medium priority"} />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="text-[13px] font-medium text-fg">{x.title}</span>
                        <span className="text-xs text-muted">
                          <span className="font-medium text-subtle">Why: </span>
                          {x.why}
                        </span>
                      </span>
                      <span className="mt-0.5 hidden shrink-0 items-center gap-1 text-xs font-medium text-brand-fg sm:inline-flex">
                        {x.cta} <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                      </span>
                    </Link>
                  </StaggerItem>
                ))}
              </Stagger>
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

        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[1fr_1fr_1.1fr]">
          <Card>
            <CardHeader title="Denial reasons" description="Last 90 days" icon={<Gavel />} />
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
          <Card className="lg:col-span-2 xl:col-span-1">
            <CardHeader title="Policy changes" description="Coverage updates that affect your services" icon={<BellRing />} />
            <CardBody className="grid gap-2">
              {notifications.isPending ? (
                <Skeleton className="h-24" />
              ) : policyNotes.length ? (
                policyNotes.slice(0, 3).map((n) => (
                  <Link key={n.id} href={n.link ?? "/policies"} className="group grid gap-0.5 rounded-lg border border-border p-2.5 outline-none transition-colors hover:border-border-strong focus-visible:border-brand">
                    <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                      <ScrollText className="size-3.5 shrink-0 text-ai-3" />
                      <span className="min-w-0 truncate">{n.title}</span>
                      {!n.readAt ? <span className="ml-auto size-1.5 shrink-0 rounded-full bg-brand" aria-label="Unread" /> : null}
                    </span>
                    <span className="line-clamp-2 pl-5 text-xs text-muted">{n.body}</span>
                    <span className="pl-5 text-[11px] text-subtle">{fmtRelative(n.createdAt)}</span>
                  </Link>
                ))
              ) : (
                <p className="py-4 text-center text-[13px] text-muted">No policy changes in the last 30 days.</p>
              )}
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader title="Activity" description="Across your organization" />
          <CardBody>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {(activity.data ?? []).slice(0, 6).map((e) => (
                <li key={e.id}>
                  <Link href={e.link ?? "#"} className="flex items-start gap-2.5 rounded-md text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
                    <Avatar name={e.actor?.fullName ?? "Necessa"} color={e.actor?.avatarColor ?? "var(--brand)"} size={22} />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium text-fg">{e.actor?.fullName ?? "Necessa"}</span> <span className="text-muted">{e.verb}</span> <span className="text-fg">{e.target}</span>
                      <span className="block text-xs text-subtle">{fmtRelative(e.createdAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {activity.isPending ? <Skeleton className="h-24" /> : null}
          </CardBody>
        </Card>
      </div>
    </AppPage>
  );
}
