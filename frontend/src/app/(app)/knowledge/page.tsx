"use client";

import {
  ArrowRight,
  Check,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock3,
  Database,
  DownloadCloud,
  Eraser,
  FlaskConical,
  GitBranch,
  Layers,
  ListChecks,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Waypoints,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useActivateIndex, useCacheStats, useCompileCriteria, useCriteriaSets, useFlushCache, useIndexes, useIngestionRuns, useKnowledgeStats, useRollbackIndex, useStartIngestion } from "@/lib/api/hooks";
import type { CriteriaSet, IndexVersion, IngestionRun } from "@/lib/api/types";
import { fmtCompact, fmtDateTime, fmtNumber, fmtPct, fmtRelative, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Progress, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Dialog, DialogClose, DialogContent, DialogFooter, Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownTrigger, Tooltip } from "@/components/ui/overlays";
import { StatCard } from "@/components/ui/widgets";

const STAGES = ["Fetch", "Parse", "Diff", "Chunk", "Embed", "Smoke eval", "Activate"];

const STAT_LABEL: Record<string, string> = {
  documentsSeen: "documents seen",
  changed: "changed",
  sectionsUpserted: "sections upserted",
  chunksEmbedded: "passages embedded",
  skippedUnchanged: "unchanged (skipped)",
  codes: "codes",
  documents: "documents",
  chunks: "passages",
};

function duration(s?: number | null) {
  if (s == null) return null;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

function scopeLabel(r: IngestionRun) {
  const s = r.scope as Record<string, unknown>;
  if (r.source === "codesets") return [s.icd10cm && `ICD-10-CM ${s.icd10cm}`, s.hcpcs && `HCPCS ${s.hcpcs}`].filter(Boolean).join(" · ") || "Code sets";
  if (r.source === "fixtures") return `Synthetic fixtures · ${String(s.set ?? "")}`;
  return `CMS Medicare Coverage Database · ${String(s.scope ?? "focus")} scope`;
}

function RunRow({ r }: { r: IngestionRun }) {
  const Icon = r.status === "succeeded" ? CircleCheck : r.status === "failed" ? CircleX : CircleDashed;
  const secs = r.stats.durationS ?? (r.finishedAt ? (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000 : null);
  const running = r.status === "running" || r.status === "queued";
  const stage = running ? Math.min(STAGES.length - 2, Math.floor(((Date.now() - new Date(r.startedAt).getTime()) / 1000 / 1.2) % (STAGES.length - 1))) : -1;
  const refresh = (r.scope as Record<string, unknown>).refresh;
  return (
    <li className={cn("rounded-xl border p-3.5 transition-colors", running ? "border-brand/40 bg-brand-soft/20" : r.status === "failed" ? "border-notmet/25 bg-notmet-soft/20" : "border-border")}>
      <div className="flex flex-wrap items-start gap-3">
        <Icon className={cn("mt-0.5 size-4 shrink-0", r.status === "succeeded" ? "text-met" : r.status === "failed" ? "text-notmet" : "animate-spin text-brand")} aria-label={r.status} />
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-fg">
            {scopeLabel(r)}
            {refresh ? <Badge size="xs">{String(refresh)}</Badge> : null}
            {r.status === "failed" ? <Badge size="xs" tone="notmet">failed</Badge> : null}
          </p>
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            {Object.entries(r.stats)
              .filter(([k]) => k !== "durationS")
              .map(([k, v]) => (
                <span key={k}>
                  <span className="tabular font-medium text-fg">{fmtNumber(v)}</span> {STAT_LABEL[k] ?? titleCase(k.replace(/([A-Z])/g, " $1")).toLowerCase()}
                </span>
              ))}
          </p>
        </div>
        <div className="grid justify-items-end gap-0.5 text-right">
          <Tooltip content={fmtDateTime(r.startedAt)}>
            <span className="text-xs text-subtle">{fmtRelative(r.startedAt)}</span>
          </Tooltip>
          {secs != null && !running ? (
            <span className="flex items-center gap-1 text-[11px] text-subtle">
              <Clock3 className="size-3" /> {duration(secs)}
            </span>
          ) : null}
        </div>
      </div>
      {running ? (
        <ol className="mt-3 grid grid-cols-7 gap-1" aria-label="Pipeline progress">
          {STAGES.map((s, i) => (
            <li key={s} className="grid gap-1">
              <span className={cn("h-1 rounded-full", i < stage ? "bg-brand" : i === stage ? "animate-pulse bg-brand/60" : "bg-surface-3")} />
              <span className={cn("truncate text-[10.5px]", i <= stage ? "text-fg" : "text-subtle")}>{s}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {r.error ? (
        <p className="mt-2 rounded-md bg-surface px-2.5 py-1.5 text-xs text-notmet-fg ring-1 ring-inset ring-notmet/20">
          {r.error}
        </p>
      ) : null}
    </li>
  );
}

const METRIC_LABEL: Record<string, string> = { smokeQueries: "smoke queries", tenants: "tenants", hitRate: "hit rate" };
function metric(k: string, v: number) {
  if (v <= 1 && !Number.isInteger(v)) return `${METRIC_LABEL[k] ?? k} ${fmtPct(v, 1)}`;
  return `${fmtNumber(v)} ${METRIC_LABEL[k] ?? k}`;
}

function AliasCard({ alias, versions }: { alias: string; versions: IndexVersion[] }) {
  const activate = useActivateIndex();
  const rollback = useRollbackIndex();
  const [confirm, setConfirm] = useState<IndexVersion | "rollback" | null>(null);
  const active = versions.find((v) => v.status === "active");
  const candidate = versions.find((v) => v.status === "ready" || v.status === "building");
  const retired = versions.filter((v) => v.status === "retired" || v.status === "failed");
  const recallDelta = candidate && active && candidate.stats["recall@10"] != null && active.stats["recall@10"] != null ? candidate.stats["recall@10"]! - active.stats["recall@10"]! : null;

  const Slot = ({ v, role }: { v?: IndexVersion; role: "live" | "candidate" }) =>
    v ? (
      <div className={cn("grid gap-2 rounded-xl border p-3.5", role === "live" ? "border-met/30 bg-met-soft/30" : "border-brand/30 bg-brand-soft/25")}>
        <div className="flex items-center gap-2">
          <Badge tone={role === "live" ? "met" : v.status === "building" ? "neutral" : "brand"} dot>
            {role === "live" ? "live" : v.status}
          </Badge>
          <span className="truncate font-mono text-xs font-medium text-fg">{v.physicalName}</span>
        </div>
        <p className="text-xs text-muted">
          <span className="tabular font-medium text-fg">{fmtNumber(v.points)}</span> points · {v.embedModel.split("/").pop()} {v.dims}d · {v.sparseModel}
        </p>
        <p className="flex flex-wrap gap-x-3 text-xs text-muted">
          {Object.entries(v.stats).map(([k, val]) => (
            <span key={k} className="tabular">
              {metric(k, val)}
            </span>
          ))}
        </p>
        <p className="text-[11px] text-subtle">{role === "live" && v.activatedAt ? `serving since ${fmtRelative(v.activatedAt)}` : `built ${fmtRelative(v.createdAt)}`}</p>
      </div>
    ) : (
      <div className="flex items-center justify-center rounded-xl border border-dashed border-border p-4 text-xs text-subtle">{role === "live" ? "No live version" : "No candidate — the next ingestion run builds one here"}</div>
    );

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <GitBranch className="size-4 text-subtle" /> alias <span className="font-mono">{alias}</span>
          </span>
        }
        description="Blue/green: a new version builds beside the live one, must pass a smoke eval, then the alias switches atomically."
        actions={
          retired.length ? (
            <Button size="xs" variant="ghost" onClick={() => setConfirm("rollback")}>
              <RotateCcw /> Roll back
            </Button>
          ) : null
        }
      />
      <CardBody className="grid gap-3">
        <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr]">
          <Slot v={active} role="live" />
          <div className="flex flex-col items-center justify-center gap-2 px-1">
            <span className="hidden text-[10.5px] uppercase tracking-wider text-subtle md:block">switch</span>
            {candidate?.status === "ready" ? (
              <Button size="xs" variant="primary" onClick={() => setConfirm(candidate)}>
                <Zap /> Activate
              </Button>
            ) : (
              <ArrowRight className="size-4 text-subtle" aria-hidden />
            )}
            {recallDelta != null ? (
              <span className={cn("tabular text-[11px]", recallDelta >= 0 ? "text-met-fg" : "text-notmet-fg")}>
                recall {recallDelta >= 0 ? "+" : ""}
                {(recallDelta * 100).toFixed(1)} pts
              </span>
            ) : null}
          </div>
          <Slot v={candidate} role="candidate" />
        </div>
        {retired.length ? (
          <details className="group text-xs">
            <summary className="cursor-pointer list-none text-muted hover:text-fg">
              {retired.length} retired {retired.length === 1 ? "version" : "versions"} kept for rollback <span className="group-open:hidden">· show</span>
            </summary>
            <ul className="mt-2 grid gap-1">
              {retired.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2/60 px-2.5 py-1.5">
                  <span className="font-mono text-fg">{v.physicalName}</span>
                  <span className="text-subtle">{fmtNumber(v.points)} points · {v.embedModel}</span>
                  <span className="ml-auto text-subtle">{fmtRelative(v.createdAt)}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </CardBody>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent
          size="sm"
          title={confirm === "rollback" ? `Roll back ${alias}?` : `Activate ${typeof confirm === "object" && confirm ? confirm.physicalName : ""}?`}
          description={confirm === "rollback" ? "The alias points back at the previously active version. New answers use it immediately; caches keyed to the current version stop matching." : "The alias switches atomically. The current live version is kept for one-click rollback."}
        >
          {typeof confirm === "object" && confirm && confirm.status === "ready" ? (
            <ul className="grid gap-1.5 text-[13px]">
              <li className="flex items-center gap-2">
                <Check className="size-3.5 text-met" /> Smoke eval passed ({Object.entries(confirm.stats).map(([k, v]) => metric(k, v)).join(" · ")})
              </li>
              <li className="flex items-center gap-2">
                <Check className="size-3.5 text-met" /> Same embedding model as live — no mixed vector spaces
              </li>
            </ul>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant={confirm === "rollback" ? "secondary" : "primary"}
              loading={activate.isPending || rollback.isPending}
              onClick={() => {
                if (confirm === "rollback") rollback.mutate(alias, { onSettled: () => setConfirm(null) });
                else if (confirm) activate.mutate(confirm.id, { onSettled: () => setConfirm(null) });
              }}
            >
              {confirm === "rollback" ? "Roll back" : "Activate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function provenance(c: CriteriaSet) {
  if (c.extractorModel.startsWith("transfer:")) return { icon: Waypoints, label: `Transferred from ${c.extractorModel.slice(9)}`, sub: "verbatim re-grounding" };
  if (c.extractorModel === "curated") return { icon: ShieldCheck, label: "Curated", sub: "clinical content team" };
  return { icon: Sparkles, label: c.extractorModel.split("/").pop() ?? c.extractorModel, sub: `verified by ${c.verifierModel.split("/").pop()}` };
}

function leafCount(n: CriteriaSet["tree"]): number {
  return n.children?.length ? n.children.reduce((a, c) => a + leafCount(c), 0) : 1;
}

function CriteriaQueue() {
  const [filter, setFilter] = useState<"needs_review" | "approved" | "all">("needs_review");
  const criteria = useCriteriaSets();
  const compile = useCompileCriteria();
  const all = criteria.data?.items ?? [];
  const items = all.filter((c) => filter === "all" || c.status === filter);
  const count = (s: string) => all.filter((c) => c.status === s).length;
  return (
    <Card>
      <CardHeader
        title="Compiled criteria sets"
        description="Extracted by a long-context model, cross-checked by a second model family, grounded verbatim — then approved by a reviewer. Only approved sets are used to evaluate cases."
        actions={
          <Button size="xs" variant="secondary" onClick={() => compile.mutate({})} loading={compile.isPending}>
            <Zap /> Compile pending policies
          </Button>
        }
      />
      <CardBody className="grid gap-3 px-0">
        <div className="px-4">
          <Segmented
            size="xs"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: "needs_review", label: `Needs review · ${count("needs_review")}` },
              { value: "approved", label: `Approved · ${count("approved")}` },
              { value: "all", label: `All · ${all.length}` },
            ]}
          />
        </div>
        {criteria.isPending ? (
          <div className="grid gap-2 px-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>
        ) : !items.length ? (
          <EmptyState compact art="spark" title={filter === "needs_review" ? "Review queue is clear" : "Nothing here yet"} description={filter === "needs_review" ? "Every compiled criteria set has been reviewed." : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="text-xs text-muted">
                <tr>
                  {["Policy", "Status", "Provenance", "Grounding", "Agreement", ""].map((h) => (
                    <th key={h} scope="col" className="px-4 py-2 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((c) => {
                  const p = provenance(c);
                  const n = leafCount(c.tree);
                  const grounded = Math.round(c.groundingPassRate * n);
                  return (
                    <tr key={c.id} className="border-t border-border/70 align-top hover:bg-surface-2/40">
                      <td className="px-4 py-3">
                        <span className="grid">
                          <span className="font-mono text-xs font-medium text-fg">
                            {c.sourceKey} <span className="font-sans text-subtle">v{c.version}</span>
                          </span>
                          <span className="line-clamp-1 max-w-[260px] text-xs text-muted">{c.policyTitle}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={c.status === "approved" ? "met" : c.status === "needs_review" ? "insufficient" : "neutral"} dot>
                          {titleCase(c.status)}
                        </Badge>
                        <p className="mt-1 text-[11px] text-subtle">{fmtRelative(c.reviewedAt ?? c.createdAt)}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-start gap-1.5">
                          <p.icon className="mt-0.5 size-3.5 shrink-0 text-subtle" />
                          <span className="grid">
                            <span className="text-xs text-fg">{p.label}</span>
                            <span className="text-[11px] text-subtle">{p.sub}</span>
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2">
                          <Progress value={c.groundingPassRate} tone={c.groundingPassRate >= 1 ? "met" : "insufficient"} className="w-14" />
                          <span className={cn("tabular text-xs", c.groundingPassRate < 1 ? "font-medium text-insufficient-fg" : "text-muted")}>
                            {grounded}/{n} verbatim
                          </span>
                        </span>
                      </td>
                      <td className="tabular px-4 py-3 text-xs text-muted">{fmtPct(c.agreement)}</td>
                      <td className="px-4 py-3 text-right">
                        <Button asChild size="xs" variant={c.status === "needs_review" ? "primary" : "ghost"}>
                          <Link href={`/knowledge/criteria/${c.id}`}>
                            {c.status === "needs_review" ? "Review" : "Open"} <ArrowRight />
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

const LAYER_HINT: [RegExp, string][] = [
  [/exact/i, "Same normalized question, filters, index and prompt version"],
  [/semantic/i, "Near-duplicate question with identical codes, payer, state, as-of and negations"],
  [/retrieval/i, "Ranked passages per query and index version"],
  [/embed/i, "Vectors by content hash and model"],
  [/llm|deterministic/i, "Temperature-0 calls only — never sampled generations"],
];
const layerHint = (name: string) => LAYER_HINT.find(([re]) => re.test(name))?.[1] ?? "";

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
  const flush = useFlushCache();
  const aliases = useMemo(() => Array.from(new Set((indexes.data ?? []).map((i) => i.alias))), [indexes.data]);
  const review = (criteria.data?.items ?? []).filter((c) => c.status === "needs_review");
  const fresh = stats.data?.freshnessHours;

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Administration" }, { label: "Knowledge ops" }]} />} wide>
      <PageHeader
        title="Knowledge ops"
        description="Ingestion, versioned indexes, compiled criteria and caches — the machinery behind every grounded answer."
        actions={
          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant="primary" loading={start.isPending}>
                <DownloadCloud /> Run ingestion
              </Button>
            </DropdownTrigger>
            <DropdownContent className="w-80">
              <DropdownLabel>Source &amp; scope</DropdownLabel>
              {[
                { icon: Database, source: "mcd", scope: "focus", title: "CMS MCD — focus scope", sub: "All NCDs + prior-auth-heavy LCDs and articles · incremental" },
                { icon: Layers, source: "mcd", scope: "full", title: "CMS MCD — full corpus", sub: "Resumable · paced to free-tier embedding quotas" },
                { icon: ListChecks, source: "codesets", scope: "full", title: "Code sets", sub: "ICD-10-CM · HCPCS Level II" },
                { icon: FlaskConical, source: "fixtures", scope: "focus", title: "Synthetic fixtures", sub: "Offline demo policies · no license needed" },
              ].map((o) => (
                <DropdownItem key={`${o.source}-${o.scope}`} onSelect={() => start.mutate({ source: o.source, scope: o.scope })} className="items-start">
                  <o.icon className="mt-0.5" />
                  <span className="grid">
                    <span>{o.title}</span>
                    <span className="text-xs text-muted">{o.sub}</span>
                  </span>
                </DropdownItem>
              ))}
            </DropdownContent>
          </Dropdown>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Indexed passages" value={stats.data ? fmtCompact(stats.data.chunks) : "—"} icon={<Layers />} hint={stats.data?.activeIndex ?? undefined} />
        <StatCard label="Policy versions" value={stats.data ? fmtCompact(stats.data.versions) : "—"} icon={<GitBranch />} />
        <StatCard
          label="Freshness · target ≤ 48 h"
          value={
            fresh != null ? (
              <span className={cn(fresh > 48 && "text-insufficient-fg")}>
                {fresh} h
              </span>
            ) : (
              "—"
            )
          }
          icon={<RotateCcw />}
          hint="Hours since the last CMS weekly refresh was applied"
        />
        <StatCard label="Criteria awaiting review" value={review.length} icon={<ListChecks />} hint="Only approved criteria are used to evaluate cases" />
      </div>

      <Tabs value={tab} onValueChange={(t) => router.replace(`/knowledge?tab=${t}`, { scroll: false })}>
        <TabsList className="mb-4 max-w-full overflow-x-auto scrollbar-thin">
          <TabsTrigger value="ingestion">Ingestion</TabsTrigger>
          <TabsTrigger value="indexes">Indexes</TabsTrigger>
          <TabsTrigger value="criteria" count={review.length || null}>
            Criteria review
          </TabsTrigger>
          <TabsTrigger value="cache">Caches</TabsTrigger>
        </TabsList>

        <TabsContent value="ingestion">
          <Card>
            <CardHeader title="Ingestion runs" description="Incremental by content hash — unchanged documents are skipped; changed sections are re-chunked, re-embedded and indexed into a new version." />
            <CardBody>
              {runs.isPending ? (
                <div className="grid gap-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>
              ) : !(runs.data ?? []).length ? (
                <EmptyState compact art="spark" title="No ingestion runs yet" description="Run the focus scope to load NCDs and prior-auth-heavy LCDs." />
              ) : (
                <ul className="grid gap-2">
                  {(runs.data ?? []).map((r) => (
                    <RunRow key={r.id} r={r} />
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="indexes">
          {indexes.isPending ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : (
            <div className="grid gap-4">
              {aliases.map((alias) => (
                <AliasCard key={alias} alias={alias} versions={(indexes.data ?? []).filter((i) => i.alias === alias)} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="criteria">
          <CriteriaQueue />
        </TabsContent>

        <TabsContent value="cache">
          <Card>
            <CardHeader
              title="Cache layers"
              description="Keys are version-scoped (index, prompt, model), so a reindex or prompt change can never serve a stale answer."
              actions={
                <Button size="xs" variant="ghost" onClick={() => flush.mutate()} loading={flush.isPending}>
                  <Eraser /> Flush all
                </Button>
              }
            />
            <CardBody className="grid gap-4">
              {cache.data ? (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="tabular text-[26px] font-semibold tracking-tight text-fg">{fmtPct(cache.data.hitRate, 1)}</span>
                    <span className="text-[13px] text-muted">
                      overall hit rate · {fmtNumber(cache.data.hits)} hits / {fmtNumber(cache.data.misses)} misses
                    </span>
                  </div>
                  <ul className="grid gap-3">
                    {cache.data.layers.map((l) => (
                      <li key={l.name} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[260px_1fr_auto]">
                        <span className="grid">
                          <span className="text-[13px] font-medium text-fg">{l.name}</span>
                          <span className="text-[11px] text-subtle">{layerHint(l.name)}</span>
                        </span>
                        <Progress value={l.hitRate} className="hidden sm:block" />
                        <span className="tabular text-xs text-muted">
                          {fmtPct(l.hitRate)} · {fmtCompact(l.entries)} entries
                        </span>
                      </li>
                    ))}
                  </ul>
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
