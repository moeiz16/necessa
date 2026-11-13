"use client";

import dynamic from "next/dynamic";
import { ArrowRight, Hash, Library, Network, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useDeferredValue, useMemo, useState } from "react";
import { useCodeGraph, useCodeSearch, useOrg } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { NODE_META, policyHref } from "@/components/policies/graph-meta";
import { Button } from "@/components/ui/button";
import { Segmented, Select } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, CardBody, CardHeader, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";

const CoverageGraphView = dynamic(() => import("@/components/policies/coverage-graph").then((m) => m.CoverageGraphView), {
  ssr: false,
  loading: () => <Skeleton className="h-[520px] rounded-xl" />,
});

const EXAMPLES = [
  { code: "64483", system: "HCPCS", hint: "Transforaminal ESI" },
  { code: "E0601", system: "HCPCS", hint: "CPAP device" },
  { code: "64493", system: "HCPCS", hint: "Facet injection" },
  { code: "M17.11", system: "ICD10CM", hint: "Knee osteoarthritis" },
];

function CodesInner() {
  const params = useSearchParams();
  const router = useRouter();
  const org = useOrg();
  const [q, setQ] = useState(params.get("code") ?? "");
  const dq = useDeferredValue(q.trim());
  const [system, setSystem] = useState<"all" | "HCPCS" | "ICD10CM">("all");
  const [state, setState] = useState("all");
  const selected = params.get("code");
  const selSystem = params.get("system") ?? "HCPCS";
  const results = useCodeSearch(dq, system === "all" ? undefined : system);
  const graph = useCodeGraph(selSystem, selected, state === "all" ? undefined : state);
  const selInfo = results.data?.find((c) => c.code === selected);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of graph.data?.nodes ?? []) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [graph.data]);
  const codeDesc = selInfo?.shortDesc ?? (graph.data?.nodes.find((n) => n.type === "code")?.meta?.desc as string | undefined);

  const select = (code: string, sys: string) => router.replace(`/codes?code=${encodeURIComponent(code)}&system=${sys}`, { scroll: false });

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Knowledge" }, { label: "Code explorer" }]} />} wide>
      <PageHeader title="Code explorer" description="Trace any procedure or diagnosis code through Billing & Coding articles, LCDs and NCDs to the contractors and states where it applies." />
      <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <Input leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Code or description — 64483, CPAP, M17.11" aria-label="Search codes" className="h-10" />
          <Segmented
            size="xs"
            value={system}
            onValueChange={setSystem}
            options={[
              { value: "all", label: "All systems" },
              { value: "HCPCS", label: "HCPCS" },
              { value: "ICD10CM", label: "ICD-10-CM" },
            ]}
          />
          <Card className="overflow-hidden">
            {results.isPending ? (
              <div className="grid gap-2 p-3">{Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
            ) : !results.data?.length ? (
              <EmptyState compact art="search" title="No codes found" description="Try a code prefix or a plain-language term." />
            ) : (
              <ul className="max-h-[600px] overflow-y-auto scrollbar-thin" aria-label="Code results">
                {results.data.map((c) => {
                  const on = selected === c.code;
                  return (
                    <li key={`${c.system}-${c.code}`}>
                      <button
                        onClick={() => select(c.code, c.system)}
                        aria-current={on ? "true" : undefined}
                        className={cn(
                          "relative flex w-full items-center gap-3 border-b border-border/70 px-3 py-2.5 text-left outline-none transition-colors last:border-0 focus-visible:bg-surface-2",
                          on ? "bg-brand-soft/50" : "hover:bg-surface-2/60",
                        )}
                      >
                        {on ? <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand" aria-hidden /> : null}
                        <span className="w-[68px] shrink-0 font-mono text-xs font-semibold text-fg">{c.code}</span>
                        <span className="min-w-0 flex-1 truncate text-[13px] text-muted" title={c.shortDesc}>
                          {c.shortDesc}
                        </span>
                        <Badge size="xs" tone={c.system === "HCPCS" ? "brand" : "neutral"}>
                          {c.system === "HCPCS" ? "HCPCS" : "ICD-10"}
                        </Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <p className="px-1 text-[11px] leading-relaxed text-subtle">HCPCS Level II and ICD-10-CM are public domain. Procedure labels are Necessa-authored; CPT® descriptors are licensed and not shown.</p>
        </div>

        <div className="grid min-w-0 content-start gap-4">
          {selected ? (
            <Card className="p-4">
              <div className="flex flex-wrap items-start gap-4">
                <span className="flex size-10 items-center justify-center rounded-lg bg-fg text-bg">
                  <Hash className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-lg font-semibold tracking-tight text-fg">{selected}</span>
                    <Badge size="xs" tone={selSystem === "HCPCS" ? "brand" : "neutral"}>
                      {selSystem === "HCPCS" ? "HCPCS" : "ICD-10-CM"}
                    </Badge>
                  </div>
                  {codeDesc ? <p className="mt-0.5 text-[13px] text-muted">{codeDesc}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(["article", "lcd", "ncd", "contractor", "state"] as const).map((k) => {
                      const m = NODE_META[k];
                      return (
                        <span key={k} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted">
                          <span className={cn("flex size-4 items-center justify-center rounded", m.tone)}>
                            <m.icon className="size-2.5" />
                          </span>
                          <span className="tabular font-medium text-fg">{graph.isPending ? "–" : (counts[k] ?? 0)}</span> {m.label === "MAC" ? "contractors" : m.label === "State" ? "states" : `${m.label}s`}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <Button asChild variant="secondary" size="sm">
                  <Link href={`/policies?code=${encodeURIComponent(selected)}`}>
                    <Library /> Policies listing {selected}
                  </Link>
                </Button>
              </div>
            </Card>
          ) : null}

          <Card className="min-w-0">
            <CardHeader
              title={selected ? "Coverage graph" : "Coverage graph"}
              description="Built from structured MCD relationship tables — not LLM extraction — so every edge is exact and auditable"
              icon={<Network />}
              actions={
                selected ? (
                  <Select
                    size="sm"
                    className="w-36"
                    value={state}
                    onValueChange={setState}
                    aria-label="Filter by state"
                    options={[{ value: "all", label: "All states" }, ...(org.data?.states?.length ? org.data.states : ["TX"]).map((s) => ({ value: s, label: s }))]}
                  />
                ) : null
              }
            />
            <CardBody>
              {!selected ? (
                <EmptyState
                  art="chart"
                  title="Pick a code to trace"
                  description="See which articles list it, which LCDs and NCDs govern it, and the contractors and states where they apply."
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      {EXAMPLES.map((e) => (
                        <button key={e.code} onClick={() => select(e.code, e.system)} className="group inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg transition-colors hover:border-border-strong">
                          <span className="font-mono font-semibold">{e.code}</span>
                          <span className="text-muted">{e.hint}</span>
                          <ArrowRight className="size-3 text-subtle transition-transform group-hover:translate-x-0.5" />
                        </button>
                      ))}
                    </div>
                  }
                />
              ) : graph.isPending ? (
                <Skeleton className="h-[520px] rounded-xl" />
              ) : graph.data && graph.data.nodes.length > 1 ? (
                <>
                  <CoverageGraphView graph={graph.data} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {graph.data.nodes
                      .filter((n) => n.type === "lcd" || n.type === "ncd")
                      .map((n) => (
                        <Link key={n.id} href={policyHref(n.label)} className="group inline-flex max-w-full items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-fg transition-colors hover:border-border-strong hover:bg-surface-2/50">
                          <Network className="size-3.5 shrink-0 text-brand" /> <span className="font-mono font-medium">{n.label}</span>
                          <span className="truncate text-muted">{n.meta?.title as string}</span>
                          <ArrowRight className="size-3 shrink-0 text-subtle group-hover:text-fg" />
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
