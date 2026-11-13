"use client";

import { ArrowRight, FilePlus2 } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { useActivity, useAnalytics, useCases, useNotifications } from "@/lib/api/hooks";
import { Can, useSession } from "@/lib/api/session";
import type { CaseSummary } from "@/lib/api/types";
import { fmtNumber, fmtPct, fmtRelative, slaParts, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { Donut, Legend, RankList, SERIES, StackedBars } from "@/components/charts/charts";
import { KpiTile } from "@/components/cases/kpi";
import { CodeChip, ReadinessRing, SlaTimer, StatusChip } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { Avatar, Breadcrumb, Card, CardBody, CardHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { FadeIn, Stagger, StaggerItem } from "@/components/ui/motion";

const CLOSED = ["approved", "closed", "denied"];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Urgency from the payer deadline (CMS-0057-F: 72 hours urgent / 7 days standard). */
function urgency(c: CaseSummary): { tier: "past" | "today" | "soon" | "ok"; label: string } {
  if (CLOSED.includes(c.status)) return { tier: "ok", label: "" };
  const p = slaParts(c.dueAt);
  if (!p) return { tier: "ok", label: "" };
  if (p.overdue) return { tier: "past", label: "Past the payer deadline" };
  if (p.minutes < 24 * 60) return { tier: "today", label: "Due within 24 hours" };
  if (p.minutes < 72 * 60) return { tier: "soon", label: "Due within 3 days" };
  return { tier: "ok", label: "" };
}
const TIER_RAIL = { past: "bg-notmet", today: "bg-notmet/70", soon: "bg-insufficient", ok: "bg-transparent" } as const;

type Line = { tone: "urgent" | "normal" | "good"; text: React.ReactNode; action: string; href: string };

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Plain-language summary of what needs attention today. */
function Today({ cases, policyAlert, firstName }: { cases: CaseSummary[]; policyAlert?: { title: string; link?: string | null }; firstName?: string }) {
  const open = cases.filter((c) => !CLOSED.includes(c.status));
  const past = open.filter((c) => urgency(c).tier === "past");
  const today = open.filter((c) => urgency(c).tier === "today");
  const gaps = open.filter((c) => c.readiness === "gaps" && c.status === "needs_review");
  const unchecked = open.filter((c) => c.status === "draft" && c.readiness === "unknown");
  const ready = open.filter((c) => c.status === "ready");
  const nums = (cs: CaseSummary[]) => cs.slice(0, 4).map((c) => c.number.slice(-5)).join(", ") + (cs.length > 4 ? "…" : "");

  const lines: Line[] = [];
  if (past.length) lines.push({ tone: "urgent", text: <><b className="font-medium text-fg">{plural(past.length, "case")} past the payer deadline</b> ({nums(past)})</>, action: "Open", href: "/cases?view=due" });
  if (today.length) lines.push({ tone: "urgent", text: <><b className="font-medium text-fg">{plural(today.length, "case")} due within 24 hours</b> ({nums(today)})</>, action: "Open", href: "/cases?view=due" });
  if (gaps.length) lines.push({ tone: "normal", text: <><b className="font-medium text-fg">{plural(gaps.length, "case")}</b> with documentation gaps to close before submitting</>, action: "Review", href: "/cases?view=gaps" });
  if (unchecked.length) lines.push({ tone: "normal", text: <><b className="font-medium text-fg">{plural(unchecked.length, "case")}</b> not yet checked against the payer policy</>, action: "Start checks", href: "/cases" });
  if (ready.length) lines.push({ tone: "good", text: <><b className="font-medium text-fg">{ready.length} ready to submit</b>, with every requirement documented</>, action: "Submit", href: "/cases?view=ready" });
  if (policyAlert) lines.push({ tone: "normal", text: policyAlert.title, action: "View", href: policyAlert.link ?? "/policies" });

  const urgent = past.length + today.length;
  const headline = urgent
    ? `${plural(urgent, "case")} ${urgent === 1 ? "is" : "are"} close to the payer deadline. Start there.`
    : gaps.length
      ? `Nothing is at risk of missing a deadline today. Closing documentation gaps on ${plural(gaps.length, "case")} is the best use of your time.`
      : unchecked.length
        ? `${plural(unchecked.length, "case")} ${unchecked.length === 1 ? "is" : "are"} waiting for a first check against the payer policy.`
        : ready.length
          ? `${ready.length} ${ready.length === 1 ? "case is" : "cases are"} ready to submit.`
          : "Your worklist is clear.";

  return (
    <section aria-label="Today" className="rounded-lg border border-border bg-surface p-5">
      <h2 className="text-xs font-medium uppercase tracking-wide text-subtle">Today</h2>
      <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-fg">
        {firstName ? `${firstName}, ` : ""}
        {firstName ? headline.charAt(0).toLowerCase() + headline.slice(1) : headline}
      </p>
      {lines.length ? (
        <ul className="mt-3 grid divide-y divide-border/70 border-t border-border/70">
          {lines.map((l, i) => (
            <li key={i}>
              <Link href={l.href} className="group flex items-center gap-3 py-2.5 text-[13px] text-muted outline-none transition-colors hover:text-fg focus-visible:text-fg">
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", l.tone === "urgent" ? "bg-notmet" : l.tone === "good" ? "bg-met" : "bg-border-strong")} />
                <span className="sr-only">{l.tone === "urgent" ? "Urgent: " : ""}</span>
                <span className="min-w-0 flex-1">{l.text}</span>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-fg">
                  {l.action} <ArrowRight className="size-3.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default function DashboardPage() {
  const { me } = useSession();
  // The API caps list requests at 100 cases; the dashboard works from the most urgent 100.
  const cases = useCases({ sort: "dueAt", limit: 100 });
  const analytics = useAnalytics("30d");
  const activity = useActivity();
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
  const policyNotes = (notifications.data ?? []).filter((n) => n.type === "policy");

  const steps = useMemo(() => {
    const out: { title: string; why: string; href: string; high: boolean; cta: string }[] = [];
    for (const c of all) {
      const u = urgency(c);
      if (c.status === "draft" && c.readiness === "unknown")
        out.push({ title: `Check ${c.number} against the policy`, why: `${c.title} hasn't been checked yet${u.label ? ` · ${u.label.toLowerCase()}` : ""}`, href: `/cases/${c.id}?evaluate=1`, high: u.tier !== "ok", cta: "Run check" });
      if (c.readiness === "gaps" && c.status === "needs_review")
        out.push({ title: `Close the gaps on ${c.number}`, why: `${fmtPct(c.readinessScore)} of requirements documented · ${c.priority === "expedited" ? "urgent, 72 hour deadline" : "standard, 7 day deadline"}`, href: `/cases/${c.id}?tab=gaps`, high: c.priority === "expedited" || u.tier !== "ok", cta: "Open gaps" });
      if (c.status === "denied") out.push({ title: `Start an appeal for ${c.number}`, why: "The denial reason points to documentation you can add", href: `/cases/${c.id}?tab=denials`, high: true, cta: "Appeal" });
      if (c.status === "ready") out.push({ title: `Submit ${c.number}`, why: "Every requirement is documented and the letter cites the sources", href: `/cases/${c.id}?tab=letters`, high: false, cta: "Review and submit" });
    }
    return out.sort((x, y) => Number(y.high) - Number(x.high)).slice(0, 5);
  }, [all]);

  const checked = a ? a.trends.readinessByWeek.reduce((n, w) => n + w.ready + w.gaps + w.notSupported, 0) : 0;
  const turnaround = (a?.kpis.avgTurnaroundHours ?? null) as number | null; // null until a case has been completed
  const turnaroundFmt = (h: number) => (h >= 48 ? `${fmtNumber(h / 24, { maximumFractionDigits: 1 })} days` : `${Math.round(h)} h`);

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Home" }]} />}>
      <div className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs text-subtle">{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
          <h1 className="mt-1 text-xl font-semibold">
            {greeting()}
            {firstName ? `, ${firstName}` : ""}
          </h1>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="secondary">
            <Link href="/assistant">Ask Necessa</Link>
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
          <Skeleton className="h-44 rounded-lg" />
        ) : (
          <FadeIn>
            <Today cases={all} policyAlert={policyNotes[0]} firstName={firstName} />
          </FadeIn>
        )}

        <Stagger className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {a ? (
            <>
              <StaggerItem>
                <KpiTile
                  label="Ready to submit"
                  value={checked ? Math.round(a.kpis.readyRate * 100) : null}
                  format={(n) => `${Math.round(n)}%`}
                  note={{ text: checked ? `of ${plural(checked, "checked case")}` : "No cases checked yet" }}
                  hint="Share of checked cases where every requirement is documented"
                />
              </StaggerItem>
              <StaggerItem>
                <KpiTile
                  label="Average turnaround"
                  value={turnaround}
                  format={turnaroundFmt}
                  note={{ text: "Deadlines: 72 h urgent, 7 d standard" }}
                  hint="Time from case creation to ready for submission"
                />
              </StaggerItem>
              <StaggerItem>
                <KpiTile
                  label="Gaps fixed before submitting"
                  value={a.kpis.gapsCaughtPreSubmission}
                  note={{ text: "Found before the payer saw the request" }}
                  hint="Missing or unclear documentation caught before submission"
                />
              </StaggerItem>
              <StaggerItem>
                <KpiTile
                  label="Staff hours saved (est.)"
                  value={a.kpis.estimatedHoursSaved}
                  format={(n) => fmtNumber(n, { maximumFractionDigits: 1 })}
                  note={{ text: "AMA 2025 survey benchmark" }}
                  hint="Estimate: 15 minutes per completed check and 20 minutes per drafted letter"
                />
              </StaggerItem>
            </>
          ) : (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-lg" />)
          )}
        </Stagger>

        <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <Card>
            <CardHeader
              title="Needs attention"
              description="Ordered by payer deadline"
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
              ) : cases.isError ? (
                <EmptyState compact art="cases" title="We couldn't load your cases" description="Refresh the page to try again." />
              ) : attention.length === 0 ? (
                <EmptyState compact art="cases" title="Nothing needs attention" description="New cases will show up here." />
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
            <CardHeader title="Suggested next steps" description="Most urgent first" />
            <CardBody className="grid gap-1.5">
              {steps.length === 0 ? <p className="py-6 text-center text-[13px] text-muted">You&apos;re all caught up.</p> : null}
              <Stagger className="grid gap-1.5">
                {steps.map((x) => (
                  <StaggerItem key={x.title}>
                    <Link href={x.href} className="group flex items-start gap-3 rounded-md border border-border p-3 outline-none transition-colors hover:border-border-strong focus-visible:border-brand">
                      <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", x.high ? "bg-notmet" : "bg-border-strong")} />
                      <span className="sr-only">{x.high ? "High priority. " : ""}</span>
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="text-[13px] font-medium text-fg">{x.title}</span>
                        <span className="text-xs text-muted">{x.why}</span>
                      </span>
                      <span className="mt-0.5 hidden shrink-0 items-center gap-1 text-xs font-medium text-brand-fg sm:inline-flex">
                        {x.cta} <ArrowRight className="size-3.5" />
                      </span>
                    </Link>
                  </StaggerItem>
                ))}
              </Stagger>
            </CardBody>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader title="Readiness over time" description="Checked cases, last 30 days" />
            <CardBody>
              {a ? (
                a.trends.readinessByWeek.length ? (
                  <StackedBars
                    data={a.trends.readinessByWeek}
                    x="week"
                    height={180}
                    series={[
                      { key: "ready", label: "Ready", color: "var(--met)" },
                      { key: "gaps", label: "Gaps to close", color: "var(--insufficient)" },
                      { key: "notSupported", label: "Not supported", color: "var(--notmet)" },
                    ]}
                  />
                ) : (
                  <EmptyState compact art="chart" title="No checked cases yet" />
                )
              ) : (
                <Skeleton className="h-[180px]" />
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Most common documentation gaps" description="Found before submission this month" />
            <CardBody>
              {a ? (
                a.topGapCriteria.length ? (
                  <RankList items={a.topGapCriteria.slice(0, 5).map((g) => ({ label: g.criterionText, value: g.count }))} />
                ) : (
                  <EmptyState compact art="chart" title="No gaps recorded yet" />
                )
              ) : (
                <Skeleton className="h-[180px]" />
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Denial reasons" description="Last 90 days" />
            <CardBody className="grid grid-cols-[120px_1fr] items-center gap-4">
              {a && a.denialReasons.length ? (
                <>
                  <Donut data={a.denialReasons} nameKey="category" valueKey="count" height={120} />
                  <Legend items={a.denialReasons.map((d, i) => ({ label: titleCase(d.category), color: SERIES[i % SERIES.length]!, value: d.count }))} />
                </>
              ) : a ? (
                <p className="col-span-2 py-8 text-center text-[13px] text-muted">No denials recorded.</p>
              ) : (
                <Skeleton className="col-span-2 h-[120px]" />
              )}
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader title="Recent activity" description="Across your practice" />
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
