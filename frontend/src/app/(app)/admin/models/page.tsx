"use client";

import { CircleCheck, CircleSlash, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useModels, useModelUsage, useTestModelGroup } from "@/lib/api/hooks";
import type { ModelGroup } from "@/lib/api/types";
import { fmtMs, fmtNumber, fmtPct } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { Bars } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Breadcrumb, Card, CardBody, CardHeader, PageHeader, Skeleton } from "@/components/ui/display";
import { StatCard } from "@/components/ui/widgets";

/** What each service does, in the words a practice would use. */
const SERVICES: Record<string, { name: string; does: string }> = {
  "router-small": { name: "Quick checks", does: "Understands short requests" },
  "qa-public": { name: "Policy questions", does: "Answers questions about coverage policies" },
  judge: { name: "Chart review", does: "Checks the chart against each requirement" },
  verifier: { name: "Second review", does: "Double-checks every result" },
  sql: { name: "Insights questions", does: "Answers questions about your cases" },
  drafter: { name: "Letter drafting", does: "Drafts letters and appeals" },
  "compiler-longctx": { name: "Policy reading", does: "Prepares requirements checklists from policies" },
  "ocr-vision": { name: "Scanned documents", does: "Reads scanned pages" },
  guard: { name: "Safety screening", does: "Screens documents and requests" },
};
const serviceOf = (g: string) => SERVICES[g] ?? { name: g.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase()), does: "" };

type Status = "ok" | "backup" | "off";
function statusOf(g: ModelGroup): Status {
  const live = g.deployments.filter((d) => d.configured);
  if (live.length === 0) return "off";
  const usable = (d: (typeof live)[number]) => d.healthy !== false && !d.cooldownUntil;
  if (usable(live[0]!)) return "ok";
  return live.some(usable) ? "backup" : "off";
}
const STATUS: Record<Status, { label: string; tone: string }> = {
  ok: { label: "Operational", tone: "text-met-fg" },
  backup: { label: "Running on a backup", tone: "text-insufficient-fg" },
  off: { label: "Not connected", tone: "text-subtle" },
};

export default function ServiceStatusPage() {
  const models = useModels();
  const [range, setRange] = useState("7d");
  const usage = useModelUsage(range);
  const test = useTestModelGroup();
  const u = usage.data;

  const totals = useMemo(() => {
    const rows = u?.byDeployment ?? [];
    const calls = rows.reduce((a, r) => a + r.calls, 0);
    const sum = (k: "errors" | "cacheHits" | "fallbacks") => rows.reduce((a, r) => a + r[k], 0);
    return { calls, errors: sum("errors"), cached: sum("cacheHits"), backup: sum("fallbacks") };
  }, [u]);
  const daily = useMemo(() => {
    const by = new Map<string, number>();
    for (const d of u?.daily ?? []) by.set(d.date, (by.get(d.date) ?? 0) + d.calls);
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, calls]) => ({ date, calls }));
  }, [u]);
  const callsByGroup = useMemo(() => {
    const m = new Map<string, { calls: number; errors: number }>();
    for (const r of u?.byDeployment ?? []) {
      const cur = m.get(r.group) ?? { calls: 0, errors: 0 };
      m.set(r.group, { calls: cur.calls + r.calls, errors: cur.errors + r.errors });
    }
    return m;
  }, [u]);
  const rate = (n: number) => (totals.calls ? n / totals.calls : 0);
  const groups = models.data?.groups ?? [];
  const phiServices = (models.data?.phiAllowedGroups ?? []).map((g) => serviceOf(g).name);

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Service status" }]} />} wide>
      <PageHeader
        title="Service status"
        description="Whether the services Necessa relies on are available, and how much they're being used."
        actions={<Segmented value={range} onValueChange={setRange} options={[{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }]} />}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Requests handled" value={u ? fmtNumber(totals.calls) : "–"} />
        <StatCard label="Answered from saved results" value={u ? fmtPct(rate(totals.cached)) : "–"} />
        <StatCard label="Served by a backup" value={u ? fmtPct(rate(totals.backup), 1) : "–"} />
        <StatCard label="Needed a retry" value={u ? fmtPct(rate(totals.errors), 1) : "–"} />
      </div>

      <Card className="mb-5">
        <CardHeader title="Daily activity" description="Requests handled each day" />
        <CardBody>{u ? <Bars data={daily} x="date" y="calls" height={200} /> : <Skeleton className="h-[200px]" />}</CardBody>
      </Card>

      <Card>
        <CardHeader title="Services" description="Each service has backups, so one outage doesn't stop your work." />
        <CardBody className="px-0 pb-1">
          {models.isPending ? (
            <Skeleton className="mx-4 h-60" />
          ) : (
            <ul className="divide-y divide-border">
              {groups.map((g) => {
                const svc = serviceOf(g.name);
                const st = statusOf(g);
                const use = callsByGroup.get(g.name);
                const slow = g.deployments.find((d) => d.configured && d.p50LatencyMs);
                return (
                  <li key={g.name} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[1.4fr_1fr_1fr_auto]">
                    <div className="grid min-w-0">
                      <span className="text-[13.5px] font-medium text-fg">{svc.name}</span>
                      <span className="truncate text-xs text-muted">{svc.does}</span>
                    </div>
                    <span className={`flex items-center gap-1.5 text-[13px] ${STATUS[st].tone}`}>
                      {st === "ok" ? <CircleCheck className="size-3.5" /> : st === "backup" ? <RefreshCw className="size-3.5" /> : <CircleSlash className="size-3.5" />}
                      {STATUS[st].label}
                    </span>
                    <span className="hidden text-xs text-muted sm:block">
                      {use ? `${fmtNumber(use.calls)} ${use.calls === 1 ? "request" : "requests"}` : "No requests yet"}
                      {slow?.p50LatencyMs ? ` · typically ${fmtMs(slow.p50LatencyMs)}` : ""}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={st === "off"}
                      loading={test.isPending && test.variables === g.name}
                      onClick={() =>
                        test.mutate(g.name, {
                          onSuccess: (r) => toast.success(`${svc.name} is responding`, { description: `Replied in ${fmtMs(r.latencyMs)}` }),
                        })
                      }
                    >
                      Check
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {phiServices.length ? (
        <p className="mt-4 text-xs leading-relaxed text-muted">
          Only these services may receive patient information, and only after it has been masked: {phiServices.join(", ")}.
        </p>
      ) : null}
    </AppPage>
  );
}
