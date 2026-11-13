"use client";

import { ArrowUpDown, BadgeCheck, BookOpen, CalendarClock, Database, Filter, Hash, Info, Layers, MapPin, RefreshCw, ScrollText, Search, Sparkles, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useKnowledgeStats, usePolicies } from "@/lib/api/hooks";
import type { DocType, PolicySummary } from "@/lib/api/types";
import { fmtCompact, fmtDate, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { DocTypeBadge } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { Checkbox, Segmented, Select } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, Kbd, PageHeader, SectionLabel, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/overlays";

const DOC_TYPES: { value: DocType; label: string }[] = [
  { value: "LCD", label: "Local coverage (LCD)" },
  { value: "NCD", label: "National coverage (NCD)" },
  { value: "Billing and Coding", label: "Billing & Coding article" },
  { value: "Article", label: "Policy article" },
];
const US = "AK AL AR AZ CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY".split(" ");

/* ── Query understanding (mirrors the backend's regex extractors, for instant feedback) ───────── */
type Detected = { kind: "policy" | "code" | "icd" | "state" | "ncd"; value: string };
function understand(raw: string): Detected[] {
  const out: Detected[] = [];
  const seen = new Set<string>();
  const push = (d: Detected) => {
    const k = `${d.kind}:${d.value}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(d);
    }
  };
  for (const m of raw.matchAll(/\b([LA]\d{5})\b/gi)) push({ kind: "policy", value: m[1]!.toUpperCase() });
  for (const m of raw.matchAll(/\b(\d{3}\.\d{1,2})\b/g)) push({ kind: "ncd", value: m[1]! });
  for (const m of raw.matchAll(/\b([A-Z]\d{4}|\d{4}[0-9T])\b/gi)) {
    const v = m[1]!.toUpperCase();
    if (!/^[LA]\d{5}$/.test(v)) push({ kind: "code", value: v });
  }
  for (const m of raw.matchAll(/\b([A-TV-Z]\d{2}\.[0-9A-Z]{1,4})\b/gi)) push({ kind: "icd", value: m[1]!.toUpperCase() });
  for (const m of raw.matchAll(/\b([A-Z]{2})\b/g)) if (US.includes(m[1]!)) push({ kind: "state", value: m[1]! });
  return out;
}

function terms(q: string) {
  return q
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length > 2 && !["the", "and", "for", "with", "what", "which", "does"].includes(t));
}

function Highlight({ text, q }: { text: string; q: string }) {
  const ts = terms(q);
  if (!ts.length) return <>{text}</>;
  const re = new RegExp(`(${ts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        ts.includes(part.toLowerCase()) ? (
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

function WhyThis({ p, q }: { p: PolicySummary; q: string }) {
  const ts = terms(q);
  const inTitle = ts.filter((t) => p.title.toLowerCase().includes(t));
  const inBody = ts.filter((t) => (p.snippet ?? "").toLowerCase().includes(t) && !inTitle.includes(t));
  const exact = understand(q).some((d) => d.value === p.sourceKey);
  return (
    <HoverCard openDelay={120}>
      <HoverCardTrigger asChild>
        <button className="ml-auto flex items-center gap-2 rounded-md px-1.5 py-0.5 text-xs text-muted outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Why this result: relevance ${(p.score ?? 0).toFixed(2)}`}>
          <span className="h-1 w-14 overflow-hidden rounded-full bg-surface-3">
            <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(6, (p.score ?? 0) * 100)}%` }} />
          </span>
          <span className="tabular">{(p.score ?? 0).toFixed(2)}</span>
          <Info className="size-3.5 text-subtle" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-80">
        <p className="text-xs font-semibold text-fg">Why this result</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">Hybrid retrieval: dense embeddings and BM25 sparse vectors are fused with reciprocal-rank fusion, then reranked. Relevance is relative to the best match for this query.</p>
        <ul className="mt-3 grid gap-1.5 text-xs">
          {exact ? (
            <li className="flex items-center gap-2 text-met-fg">
              <BadgeCheck className="size-3.5" /> Exact identifier match on {p.sourceKey}
            </li>
          ) : null}
          {inTitle.length ? (
            <li className="flex items-start gap-2 text-fg">
              <ScrollText className="mt-0.5 size-3.5 text-subtle" /> Title matches: {inTitle.map((t) => <code key={t} className="rounded bg-surface-2 px-1 font-mono text-[11px]">{t}</code>)}
            </li>
          ) : null}
          {inBody.length ? (
            <li className="flex items-start gap-2 text-fg">
              <Layers className="mt-0.5 size-3.5 text-subtle" /> Passage matches: {inBody.map((t) => <code key={t} className="rounded bg-surface-2 px-1 font-mono text-[11px]">{t}</code>)}
            </li>
          ) : null}
          {!exact && !inTitle.length && !inBody.length ? (
            <li className="flex items-start gap-2 text-fg">
              <Sparkles className="mt-0.5 size-3.5 text-ai-2" /> Semantic match — related wording rather than the exact terms
            </li>
          ) : null}
        </ul>
        <p className="mt-3 border-t border-border pt-2 text-[11px] text-subtle">Trace the full route, filters and per-stage scores in Ask Necessa → Retrieval inspector.</p>
      </HoverCardContent>
    </HoverCard>
  );
}

const CHIP: Record<Detected["kind"], { icon: typeof Hash; label: string }> = {
  policy: { icon: ScrollText, label: "Policy ID" },
  ncd: { icon: ScrollText, label: "NCD section" },
  code: { icon: Hash, label: "Procedure code" },
  icd: { icon: Hash, label: "ICD-10-CM" },
  state: { icon: MapPin, label: "State" },
};

export default function PoliciesPage() {
  return (
    <Suspense>
      <PoliciesInner />
    </Suspense>
  );
}

function PoliciesInner() {
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDeferredValue(q.trim());
  const [types, setTypes] = useState<DocType[]>([]);
  const [state, setState] = useState("all");
  const [status, setStatus] = useState("all");
  const [code, setCode] = useState<string | null>(params.get("code"));
  const [asOf, setAsOf] = useState("");
  const [sort, setSort] = useState<"relevance" | "effective" | "id">("relevance");
  const [limit, setLimit] = useState(50);
  const searchRef = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const base = {
    q: dq || undefined,
    state: state === "all" ? undefined : state,
    status: status === "all" ? undefined : status,
    code: code ?? undefined,
    asOf: asOf || undefined,
  };
  const stats = useKnowledgeStats();
  const policies = usePolicies({ ...base, docType: types.length ? types.join(",") : undefined, limit });
  // Facet counts come from the same query without the doc-type filter.
  const facetBase = usePolicies({ ...base, limit: 200 });
  const detected = useMemo(() => understand(q), [q]);
  const unfiltered = !dq && state === "all" && status === "all" && !code && !asOf;

  const counts = useMemo(() => {
    if (unfiltered && stats.data) return stats.data.policies;
    const c: Record<string, number> = {};
    for (const p of facetBase.data?.items ?? []) c[p.docType] = (c[p.docType] ?? 0) + 1;
    return c;
  }, [unfiltered, stats.data, facetBase.data]);

  const items = useMemo(() => {
    const list = [...(policies.data?.items ?? [])];
    if (sort === "effective") list.sort((a, b) => (b.effectiveFrom ?? "").localeCompare(a.effectiveFrom ?? ""));
    if (sort === "id") list.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
    return list;
  }, [policies.data, sort]);
  const s = stats.data;
  const activeFilters = [
    ...types.map((t) => ({ key: `t-${t}`, label: DOC_TYPES.find((d) => d.value === t)?.label ?? t, clear: () => setTypes(types.filter((x) => x !== t)) })),
    ...(state !== "all" ? [{ key: "state", label: `State: ${state}`, clear: () => setState("all") }] : []),
    ...(status !== "all" ? [{ key: "status", label: `Status: ${status}`, clear: () => setStatus("all") }] : []),
    ...(code ? [{ key: "code", label: `Lists code ${code}`, clear: () => setCode(null) }] : []),
    ...(asOf ? [{ key: "asof", label: `In effect on ${fmtDate(asOf)}`, clear: () => setAsOf("") }] : []),
  ];
  const clearAll = () => {
    setTypes([]);
    setState("all");
    setStatus("all");
    setCode(null);
    setAsOf("");
  };

  const facets = (
    <div className="grid content-start gap-6">
      <div className="grid gap-2.5">
        <SectionLabel>Document type</SectionLabel>
        {DOC_TYPES.map((t) => (
          <label key={t.value} className="flex cursor-pointer items-center gap-2 text-[13px] text-fg">
            <Checkbox checked={types.includes(t.value)} onCheckedChange={(v) => setTypes(v ? [...types, t.value] : types.filter((x) => x !== t.value))} />
            <span className="flex-1">{t.label}</span>
            <span className="tabular text-xs text-subtle">{counts[t.value] != null ? fmtCompact(counts[t.value]) : facetBase.data || stats.data ? "0" : "–"}</span>
          </label>
        ))}
      </div>
      <div className="grid gap-2">
        <SectionLabel>Jurisdiction</SectionLabel>
        <Select size="sm" value={state} onValueChange={setState} options={[{ value: "all", label: "All states" }, ...US.map((x) => ({ value: x, label: x }))]} aria-label="State" />
        <p className="text-[11px] leading-relaxed text-subtle">LCDs and articles are filtered by their contractor&apos;s jurisdiction. NCDs apply nationally and always match.</p>
      </div>
      <div className="grid gap-2">
        <SectionLabel>In effect on</SectionLabel>
        <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 text-[13px]" aria-label="As-of date" leading={<CalendarClock />} />
        <p className="text-[11px] leading-relaxed text-subtle">Use the date of service to see the version a payer would apply.</p>
      </div>
      <div className="grid gap-2">
        <SectionLabel>Status</SectionLabel>
        <Select size="sm" value={status} onValueChange={setStatus} options={[{ value: "all", label: "Any status" }, { value: "active", label: "Active" }, { value: "future", label: "Future effective" }, { value: "retired", label: "Retired" }]} aria-label="Status" />
      </div>
    </div>
  );

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Knowledge" }, { label: "Policy library" }]} />} wide>
      <PageHeader
        title="Policy library"
        description="National and local coverage determinations and billing articles from the CMS Medicare Coverage Database — versioned, searchable, and compiled into checkable criteria."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { icon: BookOpen, label: "Coverage documents", value: s ? fmtCompact(Object.values(s.policies).reduce((a, b) => a + b, 0)) : null, sub: s ? `${fmtCompact(s.policies.LCD ?? 0)} LCDs · ${fmtCompact(s.policies.NCD ?? 0)} NCDs · ${fmtCompact((s.policies.Article ?? 0) + (s.policies["Billing and Coding"] ?? 0))} articles` : "" },
          { icon: Layers, label: "Indexed passages", value: s ? fmtCompact(s.chunks) : null, sub: s?.activeIndex ? `active index · ${s.activeIndex}` : "" },
          { icon: Database, label: "Codes linked", value: s ? fmtCompact(s.codes) : null, sub: "HCPCS · ICD-10-CM covered and non-covered" },
          {
            icon: RefreshCw,
            label: "Last refresh",
            value: s ? fmtRelative(s.lastIngestion) : null,
            sub: s?.freshnessHours != null ? (s.freshnessHours <= 48 ? "Within the 48 h freshness target" : "Behind the 48 h freshness target") : "CMS weekly export · incremental",
            tone: s?.freshnessHours != null && s.freshnessHours > 48 ? "warn" : "ok",
          },
        ].map((x) => (
          <Card key={x.label} className="flex items-center gap-3 p-4">
            <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted", x.tone === "warn" && "bg-insufficient-soft text-insufficient-fg")}>
              <x.icon className="size-4" />
            </span>
            <div className="grid min-w-0">
              <span className="text-xs text-muted">{x.label}</span>
              {x.value === null ? <Skeleton className="mt-1 h-5 w-16" /> : <span className="tabular text-lg font-semibold tracking-tight text-fg">{x.value}</span>}
              <span className="truncate text-[11px] text-subtle" title={x.sub}>
                {x.sub}
              </span>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[244px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <div className="sticky top-20">{facets}</div>
        </aside>
        <details className="group rounded-xl bg-surface p-3 shadow-e1 lg:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-fg">
            <Filter className="size-4 text-subtle" /> Filters
            {activeFilters.length ? <Badge tone="brand" size="xs">{activeFilters.length}</Badge> : null}
            <span className="ml-auto text-xs text-subtle group-open:hidden">Show</span>
            <span className="ml-auto hidden text-xs text-subtle group-open:inline">Hide</span>
          </summary>
          <div className="mt-4">{facets}</div>
        </details>

        <div className="grid min-w-0 content-start gap-3">
          <Input
            ref={searchRef}
            leading={<Search />}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search policy language — “conservative care 4 weeks”, “L36920”, “CPAP adherence”"
            className="h-11 text-[14px]"
            trailing={dq ? (
              <Badge tone="ai" size="xs">
                <Sparkles className="text-ai-2" /> hybrid
              </Badge>
            ) : (
              <Kbd>/</Kbd>
            )}
            aria-label="Search policies"
          />

          {detected.length ? (
            <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
              <span className="text-xs text-subtle">Understood as</span>
              {detected.map((d) => {
                const meta = CHIP[d.kind];
                const actionable = d.kind === "code" || d.kind === "state";
                const active = (d.kind === "code" && code === d.value) || (d.kind === "state" && state === d.value);
                return (
                  <button
                    key={`${d.kind}-${d.value}`}
                    type="button"
                    disabled={!actionable}
                    onClick={() => {
                      if (d.kind === "code") setCode(active ? null : d.value);
                      if (d.kind === "state") setState(active ? "all" : d.value);
                    }}
                    className={cn(
                      "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
                      active ? "border-brand bg-brand-soft text-brand-fg" : "border-border bg-surface text-fg",
                      actionable ? "hover:border-border-strong" : "cursor-default",
                    )}
                    title={actionable ? (active ? "Remove filter" : "Apply as filter") : "Matched exactly by the identifier path"}
                  >
                    <meta.icon className="size-3 text-subtle" />
                    <span className="text-subtle">{meta.label}</span>
                    <span className="font-mono font-medium">{d.value}</span>
                    {actionable ? <span className="text-subtle">{active ? "· filtering" : "· filter"}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 px-0.5">
            <p className="text-xs text-muted" aria-live="polite">
              {policies.isFetching ? "Searching…" : `${fmtCompact(policies.data?.total ?? items.length)} ${(policies.data?.total ?? items.length) === 1 ? "document" : "documents"}`}
              {dq ? " · dense + BM25 fusion, reranked" : ""}
            </p>
            {activeFilters.map((f) => (
              <button key={f.key} onClick={f.clear} className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs text-fg ring-1 ring-inset ring-border hover:ring-border-strong" aria-label={`Remove filter ${f.label}`}>
                {f.label} <X className="size-3 text-subtle" />
              </button>
            ))}
            {activeFilters.length > 1 ? (
              <button onClick={clearAll} className="text-xs text-brand hover:underline">
                Clear all
              </button>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <ArrowUpDown className="size-3.5 text-subtle" aria-hidden />
              <Segmented
                size="xs"
                value={sort}
                onValueChange={setSort}
                options={[
                  { value: "relevance", label: dq ? "Relevance" : "Default" },
                  { value: "effective", label: "Newest" },
                  { value: "id", label: "ID" },
                ]}
              />
            </div>
          </div>

          {policies.isPending ? (
            <div className="grid gap-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[108px] rounded-xl" />)}</div>
          ) : items.length === 0 ? (
            <Card>
              <EmptyState
                art="search"
                title="No policies match"
                description="Try fewer words, a procedure code, or remove a filter. NCDs always apply nationally."
                action={activeFilters.length ? <Button variant="secondary" size="sm" onClick={clearAll}>Clear filters</Button> : undefined}
              />
            </Card>
          ) : (
            <ul className="grid gap-2.5" aria-label="Policies">
              {items.map((p, i) => (
                <motion.li
                  key={p.id}
                  initial={reduce ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.22, delay: reduce ? 0 : Math.min(i, 10) * 0.025, ease: [0.2, 0.8, 0.2, 1] }}
                >
                  <div className="group relative rounded-xl bg-surface p-4 shadow-e1 transition-shadow focus-within:ring-2 focus-within:ring-ring hover:shadow-e2">
                    <div className="flex flex-wrap items-center gap-2">
                      <DocTypeBadge docType={p.docType} />
                      <span className="font-mono text-xs font-medium text-fg">{p.sourceKey}</span>
                      <span className="text-xs text-subtle">v{p.version}</span>
                      {p.status !== "active" ? (
                        <Badge tone={p.status === "future" ? "info" : "neutral"} size="xs">
                          {p.status === "future" ? `Effective ${fmtDate(p.effectiveFrom, "MMM d")}` : "Retired"}
                        </Badge>
                      ) : null}
                      {p.hasCriteria ? (
                        <Badge tone="met" size="xs">
                          <BadgeCheck /> Criteria compiled
                        </Badge>
                      ) : null}
                      {p.score != null && dq ? <WhyThis p={p} q={dq} /> : null}
                    </div>
                    <h3 className="mt-2 text-[14.5px] font-semibold leading-snug tracking-tight text-fg">
                      <Link href={`/policies/${p.id}`} className="outline-none after:absolute after:inset-0 after:rounded-xl group-hover:text-brand">
                        <Highlight text={p.title} q={dq} />
                      </Link>
                    </h3>
                    {p.snippet ? (
                      <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted">
                        <Highlight text={p.snippet} q={dq} />
                      </p>
                    ) : null}
                    <p className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
                      <span>{p.contractors[0]?.name ?? "National coverage"}</span>
                      <span>effective {fmtDate(p.effectiveFrom)}</span>
                      {p.docType === "NCD" ? <span>all states</span> : p.states.length ? <span>{p.states.length} states</span> : null}
                      {p.codeCount ? <span>{fmtCompact(p.codeCount)} codes</span> : null}
                    </p>
                  </div>
                </motion.li>
              ))}
            </ul>
          )}
          {policies.data?.nextCursor || (policies.data?.total ?? 0) > items.length ? (
            <div className="flex justify-center pt-2">
              <Button variant="secondary" size="sm" loading={policies.isFetching} onClick={() => setLimit((l) => l + 50)}>
                Show more
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </AppPage>
  );
}
