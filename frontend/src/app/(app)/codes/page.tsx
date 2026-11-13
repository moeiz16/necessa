"use client";

import dynamic from "next/dynamic";
import { ArrowRight, Hash, Network, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useDeferredValue, useState } from "react";
import { useCodeGraph, useCodeSearch, useOrg } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { Segmented, Select } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";

const CoverageGraphView = dynamic(() => import("@/components/policies/coverage-graph").then((m) => m.CoverageGraphView), {
  ssr: false,
  loading: () => <Skeleton className="h-[480px] rounded-xl" />,
});

function CodesInner() {
  const params = useSearchParams();
  const router = useRouter();
  const org = useOrg();
  const [q, setQ] = useState(params.get("code") ?? "");
  const dq = useDeferredValue(q.trim());
  const [system, setSystem] = useState<"all" | "HCPCS" | "ICD10CM">((params.get("system") as "HCPCS") ?? "all");
  const [state, setState] = useState("all");
  const selected = params.get("code");
  const selSystem = params.get("system") ?? "HCPCS";
  const results = useCodeSearch(dq, system === "all" ? undefined : system);
  const graph = useCodeGraph(selSystem, selected, state === "all" ? undefined : state);

  const select = (code: string, sys: string) => router.replace(`/codes?code=${code}&system=${sys}`);

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Knowledge" }, { label: "Code explorer" }]} />} wide>
      <PageHeader title="Code explorer" description="Trace any procedure or diagnosis code through Billing & Coding articles, LCDs and NCDs to the contractors and states where it applies." />
      <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <Input leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code or description — 64483, CPAP, M17.11" aria-label="Search codes" autoFocus />
          <Segmented
            size="xs"
            value={system}
            onValueChange={setSystem}
            options={[
              { value: "all", label: "All" },
              { value: "HCPCS", label: "HCPCS" },
              { value: "ICD10CM", label: "ICD-10-CM" },
            ]}
          />
          <Card className="overflow-hidden">
            {results.isPending ? (
              <Skeleton className="m-3 h-64" />
            ) : !results.data?.length ? (
              <EmptyState compact art="search" title="No codes found" />
            ) : (
              <ul className="max-h-[560px] overflow-y-auto scrollbar-thin">
                {results.data.map((c) => (
                  <li key={`${c.system}-${c.code}`}>
                    <button
                      onClick={() => select(c.code, c.system)}
                      className={cn("flex w-full items-start gap-3 border-b border-border/70 px-3 py-2.5 text-left transition-colors last:border-0", selected === c.code ? "bg-brand-soft/40" : "hover:bg-surface-2/60")}
                    >
                      <span className="w-16 shrink-0 font-mono text-xs font-semibold text-fg">{c.code}</span>
                      <span className="min-w-0 flex-1 text-[13px] text-muted">{c.shortDesc}</span>
                      <Badge size="xs" tone={c.system === "HCPCS" ? "brand" : "neutral"}>
                        {c.system === "HCPCS" ? "HCPCS" : "ICD-10"}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <p className="px-1 text-[11px] text-subtle">HCPCS Level II and ICD-10-CM are public domain. Procedure labels are Necessa-authored; CPT® descriptors are not shown.</p>
        </div>

        <Card>
          <CardHeader
            title={
              selected ? (
                <span className="flex items-center gap-2">
                  <Hash className="size-4 text-subtle" /> <span className="font-mono">{selected}</span> coverage graph
                </span>
              ) : (
                "Coverage graph"
              )
            }
            description="Built from structured MCD relationships — not LLM extraction — so every edge is exact and auditable"
            actions={
              selected ? (
                <Select
                  size="sm"
                  className="w-36"
                  value={state}
                  onValueChange={setState}
                  aria-label="Filter by state"
                  options={[{ value: "all", label: "All states" }, ...(org.data?.states ?? ["TX"]).map((s) => ({ value: s, label: s }))]}
                />
              ) : null
            }
          />
          <CardBody>
            {!selected ? (
              <EmptyState art="chart" title="Pick a code" description="Select a code on the left to see which articles list it, which LCDs and NCDs govern it, and where they apply." />
            ) : graph.isPending ? (
              <Skeleton className="h-[480px] rounded-xl" />
            ) : graph.data && graph.data.nodes.length > 1 ? (
              <>
                <CoverageGraphView graph={graph.data} />
                <div className="mt-3 flex flex-wrap gap-2">
                  {graph.data.nodes
                    .filter((n) => n.type === "lcd" || n.type === "ncd")
                    .map((n) => (
                      <Link key={n.id} href={`/policies/pol-${n.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="group inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-fg hover:border-border-strong">
                        <Network className="size-3.5 text-brand" /> {n.label}
                        <span className="max-w-[220px] truncate text-muted">{n.meta?.title as string}</span>
                        <ArrowRight className="size-3 text-subtle group-hover:text-fg" />
                      </Link>
                    ))}
                </div>
              </>
            ) : (
              <EmptyState art="search" title="No policies reference this code" description="It may be covered under general benefit rules rather than a local or national determination." />
            )}
          </CardBody>
        </Card>
      </div>
    </AppPage>
  );
}

export default function CodesPage() {
  return (
    <Suspense>
      <CodesInner />
    </Suspense>
  );
}
