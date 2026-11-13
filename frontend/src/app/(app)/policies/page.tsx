"use client";

import { BadgeCheck, BookOpen, Database, Layers, RefreshCw, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useState } from "react";
import { useKnowledgeStats, usePolicies } from "@/lib/api/hooks";
import type { DocType } from "@/lib/api/types";
import { fmtCompact, fmtDate, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { DocTypeBadge } from "@/components/domain/verdict";
import { Checkbox, Select } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, PageHeader, SectionLabel, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";

const DOC_TYPES: DocType[] = ["LCD", "NCD", "Billing and Coding", "Article"];
const STATES = ["AZ", "NJ", "OK", "TX", "WA", "CA", "FL", "GA", "NY", "PA"];

function Highlight({ text, q }: { text: string; q: string }) {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        terms.includes(part.toLowerCase()) ? (
          <mark key={i} className="rounded-[3px] bg-brand-soft px-0.5 text-brand-fg">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export default function PoliciesPage() {
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q.trim());
  const [types, setTypes] = useState<DocType[]>([]);
  const [state, setState] = useState("all");
  const [status, setStatus] = useState("all");
  const stats = useKnowledgeStats();
  const policies = usePolicies({ q: dq || undefined, docType: types.length ? types.join(",") : undefined, state: state === "all" ? undefined : state, status: status === "all" ? undefined : status });
  const items = policies.data?.items ?? [];
  const s = stats.data;

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Knowledge" }, { label: "Policy library" }]} />} wide>
      <PageHeader
        title="Policy library"
        description="National and local coverage determinations and billing articles from the CMS Medicare Coverage Database — versioned, searchable, and compiled into checkable criteria."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { icon: BookOpen, label: "Coverage documents", value: s ? fmtCompact(Object.values(s.policies).reduce((a, b) => a + b, 0)) : null, sub: s ? `${fmtCompact(s.policies.LCD)} LCDs · ${fmtCompact(s.policies.NCD)} NCDs` : "" },
          { icon: Layers, label: "Indexed passages", value: s ? fmtCompact(s.chunks) : null, sub: s?.activeIndex ?? "" },
          { icon: Database, label: "Codes linked", value: s ? fmtCompact(s.codes) : null, sub: "HCPCS · ICD-10-CM" },
          { icon: RefreshCw, label: "Last refresh", value: s ? fmtRelative(s.lastIngestion) : null, sub: "CMS weekly export · incremental" },
        ].map((x) => (
          <Card key={x.label} className="flex items-center gap-3 p-4">
            <span className="flex size-9 items-center justify-center rounded-lg bg-surface-2 text-muted">
              <x.icon className="size-4" />
            </span>
            <div className="grid min-w-0">
              <span className="text-xs text-muted">{x.label}</span>
              {x.value === null ? <Skeleton className="mt-1 h-5 w-16" /> : <span className="tabular text-lg font-semibold tracking-tight text-fg">{x.value}</span>}
              <span className="truncate text-[11px] text-subtle">{x.sub}</span>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="grid content-start gap-5">
          <div className="grid gap-2">
            <SectionLabel>Document type</SectionLabel>
            {DOC_TYPES.map((t) => (
              <label key={t} className="flex items-center gap-2 text-[13px] text-fg">
                <Checkbox checked={types.includes(t)} onCheckedChange={(v) => setTypes(v ? [...types, t] : types.filter((x) => x !== t))} />
                {t === "Billing and Coding" ? "Billing & Coding article" : t}
              </label>
            ))}
          </div>
          <div className="grid gap-2">
            <SectionLabel>Jurisdiction</SectionLabel>
            <Select size="sm" value={state} onValueChange={setState} options={[{ value: "all", label: "All states" }, ...STATES.map((x) => ({ value: x, label: x }))]} aria-label="State" />
            <p className="text-[11px] text-subtle">NCDs apply nationally and always match.</p>
          </div>
          <div className="grid gap-2">
            <SectionLabel>Status</SectionLabel>
            <Select size="sm" value={status} onValueChange={setStatus} options={[{ value: "all", label: "Any status" }, { value: "active", label: "Active" }, { value: "future", label: "Future effective" }, { value: "retired", label: "Retired" }]} aria-label="Status" />
          </div>
        </aside>

        <div className="grid content-start gap-3">
          <Input
            leading={<Search />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search policy language — e.g. “conservative care 4 weeks”, “L36920”, “adherence”"
            className="h-10 text-[14px]"
            trailing={dq ? <Badge tone="ai" size="xs"><Sparkles className="text-ai-2" /> hybrid</Badge> : null}
            aria-label="Search policies"
          />
          <p className="px-1 text-xs text-muted">
            {policies.isFetching ? "Searching…" : `${policies.data?.total ?? 0} documents`}
            {dq ? " · ranked by dense + sparse + BM25 fusion with cross-encoder rerank" : ""}
          </p>
          {policies.isPending ? (
            <div className="grid gap-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
          ) : items.length === 0 ? (
            <Card>
              <EmptyState art="search" title="No policies match" description="Try fewer words, a code, or remove a filter." />
            </Card>
          ) : (
            items.map((p) => (
              <Link key={p.id} href={`/policies/${p.id}`} className="group rounded-xl bg-surface p-4 shadow-e1 transition-shadow hover:shadow-e2">
                <div className="flex flex-wrap items-center gap-2">
                  <DocTypeBadge docType={p.docType} />
                  <span className="font-mono text-xs font-medium text-fg">{p.sourceKey}</span>
                  <span className="text-xs text-subtle">v{p.version}</span>
                  {p.status !== "active" ? <Badge tone={p.status === "future" ? "info" : "neutral"} size="xs">{p.status}</Badge> : null}
                  {p.hasCriteria ? (
                    <Badge tone="met" size="xs">
                      <BadgeCheck /> Criteria compiled
                    </Badge>
                  ) : null}
                  {p.score != null ? (
                    <span className="ml-auto flex items-center gap-2 text-xs text-muted">
                      <span className="h-1 w-16 overflow-hidden rounded-full bg-surface-3">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${p.score * 100}%` }} />
                      </span>
                      <span className="tabular">{p.score.toFixed(2)}</span>
                    </span>
                  ) : null}
                </div>
                <h3 className="mt-2 text-[14px] font-semibold tracking-tight text-fg group-hover:text-brand">{p.title}</h3>
                {p.snippet ? (
                  <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted">
                    <Highlight text={p.snippet} q={dq} />
                  </p>
                ) : null}
                <p className={cn("mt-2 text-xs text-subtle")}>
                  {p.contractors[0]?.name ?? "National coverage"} · effective {fmtDate(p.effectiveFrom)}
                  {p.states.length ? ` · ${p.states.length} states` : ""}
                  {p.codeCount ? ` · ${p.codeCount} codes` : ""}
                </p>
              </Link>
            ))
          )}
        </div>
      </div>
    </AppPage>
  );
}
