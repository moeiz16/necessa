"use client";

import { Search, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useDeferredValue, useMemo, useState } from "react";
import { useKnowledgeStats, usePolicies } from "@/lib/api/hooks";
import type { DocType } from "@/lib/api/types";
import { fmtCompact, fmtDate, fmtRelative } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { DOC_LABEL, US_STATES } from "@/components/policies/labels";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Breadcrumb, Card, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";

const TYPE_OPTIONS: { value: DocType | "all"; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "LCD", label: DOC_LABEL.LCD! },
  { value: "NCD", label: DOC_LABEL.NCD! },
  { value: "Billing and Coding", label: DOC_LABEL["Billing and Coding"]! },
  { value: "Payer Policy", label: DOC_LABEL["Payer Policy"]! },
];
const US = US_STATES;

/** Picks codes and states out of what was typed so they can be applied as filters. */
function detect(raw: string): { kind: "code" | "state"; value: string }[] {
  const out: { kind: "code" | "state"; value: string }[] = [];
  const seen = new Set<string>();
  const push = (kind: "code" | "state", value: string) => {
    if (!seen.has(`${kind}${value}`)) {
      seen.add(`${kind}${value}`);
      out.push({ kind, value });
    }
  };
  for (const m of raw.matchAll(/\b([A-Z]\d{4}|\d{4}[0-9T]|[A-TV-Z]\d{2}\.[0-9A-Z]{1,4})\b/gi)) {
    const v = m[1]!.toUpperCase();
    if (!/^[LA]\d{5}$/.test(v)) push("code", v);
  }
  for (const m of raw.matchAll(/\b([A-Z]{2})\b/g)) if (US.includes(m[1]!)) push("state", m[1]!);
  return out;
}

const terms = (q: string) =>
  q
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length > 2 && !["the", "and", "for", "with", "what", "which", "does"].includes(t));

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

export default function PolicyLibraryPage() {
  return (
    <Suspense>
      <PolicyLibrary />
    </Suspense>
  );
}

function PolicyLibrary() {
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDeferredValue(q.trim());
  const [type, setType] = useState<DocType | "all">("all");
  const [state, setState] = useState("all");
  const [code, setCode] = useState<string | null>(params.get("code"));
  const [asOf, setAsOf] = useState("");
  const [limit, setLimit] = useState(25);

  const stats = useKnowledgeStats();
  const policies = usePolicies({
    q: dq || undefined,
    docType: type === "all" ? undefined : type,
    state: state === "all" ? undefined : state,
    code: code ?? undefined,
    asOf: asOf || undefined,
    limit,
  });
  const detected = useMemo(() => detect(q), [q]);
  const items = policies.data?.items ?? [];
  const total = policies.data?.total ?? items.length;
  const filtered = type !== "all" || state !== "all" || !!code || !!asOf;
  const clear = () => {
    setType("all");
    setState("all");
    setCode(null);
    setAsOf("");
  };
  const s = stats.data;
  const all = s ? Object.values(s.policies).reduce((a, b) => a + b, 0) : null;
  const refreshed = s?.lastIngestion?.finishedAt ?? s?.lastIngestion?.startedAt;

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Policy library" }]} />} wide>
      <PageHeader
        title="Policy library"
        description={`Find the coverage policies that apply to your cases. Search by topic, code or policy number.${all ? ` ${fmtCompact(all)} policies${refreshed ? `, updated ${fmtRelative(refreshed)}` : ""}.` : ""}`}
      />

      <div className="grid gap-3">
        <Input
          leading={<Search />}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search, for example “CPAP adherence”, “knee arthroscopy” or L33718"
          className="h-11 text-[14px]"
          aria-label="Search policies"
        />

        <div className="flex flex-wrap items-center gap-2">
          <div className="w-52">
            <Select size="sm" value={type} onValueChange={(v) => setType(v as DocType | "all")} aria-label="Policy type" options={TYPE_OPTIONS} />
          </div>
          <div className="w-36">
            <Select size="sm" value={state} onValueChange={setState} aria-label="State" options={[{ value: "all", label: "All states" }, ...US.map((x) => ({ value: x, label: x }))]} />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            In effect on
            <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 w-40 text-[13px]" aria-label="In effect on" />
          </label>
          {code ? (
            <button onClick={() => setCode(null)} className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs text-fg ring-1 ring-inset ring-border hover:ring-border-strong" aria-label={`Remove filter for code ${code}`}>
              Code {code} <X className="size-3 text-subtle" />
            </button>
          ) : null}
          {filtered ? (
            <button onClick={clear} className="text-xs text-brand hover:underline">
              Clear filters
            </button>
          ) : null}
        </div>

        {detected.filter((d) => (d.kind === "code" ? code !== d.value : state !== d.value)).length ? (
          <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
            <span className="text-xs text-subtle">Narrow to</span>
            {detected
              .filter((d) => (d.kind === "code" ? code !== d.value : state !== d.value))
              .map((d) => (
                <button
                  key={`${d.kind}-${d.value}`}
                  type="button"
                  onClick={() => (d.kind === "code" ? setCode(d.value) : setState(d.value))}
                  className="inline-flex h-6 items-center rounded-full border border-border px-2.5 text-xs text-fg transition-colors hover:border-border-strong"
                >
                  {d.kind === "code" ? `Code ${d.value}` : `State ${d.value}`}
                </button>
              ))}
          </div>
        ) : null}

        <p className="px-0.5 text-xs text-muted" aria-live="polite">
          {policies.isFetching ? "Searching…" : `${fmtCompact(total)} ${total === 1 ? "policy" : "policies"}`}
        </p>

        {policies.isPending ? (
          <div className="grid gap-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)}</div>
        ) : items.length === 0 ? (
          <Card>
            <EmptyState
              art="search"
              title="No policies match"
              description="Try fewer words or a procedure code, or remove a filter. National policies apply in every state."
              action={filtered ? <Button variant="secondary" size="sm" onClick={clear}>Clear filters</Button> : undefined}
            />
          </Card>
        ) : (
          <ul className="grid gap-2" aria-label="Policies">
            {items.map((p) => (
              <li key={p.id}>
                <div className="group relative rounded-lg bg-surface p-4 shadow-e1 transition-colors focus-within:ring-2 focus-within:ring-ring hover:bg-surface-2/40">
                  <h3 className="text-[14.5px] font-medium leading-snug text-fg">
                    <Link href={`/policies/${p.id}`} className="outline-none after:absolute after:inset-0 after:rounded-lg">
                      <Highlight text={p.title} q={dq} />
                    </Link>
                  </h3>
                  {p.snippet ? (
                    <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-muted">
                      <Highlight text={p.snippet} q={dq} />
                    </p>
                  ) : null}
                  <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-subtle">
                    <span>{DOC_LABEL[p.docType] ?? p.docType}</span>
                    <span aria-hidden>·</span>
                    <span>{p.contractors[0]?.name ?? "Medicare, nationwide"}</span>
                    <span aria-hidden>·</span>
                    <span>{p.status === "future" ? `Takes effect ${fmtDate(p.effectiveFrom)}` : p.status === "retired" ? "No longer in effect" : p.effectiveFrom ? `In effect since ${fmtDate(p.effectiveFrom)}` : "In effect"}</span>
                    {p.docType !== "NCD" && p.states.length ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>{p.states.length === 1 ? p.states[0] : `${p.states.length} states`}</span>
                      </>
                    ) : null}
                    {p.hasCriteria ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="text-met-fg">Requirements checklist ready</span>
                      </>
                    ) : null}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {policies.data?.nextCursor || total > items.length ? (
          <div className="flex justify-center pt-2">
            <Button variant="secondary" size="sm" loading={policies.isFetching} onClick={() => setLimit((l) => Math.min(l + 25, 100))}>
              Show more
            </Button>
          </div>
        ) : null}
      </div>
    </AppPage>
  );
}
