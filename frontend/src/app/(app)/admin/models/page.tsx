"use client";

import { Activity, CircleCheck, CircleSlash, Cpu, FlaskConical, Gauge, Lock, RefreshCw, Repeat2, ShieldCheck, Zap } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useModels, useModelUsage, useTestModelGroup } from "@/lib/api/hooks";
import type { ModelDeployment } from "@/lib/api/types";
import { fmtCompact, fmtMs, fmtNumber, fmtPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { LineTrend, StackedBars } from "@/components/charts/charts";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Progress, Skeleton } from "@/components/ui/display";
import { Tooltip } from "@/components/ui/overlays";
import { StatCard } from "@/components/ui/widgets";

function DeploymentRow({ d, primary }: { d: ModelDeployment; primary: boolean }) {
  const quota = d.rpd ? d.usedToday / d.rpd : 0;
  const state = !d.configured ? "unconfigured" : d.cooldownUntil ? "cooldown" : d.healthy ? "healthy" : "unhealthy";
  return (
    <div className={cn("grid items-center gap-2 rounded-lg px-3 py-2 sm:grid-cols-[1.4fr_0.9fr_1fr_auto]", primary ? "bg-surface-2/70" : "")}>
      <div className="flex min-w-0 items-center gap-2">
        {state === "healthy" ? <CircleCheck className="size-3.5 shrink-0 text-met" /> : state === "cooldown" ? <RefreshCw className="size-3.5 shrink-0 text-insufficient" /> : <CircleSlash className="size-3.5 shrink-0 text-subtle" />}
        <span className="min-w-0 truncate font-mono text-xs text-fg">
          {d.provider}/<span className="font-semibold">{d.model}</span>
        </span>
        {primary ? <Badge tone="brand" size="xs">primary</Badge> : <Badge size="xs">fallback</Badge>}
      </div>
      <span className="text-xs text-muted">
        {state === "unconfigured" ? "No API key" : state === "cooldown" ? "Cooling down after 429s" : `p50 ${fmtMs(d.p50LatencyMs)} · err ${fmtPct(d.errorRate, 1)}`}
      </span>
      {d.rpd ? (
        <Tooltip content={`${d.usedToday} of ${d.rpd} requests/day on the free tier (${d.rpm ?? "—"} RPM)`}>
          <span className="flex items-center gap-2">
            <Progress value={quota} tone={quota > 0.85 ? "notmet" : quota > 0.6 ? "insufficient" : "brand"} />
            <span className="tabular w-14 shrink-0 text-right text-[11px] text-muted">{fmtPct(quota)}</span>
          </span>
        </Tooltip>
      ) : (
        <span className="text-[11px] text-subtle">—</span>
      )}
      <span />
    </div>
  );
}

export default function ModelsPage() {
  const models = useModels();
  const [range, setRange] = useState("7d");
  const usage = useModelUsage(range);
  const test = useTestModelGroup();
  const u = usage.data;

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Administration" }, { label: "Models & providers" }]} />} wide>
      <PageHeader
        title="Models & providers"
        description="Every model call goes through LiteLLM: one model group per job, fallbacks across providers, free-tier quota awareness, and data-class enforcement."
        actions={<Segmented value={range} onValueChange={setRange} options={[{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }]} />}
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Model calls" value={u ? fmtCompact(u.totals.calls) : "—"} icon={<Activity />} />
        <StatCard label="Tokens" value={u ? fmtCompact(u.totals.tokens) : "—"} icon={<Cpu />} hint="Cost is $0 on free tiers — tokens are still budgeted per case and per org" />
        <StatCard label="Cache hit rate" value={u ? fmtPct(u.totals.cacheHitRate) : "—"} icon={<Zap />} />
        <StatCard label="Fallback rate" value={u ? fmtPct(u.totals.fallbackRate, 1) : "—"} icon={<Repeat2 />} />
        <StatCard label="Error rate" value={u ? fmtPct(u.totals.errorRate, 1) : "—"} icon={<Gauge />} />
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Calls by day" description="Successful calls, cache hits and fallbacks" />
          <CardBody>
            {u ? (
              <StackedBars
                data={u.byDay.map((d) => ({ ...d, served: d.calls - d.cacheHits - d.fallbacks }))}
                x="date"
                series={[
                  { key: "served", label: "Primary", color: "var(--brand)" },
                  { key: "fallbacks", label: "Fallback", color: "var(--insufficient)" },
                  { key: "cacheHits", label: "Cache hit", color: "var(--met)" },
                ]}
              />
            ) : (
              <Skeleton className="h-[220px]" />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Errors by day" description="Includes rate-limit (429) responses before fallback" />
          <CardBody>{u ? <LineTrend data={u.byDay} x="date" series={[{ key: "errors", label: "Errors", color: "var(--notmet)" }]} /> : <Skeleton className="h-[220px]" />}</CardBody>
        </Card>
      </div>

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="Providers" />
          <CardBody className="overflow-x-auto px-0">
            <table className="w-full min-w-[460px] text-[13px]">
              <thead className="text-xs text-muted">
                <tr>
                  {["Provider", "Calls", "Tokens", "p50 latency", "Error rate"].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(u?.byProvider ?? []).map((p) => (
                  <tr key={p.provider} className="border-t border-border/70">
                    <td className="px-4 py-2 font-mono text-xs font-medium">{p.provider}</td>
                    <td className="tabular px-4 py-2">{fmtNumber(p.calls)}</td>
                    <td className="tabular px-4 py-2">{p.tokens ? fmtCompact(p.tokens) : "—"}</td>
                    <td className="tabular px-4 py-2">{fmtMs(p.p50LatencyMs)}</td>
                    <td className={cn("tabular px-4 py-2", p.errorRate > 0.05 && "text-notmet-fg")}>{fmtPct(p.errorRate, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Retrieval models" />
          <CardBody className="grid gap-3 text-[13px]">
            {models.data ? (
              <>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted">Embedding (index pinned — never mixed across vector spaces)</p>
                  <p className="mt-1 font-mono text-xs font-medium">
                    {models.data.embedding.model} · {models.data.embedding.dims}d
                  </p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted">Reranker chain</p>
                  <ol className="mt-1.5 grid gap-1">
                    {models.data.reranker.chain.map((r, i) => (
                      <li key={r} className="flex items-center gap-2 font-mono text-xs">
                        <span className="tabular text-subtle">{i + 1}.</span>
                        {r}
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            ) : (
              <Skeleton className="h-32" />
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Model groups" description="Routing table — the first healthy, configured deployment serves; others are fallbacks. PHI-class groups only receive de-identified text." />
        <CardBody className="grid gap-3">
          {models.isPending ? <Skeleton className="h-80" /> : null}
          {(models.data?.groups ?? []).map((g) => (
            <div key={g.name} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center gap-2 px-1 pb-2">
                <span className="font-mono text-[13px] font-semibold text-fg">{g.name}</span>
                <span className="text-xs text-muted">{g.purpose}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {g.dataClasses.map((dc) => (
                    <Badge key={dc} tone={dc === "PHI" ? "insufficient" : "neutral"} size="xs">
                      {dc === "PHI" ? <Lock /> : <ShieldCheck />} {dc}
                    </Badge>
                  ))}
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={test.isPending && test.variables === g.name}
                    onClick={() =>
                      test.mutate(g.name, {
                        onSuccess: (r) => toast.success(`${g.name} OK`, { description: `${r.provider}/${r.model} · ${fmtMs(r.latencyMs)} · ${r.sample}` }),
                      })
                    }
                  >
                    <FlaskConical /> Test
                  </Button>
                </span>
              </div>
              <div className="grid gap-1">
                {g.deployments.map((d, i) => (
                  <DeploymentRow key={`${d.provider}-${d.model}`} d={d} primary={i === 0} />
                ))}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>
    </AppPage>
  );
}
