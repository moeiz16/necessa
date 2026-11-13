"use client";

import { CircleCheck, CircleX, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useActivateIndex, useCriteriaSets, useIndexes, useIngestionRuns, useKnowledgeStats, useRollbackIndex, useStartIngestion } from "@/lib/api/hooks";
import type { IndexVersion, IngestionRun } from "@/lib/api/types";
import { fmtCompact, fmtDateTime, fmtNumber, fmtPct, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { ConfirmDialog, Dropdown, DropdownContent, DropdownItem, DropdownTrigger } from "@/components/ui/overlays";
import { StatCard } from "@/components/ui/widgets";

const SOURCE: Record<string, string> = {
  mcd: "Medicare coverage policies",
  codesets: "Procedure and diagnosis code lists",
  fixtures: "Sample policies",
  payer_upload: "Uploaded payer policy",
};

/** "45 s", "12 min", "3 h 57 min". */
function took(secs: number) {
  if (secs < 60) return `${Math.max(1, Math.round(secs))} s`;
  const min = Math.round(secs / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function RunRow({ r }: { r: IngestionRun }) {
  const s = r.stats as Record<string, unknown>;
  const checked = num(s.documents) ?? num(s.documentsSeen);
  const updated = num(s.changed) ?? num(s.versions_new);
  const secs = num(s.seconds) ?? num(s.durationS);
  const running = r.status === "running" || r.status === "queued";
  const Icon = r.status === "succeeded" ? CircleCheck : r.status === "failed" ? CircleX : Loader2;
  return (
    <li className="flex items-start gap-3 px-4 py-3.5">
      <Icon className={cn("mt-0.5 size-4 shrink-0", r.status === "succeeded" ? "text-met" : r.status === "failed" ? "text-notmet" : "animate-spin text-muted")} aria-label={r.status} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="text-[13.5px] font-medium text-fg">{SOURCE[r.source] ?? "Policy library"}</p>
        <p className="text-xs text-muted">
          {running
            ? "Refreshing…"
            : r.status === "failed"
              ? "The refresh didn't finish. It will pick up where it left off the next time it runs."
              : [checked != null && `${fmtNumber(checked)} checked`, updated != null && `${fmtNumber(updated)} added or updated`, secs != null && took(secs)].filter(Boolean).join(" · ") || "Completed"}
        </p>
      </div>
      <span className="whitespace-nowrap text-xs text-subtle" title={fmtDateTime(r.startedAt)}>
        {fmtRelative(r.startedAt)}
      </span>
    </li>
  );
}

const VERSION_STATE: Record<IndexVersion["status"], { label: string; tone: "met" | "neutral" | "brand" | "notmet" }> = {
  active: { label: "Live", tone: "met" },
  ready: { label: "Ready to switch", tone: "brand" },
  building: { label: "Preparing", tone: "neutral" },
  retired: { label: "Previous", tone: "neutral" },
  failed: { label: "Didn't finish", tone: "notmet" },
};

function LibraryVersions({ versions }: { versions: IndexVersion[] }) {
  const activate = useActivateIndex();
  const rollback = useRollbackIndex();
  const [confirm, setConfirm] = useState<IndexVersion | "restore" | null>(null);
  const shown = [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  const hasPrevious = versions.some((v) => v.status === "retired");
  return (
    <Card>
      <CardHeader
        title="Library versions"
        description="Each refresh is prepared and checked before it replaces the live version, so your team never sees a half-updated library."
        actions={
          hasPrevious ? (
            <Button size="xs" variant="ghost" onClick={() => setConfirm("restore")}>
              Restore previous
            </Button>
          ) : null
        }
      />
      <CardBody className="px-0 pb-1">
        <ul className="divide-y divide-border">
          {shown.map((v) => {
            const st = VERSION_STATE[v.status];
            const smoke = (v.stats as Record<string, unknown>).smoke as { passed?: boolean } | undefined;
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Badge tone={st.tone} size="xs" dot>
                  {st.label}
                </Badge>
                <span className="text-[13px] text-fg">{fmtDateTime(v.createdAt)}</span>
                <span className="text-xs text-muted">{fmtCompact(v.points)} searchable sections</span>
                {smoke?.passed ? <span className="text-xs text-muted">Quality check passed</span> : null}
                {v.status === "ready" ? (
                  <Button size="xs" variant="secondary" className="ml-auto" onClick={() => setConfirm(v)}>
                    Make live
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardBody>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "restore" ? "Restore the previous version?" : "Make this version live?"}
        description={confirm === "restore" ? "Your team will see the previous version of the policy library straight away." : "Your team will see this version of the policy library straight away. You can restore the previous one at any time."}
        confirmLabel={confirm === "restore" ? "Restore" : "Make live"}
        onConfirm={async () => {
          if (confirm === "restore") await rollback.mutateAsync(versions[0]?.alias ?? "policy_chunks");
          else if (confirm) await activate.mutateAsync(confirm.id);
          setConfirm(null);
        }}
      />
    </Card>
  );
}

function ReviewQueue() {
  const sets = useCriteriaSets();
  const waiting = (sets.data?.items ?? []).filter((c) => c.status === "needs_review");
  return (
    <Card>
      <CardHeader title="Requirements checklists to review" description="Only reviewed checklists are used to check cases." />
      <CardBody className="px-0 pb-1">
        {sets.isPending ? (
          <Skeleton className="mx-4 h-32" />
        ) : waiting.length === 0 ? (
          <EmptyState compact art="chart" title="Nothing waiting for review" />
        ) : (
          <ul className="divide-y divide-border">
            {waiting.map((c) => {
              const imported = c.extractorModel?.startsWith("transfer:") ? c.extractorModel.slice(9) : null;
              return (
                <li key={c.id}>
                  <Link href={`/knowledge/criteria/${c.id}`} className="grid gap-0.5 px-4 py-3 outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2">
                    <span className="flex items-baseline gap-2 text-[13.5px]">
                      <span className="font-medium text-fg">{c.policyTitle ?? c.sourceKey}</span>
                      <span className="font-mono text-xs text-subtle">{c.sourceKey}</span>
                    </span>
                    <span className="text-xs text-muted">
                      {imported ? `Imported from a similar policy (${imported}). A reviewer must confirm it.` : "Prepared automatically. A reviewer must confirm it."}
                      {typeof c.groundingPassRate === "number" ? ` ${fmtPct(c.groundingPassRate)} of requirements match this policy's wording.` : ""}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function PolicyUpdatesInner() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") ?? "updates";
  const stats = useKnowledgeStats();
  const runs = useIngestionRuns();
  const indexes = useIndexes();
  const criteria = useCriteriaSets();
  const start = useStartIngestion();
  const policyVersions = useMemo(() => (indexes.data ?? []).filter((i) => i.alias === "policy_chunks"), [indexes.data]);
  const waiting = (criteria.data?.items ?? []).filter((c) => c.status === "needs_review").length;
  const s = stats.data;
  const total = s ? Object.values(s.policies).reduce((a, b) => a + b, 0) : null;
  const last = s?.lastIngestion?.finishedAt ?? s?.lastIngestion?.startedAt;

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Policy updates" }]} />} wide>
      <PageHeader
        title="Policy updates"
        description="Keep the policy library current and review new requirements checklists before your team relies on them."
        actions={
          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant="primary" loading={start.isPending}>
                Refresh library
              </Button>
            </DropdownTrigger>
            <DropdownContent className="w-72">
              {[
                { source: "mcd", scope: "focus", title: "Medicare coverage policies", sub: "National policies and the most-used local policies" },
                { source: "mcd", scope: "full", title: "All Medicare coverage policies", sub: "Takes longer" },
                { source: "codesets", scope: "full", title: "Code lists", sub: "Procedure and diagnosis codes" },
                { source: "fixtures", scope: "focus", title: "Sample policies", sub: "For demonstrations" },
              ].map((o) => (
                <DropdownItem key={`${o.source}-${o.scope}`} onSelect={() => start.mutate({ source: o.source, scope: o.scope })} className="items-start">
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

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Policies in the library" value={total != null ? fmtCompact(total) : "–"} />
        <StatCard
          label="Last refreshed"
          value={last ? fmtRelative(last) : "–"}
          hint={s?.freshnessDays != null ? (s.freshnessDays <= 2 ? "Up to date" : "Due for a refresh") : undefined}
        />
        <StatCard label="Checklists to review" value={waiting} hint="Reviewed before they're used on cases" />
      </div>

      <Tabs value={tab} onValueChange={(t) => router.replace(`/knowledge?tab=${t}`, { scroll: false })}>
        <TabsList className="mb-4">
          <TabsTrigger value="updates">Recent refreshes</TabsTrigger>
          <TabsTrigger value="versions">Library versions</TabsTrigger>
          <TabsTrigger value="review" count={waiting || null}>
            Review
          </TabsTrigger>
        </TabsList>

        <TabsContent value="updates">
          <Card>
            <CardHeader title="Recent refreshes" description="Only policies that changed are updated." />
            <CardBody className="px-0 pb-1">
              {runs.isPending ? (
                <Skeleton className="mx-4 h-40" />
              ) : !(runs.data ?? []).length ? (
                <EmptyState compact art="spark" title="No refreshes yet" description="Use Refresh library to load the latest policies." />
              ) : (
                <ul className="divide-y divide-border">
                  {(runs.data ?? []).slice(0, 10).map((r) => (
                    <RunRow key={r.id} r={r} />
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="versions">{indexes.isPending ? <Skeleton className="h-48 rounded-xl" /> : <LibraryVersions versions={policyVersions} />}</TabsContent>
        <TabsContent value="review">
          <ReviewQueue />
        </TabsContent>
      </Tabs>
    </AppPage>
  );
}

export default function PolicyUpdatesPage() {
  return (
    <Suspense>
      <PolicyUpdatesInner />
    </Suspense>
  );
}
