"use client";

import { ArrowRight, Search } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useDeferredValue, useMemo, useState } from "react";
import { useCodeGraph, useCodeSearch } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { groupPolicies, listPolicies, reduceForMap } from "@/components/policies/coverage-utils";
import { US_STATES } from "@/components/policies/labels";
import { policyHref } from "@/components/policies/graph-meta";
import { Button } from "@/components/ui/button";
import { Segmented, Select } from "@/components/ui/controls";
import { Breadcrumb, Card, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";

const CoverageGraphView = dynamic(() => import("@/components/policies/coverage-graph").then((m) => m.CoverageGraphView), {
  ssr: false,
  loading: () => <Skeleton className="h-[460px] rounded-lg" />,
});

const EXAMPLES = [
  { code: "64483", system: "HCPCS", hint: "Spinal injection" },
  { code: "E0601", system: "HCPCS", hint: "CPAP device" },
  { code: "64493", system: "HCPCS", hint: "Facet joint injection" },
  { code: "M17.11", system: "ICD10CM", hint: "Knee osteoarthritis" },
];

function Lookup() {
  const params = useSearchParams();
  const router = useRouter();
  const [q, setQ] = useState(params.get("code") ?? "");
  const dq = useDeferredValue(q.trim());
  const [system, setSystem] = useState<"all" | "HCPCS" | "ICD10CM">("all");
  const [state, setState] = useState("all");
  const [asOf, setAsOf] = useState("");
  const [within, setWithin] = useState("");
  const [view, setView] = useState<"list" | "map">("list");
  const selected = params.get("code");
  const selSystem = params.get("system") ?? "HCPCS";

  const results = useCodeSearch(dq, system === "all" ? undefined : system);
  const graph = useCodeGraph(selSystem, selected, state === "all" ? undefined : state, asOf || undefined);
  const selInfo = results.data?.find((c) => c.code === selected);
  const description = selInfo?.shortDesc ?? (graph.data?.nodes.find((n) => n.type === "code")?.meta?.desc as string | undefined);

  const policies = useMemo(() => (graph.data ? listPolicies(graph.data) : []), [graph.data]);
  const matching = useMemo(() => {
    const t = within.trim().toLowerCase();
    return t ? policies.filter((p) => `${p.key} ${p.title}`.toLowerCase().includes(t)) : policies;
  }, [policies, within]);
  const shown = useMemo(() => matching.filter((p) => p.inLibrary), [matching]);
  const notLoaded = useMemo(() => matching.filter((p) => !p.inLibrary), [matching]);
  const groups = useMemo(() => groupPolicies(shown), [shown]);
  const allStates = useMemo(() => new Set(policies.flatMap((p) => p.states)).size, [policies]);
  const map = useMemo(() => (graph.data && view === "map" ? reduceForMap(graph.data, shown) : null), [graph.data, shown, view]);

  const select = (code: string, sys: string) => {
    setState("all");
    setAsOf("");
    setWithin("");
    router.replace(`/codes?code=${encodeURIComponent(code)}&system=${sys}`, { scroll: false });
  };

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Coverage lookup" }]} />} wide>
      <PageHeader title="Coverage lookup" description="Enter a procedure or diagnosis code to see which policies cover it, who issues them and where they apply." />
      <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <Input leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="A code or a description, for example E0601 or CPAP" aria-label="Search codes" className="h-10" />
          <Segmented
            size="xs"
            value={system}
            onValueChange={setSystem}
            options={[
              { value: "all", label: "All" },
              { value: "HCPCS", label: "Procedures" },
              { value: "ICD10CM", label: "Diagnoses" },
            ]}
          />
          {dq ? (
            <Card className="overflow-hidden">
              {results.isPending ? (
                <div className="grid gap-2 p-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
              ) : !results.data?.length ? (
                <EmptyState compact art="search" title="No codes found" description="Try the start of a code or a plain description." />
              ) : (
                <ul className="max-h-[560px] overflow-y-auto scrollbar-thin" aria-label="Code results">
                  {results.data.map((c) => {
                    const on = selected === c.code;
                    return (
                      <li key={`${c.system}-${c.code}`}>
                        <button
                          onClick={() => select(c.code, c.system)}
                          aria-current={on ? "true" : undefined}
                          className={cn("flex w-full items-center gap-3 border-b border-border/70 px-3 py-2.5 text-left outline-none transition-colors last:border-0 focus-visible:bg-surface-2", on ? "bg-surface-2" : "hover:bg-surface-2/60")}
                        >
                          <span className="w-[64px] shrink-0 font-mono text-xs font-medium text-fg">{c.code}</span>
                          <span className="min-w-0 flex-1 truncate text-[13px] text-muted" title={c.shortDesc}>
                            {c.shortDesc}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ) : (
            <div className="grid gap-1.5">
              <p className="px-1 text-xs text-subtle">Common lookups</p>
              {EXAMPLES.map((e) => (
                <button key={e.code} onClick={() => select(e.code, e.system)} className="group flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left text-[13px] transition-colors hover:border-border-strong">
                  <span className="w-14 font-mono text-xs font-medium text-fg">{e.code}</span>
                  <span className="flex-1 text-muted">{e.hint}</span>
                  <ArrowRight className="size-3.5 text-subtle transition-transform group-hover:translate-x-0.5" />
                </button>
              ))}
            </div>
          )}
          <p className="px-1 text-[11px] leading-relaxed text-subtle">Procedure descriptions are summaries. Copyrighted CPT® descriptors are not shown.</p>
        </div>

        <div className="grid min-w-0 content-start gap-4">
          {!selected ? (
            <Card>
              <EmptyState art="chart" title="Choose a code" description="You'll see the policies that list it, the Medicare contractors that issue them and the states where they apply." />
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2.5">
                    <span className="font-mono text-xl font-semibold tracking-tight text-fg">{selected}</span>
                    <span className="text-xs text-subtle">{selSystem === "HCPCS" ? "Procedure code" : "Diagnosis code"}</span>
                  </p>
                  {description ? <p className="mt-0.5 text-[13px] text-muted">{description}</p> : null}
                  <p className="mt-2 text-sm text-fg">
                    {graph.isPending ? (
                      <span className="text-muted">Looking up coverage…</span>
                    ) : (
                      <>
                        <span className="tabular font-medium">{policies.filter((p) => p.inLibrary).length}</span> {policies.filter((p) => p.inLibrary).length === 1 ? "policy" : "policies"} · <span className="tabular font-medium">{allStates}</span> {allStates === 1 ? "state" : "states"}
                      </>
                    )}
                  </p>
                </div>
                <Button asChild variant="secondary" size="sm">
                  <Link href={`/policies?code=${encodeURIComponent(selected)}`}>Search the policy library</Link>
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="w-36">
                  <Select size="sm" value={state} onValueChange={setState} aria-label="State" options={[{ value: "all", label: "All states" }, ...US_STATES.map((s) => ({ value: s, label: s }))]} />
                </div>
                <label className="flex items-center gap-2 text-xs text-muted">
                  In effect on
                  <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 w-40 text-[13px]" aria-label="In effect on" />
                </label>
                <div className="min-w-[160px] flex-1 sm:max-w-xs">
                  <Input value={within} onChange={(e) => setWithin(e.target.value)} placeholder="Filter these policies" className="h-8 text-[13px]" aria-label="Filter these policies" />
                </div>
                <div className="ml-auto">
                  <Segmented
                    size="xs"
                    value={view}
                    onValueChange={setView}
                    options={[
                      { value: "list", label: "List" },
                      { value: "map", label: "Map" },
                    ]}
                  />
                </div>
              </div>

              {graph.isPending ? (
                <Skeleton className="h-72 rounded-lg" />
              ) : shown.length === 0 && notLoaded.length === 0 ? (
                <Card>
                  <EmptyState art="search" title="No policies found" description={policies.length ? "Nothing matches those filters." : "This code may be covered under general benefit rules rather than a specific policy."} />
                </Card>
              ) : view === "map" && map ? (
                <div className="grid gap-2">
                  <CoverageGraphView graph={map.graph} />
                  {map.hidden > 0 ? <p className="text-xs text-subtle">Showing 8 of {shown.length} policies. Use the filters to narrow the map, or switch to the list for everything.</p> : null}
                </div>
              ) : (
                <div className="grid gap-4">
                  {shown.length === 0 ? <p className="text-sm text-muted">None of the policies for this code are in your library yet.</p> : null}
                  {groups.map((g) => (
                    <Card key={g.id} className="overflow-hidden">
                      <div className="flex items-baseline gap-2 border-b border-border px-4 py-2.5">
                        <h3 className="text-[13px] font-medium text-fg">{g.name}</h3>
                        <span className="text-xs text-subtle">{g.detail ?? `${g.policies.length} ${g.policies.length === 1 ? "policy" : "policies"}`}</span>
                      </div>
                      <ul className="divide-y divide-border">
                        {g.policies.map((p) => (
                          <li key={p.key}>
                            <Link href={policyHref(p.key)} className="grid gap-0.5 px-4 py-3 outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2">
                              <span className="flex items-baseline gap-2 text-[13.5px]">
                                <span className="shrink-0 whitespace-nowrap font-mono text-xs font-medium text-fg">{p.key}</span>
                                {p.title !== p.key ? <span className="min-w-0 truncate text-fg">{p.title}</span> : null}
                              </span>
                              <span className="text-xs text-muted">
                                {p.kind === "ncd" ? "All states" : p.states.length === 0 ? "States not listed" : p.states.length <= 6 ? p.states.join(", ") : `${p.states.slice(0, 6).join(", ")} and ${p.states.length - 6} more`}
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  ))}
                  {notLoaded.length ? (
                    <p className="text-xs leading-relaxed text-subtle">
                      {notLoaded.length} more {notLoaded.length === 1 ? "policy refers" : "policies refer"} to this code but {notLoaded.length === 1 ? "isn't" : "aren't"} in your library yet ({notLoaded.slice(0, 8).map((p) => p.key).join(", ")}
                      {notLoaded.length > 8 ? ", …" : ""}). An administrator can add them from Policy updates.
                    </p>
                  ) : null}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </AppPage>
  );
}

export default function CoverageLookupPage() {
  return (
    <Suspense>
      <Lookup />
    </Suspense>
  );
}
