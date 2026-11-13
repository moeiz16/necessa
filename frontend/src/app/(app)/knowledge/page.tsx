"use client";

import { ArrowRight, CircleCheck, CircleDashed, CircleX, Database, DownloadCloud, Eraser, GitBranch, Layers, ListChecks, RotateCcw, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useActivateIndex, useCacheStats, useCompileCriteria, useCriteriaSets, useFlushCache, useIndexes, useIngestionRuns, useKnowledgeStats, useRollbackIndex, useStartIngestion } from "@/lib/api/hooks";
import type { IndexVersion } from "@/lib/api/types";
import { fmtCompact, fmtDateTime, fmtNumber, fmtPct, fmtRelative, titleCase } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Progress, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownTrigger, Tooltip } from "@/components/ui/overlays";
import { StatCard } from "@/components/ui/widgets";

const STATUS_ICON = { succeeded: CircleCheck, failed: CircleX, running: CircleDashed, queued: CircleDashed } as const;

function IndexRow({ v, onActivate, busy }: { v: IndexVersion; onActivate: () => void; busy: boolean }) {
  return (
    <tr className="border-t border-border/70">
      <td className="px-4 py-2.5">
        <span className="grid">
          <span className="font-mono text-xs font-medium text-fg">{v.physicalName}</span>
          <span className="text-[11px] text-subtle">created {fmtRelative(v.createdAt)}</span>
        </span>
      </td>
      <td className="px-4 py-2.5">
        <Badge tone={v.status === "active" ? "met" : v.status === "ready" ? "brand" : v.status === "failed" ? "notmet" : "neutral"} dot>
          {v.status}
        </Badge>
      </td>
      <td className="tabular px-4 py-2.5 text-muted">{fmtNumber(v.points)}</td>
      <td className="px-4 py-2.5 font-mono text-[11px] text-muted">
        {v.embedModel} · {v.dims}d<br />
        {v.sparseModel}
      </td>
      <td className="px-4 py-2.5 text-xs text-muted">
        {Object.entries(v.stats)
          .slice(0, 2)
          .map(([k, val]) => `${k} ${typeof val === "number" && val < 1 ? val.toFixed(3) : val}`)
          .join(" · ")}
      </td>
      <td className="px-4 py-2.5 text-right">
        {v.status === "ready" ? (
          <Button size="xs" variant="primary" onClick={onActivate} loading={busy}>
            <Zap /> Activate
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

function KnowledgeInner() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") ?? "ingestion";
  const stats = useKnowledgeStats();
  const runs = useIngestionRuns();
  const indexes = useIndexes();
  const criteria = useCriteriaSets();
  const cache = useCacheStats();
  const start = useStartIngestion();
  const activate = useActivateIndex();
  const rollback = useRollbackIndex();
  const compile = useCompileCriteria();
  const flush = useFlushCache();
  const aliases = Array.from(new Set((indexes.data ?? []).map((i) => i.alias)));
  const review = (criteria.data?.items ?? []).filter((c) => c.status === "needs_review");

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Administration" }, { label: "Knowledge ops" }]} />} wide>
      <PageHeader
        title="Knowledge ops"
        description="Ingestion, versioned indexes, compiled criteria and caches — the machinery behind every grounded answer."
        actions={
          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant="primary">
                <DownloadCloud /> Run ingestion
              </Button>
            </DropdownTrigger>
            <DropdownContent className="w-80">
              <DropdownLabel>Source & scope</DropdownLabel>
              <DropdownItem onSelect={() => start.mutate({ source: "mcd", scope: "focus" })} className="items-start">
                <Database className="mt-0.5" />
                <span className="grid">
                  <span>CMS MCD — focus scope</span>
                  <span className="text-xs text-muted">NCDs + PA-heavy LCDs/articles · incremental</span>
                </span>
              </DropdownItem>
              <DropdownItem onSelect={() => start.mutate({ source: "mcd", scope: "full" })} className="items-start">
                <Layers className="mt-0.5" />
                <span className="grid">
                  <span>CMS MCD — full corpus</span>
                  <span className="text-xs text-muted">Resumable · quota-paced over several days</span>
                </span>
              </DropdownItem>
              <DropdownItem onSelect={() => start.mutate({ source: "codesets", scope: "full" })} className="items-start">
                <ListChecks className="mt-0.5" />
                <span className="grid">
                  <span>Code sets</span>
                  <span className="text-xs text-muted">ICD-10-CM · HCPCS Level II</span>
                </span>
              </DropdownItem>
            </DropdownContent>
          </Dropdown>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Indexed passages" value={stats.data ? fmtCompact(stats.data.chunks) : "—"} icon={<Layers />} />
        <StatCard label="Policy versions" value={stats.data ? fmtCompact(stats.data.versions) : "—"} icon={<GitBranch />} />
        <StatCard label="Freshness" value={stats.data?.freshnessHours != null ? `${stats.data.freshnessHours} h` : "—"} icon={<RotateCcw />} hint="Hours since the last CMS weekly refresh was applied" />
        <StatCard label="Criteria awaiting review" value={review.length} icon={<ListChecks />} />
      </div>

      <Tabs value={tab} onValueChange={(t) => router.replace(`/knowledge?tab=${t}`)}>
        <TabsList className="mb-4">
          <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
          <TabsTrigger value="indexes">Indexes</TabsTrigger>
          <TabsTrigger value="criteria" count={review.length || null}>
            Criteria review
          </TabsTrigger>
          <TabsTrigger value="cache">Caches</TabsTrigger>
        </TabsList>

        <TabsContent value="ingestion">
          <Card>
            <CardHeader title="Ingestion runs" description="Incremental by content hash — unchanged documents are skipped, changed sections are re-chunked and re-embedded." />
            <CardBody className="grid gap-2">
              {runs.isPending ? <Skeleton className="h-40" /> : null}
              {(runs.data ?? []).map((r) => {
                const Icon = STATUS_ICON[r.status];
                return (
                  <div key={r.id} className="grid gap-2 rounded-lg border border-border p-3 md:grid-cols-[auto_1fr_auto] md:items-center">
                    <Icon className={r.status === "succeeded" ? "size-4 text-met" : r.status === "failed" ? "size-4 text-notmet" : "size-4 animate-spin text-brand"} />
                    <div className="grid gap-1">
                      <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-fg">
                        {r.source.toUpperCase()} · {String(r.scope.scope ?? r.scope.set ?? "")} {r.scope.refresh ? <Badge size="xs">{String(r.scope.refresh)}</Badge> : null}
                      </p>
                      <p className="flex flex-wrap gap-x-3 text-xs text-muted">
                        {Object.entries(r.stats).map(([k, v]) => (
                          <span key={k}>
                            {titleCase(k.replace(/([A-Z])/g, " $1"))}: <span className="tabular text-fg">{fmtNumber(v)}</span>
                          </span>
                        ))}
                      </p>
                      {r.error ? <p className="text-xs text-notmet-fg">{r.error}</p> : null}
                      {r.status === "running" ? <Progress value={0.4} className="max-w-xs" /> : null}
                    </div>
                    <span className="text-xs text-subtle">{fmtDateTime(r.startedAt)}</span>
                  </div>
                );
              })}
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="indexes">
          <div className="grid gap-4">
            {aliases.map((alias) => (
              <Card key={alias} className="overflow-hidden">
                <CardHeader
                  title={
                    <span className="flex items-center gap-2">
                      alias <span className="font-mono">{alias}</span>
                    </span>
                  }
                  description="Blue/green: new versions build beside the live one, pass a smoke eval, then switch atomically."
                  actions={
                    <Tooltip content="Point the alias back at the previously active version">
                      <Button size="xs" variant="ghost" onClick={() => rollback.mutate(alias)} loading={rollback.isPending}>
                        <RotateCcw /> Roll back
                      </Button>
                    </Tooltip>
                  }
                />
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead className="text-xs text-muted">
                      <tr>
                        {["Physical collection", "Status", "Points", "Vectors", "Smoke eval", ""].map((h) => (
                          <th key={h} className="px-4 py-2 text-left font-medium">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(indexes.data ?? [])
                        .filter((i) => i.alias === alias)
                        .map((v) => (
                          <IndexRow key={v.id} v={v} busy={activate.isPending} onActivate={() => activate.mutate(v.id)} />
                        ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="criteria">
          <Card>
            <CardHeader
              title="Compiled criteria sets"
              description="Extracted by a long-context model, verified by a second model family, grounded verbatim — then approved by a reviewer."
              actions={
                <Button size="xs" variant="secondary" onClick={() => compile.mutate({})} loading={compile.isPending}>
                  <Zap /> Compile pending policies
                </Button>
              }
            />
            <CardBody className="px-0">
              {criteria.isPending ? (
                <Skeleton className="mx-4 h-40" />
              ) : !(criteria.data?.items ?? []).length ? (
                <EmptyState compact art="spark" title="No criteria compiled yet" />
              ) : (
                <table className="w-full text-[13px]">
                  <thead className="text-xs text-muted">
                    <tr>
                      {["Policy", "Status", "Agreement", "Grounding", "Models", ""].map((h) => (
                        <th key={h} className="px-4 py-2 text-left font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(criteria.data?.items ?? []).map((c) => (
                      <tr key={c.id} className="border-t border-border/70">
                        <td className="px-4 py-2.5">
                          <span className="grid">
                            <span className="font-mono text-xs font-medium text-fg">
                              {c.sourceKey} <span className="font-sans text-subtle">v{c.version}</span>
                            </span>
                            <span className="line-clamp-1 text-xs text-muted">{c.policyTitle}</span>
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge tone={c.status === "approved" ? "met" : c.status === "needs_review" ? "insufficient" : "neutral"} dot>
                            {titleCase(c.status)}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-2">
                            <Progress value={c.agreement} tone={c.agreement >= 0.9 ? "met" : "insufficient"} className="w-16" />
                            <span className="tabular text-xs">{fmtPct(c.agreement)}</span>
                          </span>
                        </td>
                        <td className="tabular px-4 py-2.5 text-xs">{fmtPct(c.groundingPassRate)}</td>
                        <td className="px-4 py-2.5 font-mono text-[11px] text-muted">
                          {c.extractorModel}
                          <br />↳ {c.verifierModel}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button asChild size="xs" variant={c.status === "needs_review" ? "primary" : "ghost"}>
                            <Link href={`/knowledge/criteria/${c.id}`}>
                              {c.status === "needs_review" ? "Review" : "Open"} <ArrowRight />
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="cache">
          <Card>
            <CardHeader
              title="Cache layers"
              description="Keys are version-scoped (index, prompt, model) so a reindex or prompt change can never serve stale answers. Semantic hits also require identical extracted entities."
              actions={
                <Button size="xs" variant="ghost" onClick={() => flush.mutate()} loading={flush.isPending}>
                  <Eraser /> Flush all
                </Button>
              }
            />
            <CardBody className="grid gap-3">
              {cache.data ? (
                <>
                  <p className="text-[13px] text-muted">
                    Overall hit rate <span className="tabular font-semibold text-fg">{fmtPct(cache.data.hitRate, 1)}</span> · {fmtNumber(cache.data.hits)} hits / {fmtNumber(cache.data.misses)} misses
                  </p>
                  {cache.data.layers.map((l) => (
                    <div key={l.name} className="grid grid-cols-[1fr_auto] items-center gap-3 sm:grid-cols-[240px_1fr_auto]">
                      <span className="text-[13px] text-fg">{l.name}</span>
                      <Progress value={l.hitRate} className="hidden sm:block" />
                      <span className="tabular text-xs text-muted">
                        {fmtPct(l.hitRate)} · {fmtCompact(l.entries)} entries
                      </span>
                    </div>
                  ))}
                </>
              ) : (
                <Skeleton className="h-40" />
              )}
            </CardBody>
          </Card>
        </TabsContent>
      </Tabs>
    </AppPage>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense>
      <KnowledgeInner />
    </Suspense>
  );
}
