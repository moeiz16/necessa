"use client";

import { ArrowRight, Check, Columns2, Copy, ExternalLink, Link2, MessageCircle, Rows2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { usePolicy, usePolicyCodes, usePolicyCriteria, usePolicyDiff } from "@/lib/api/hooks";
import type { CriteriaNode, CriteriaSet, DiffHunk, PolicyCode, PolicyDetail } from "@/lib/api/types";
import { Can } from "@/lib/api/session";
import { fmtDate, fmtNumber, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { CriteriaTreeView } from "@/components/policies/criteria-tree";
import { DOC_LABEL } from "@/components/policies/labels";
import { Button } from "@/components/ui/button";
import { Segmented, Select, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, CardBody, CardHeader, DataList, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { DiffViewer } from "@/components/ui/widgets";

const REGIONS: { name: string; states: string[] }[] = [
  { name: "Northeast", states: ["ME", "NH", "VT", "MA", "RI", "CT", "NY", "NJ", "PA"] },
  { name: "Midwest", states: ["OH", "MI", "IN", "IL", "WI", "MN", "IA", "MO", "ND", "SD", "NE", "KS"] },
  { name: "South", states: ["DE", "MD", "DC", "VA", "WV", "NC", "SC", "GA", "FL", "KY", "TN", "AL", "MS", "AR", "LA", "OK", "TX"] },
  { name: "West", states: ["MT", "ID", "WY", "CO", "NM", "AZ", "UT", "NV", "CA", "OR", "WA", "AK", "HI"] },
];

/* ── helpers ─────────────────────────────────────────────────────────────── */
function leaves(n: CriteriaNode): CriteriaNode[] {
  return n.children?.length ? n.children.flatMap(leaves) : [n];
}

const STATUS_LABEL: Record<string, string> = { approved: "Reviewed", needs_review: "Needs review", draft: "Draft", rejected: "Rejected", superseded: "Replaced" };

function Provenance({ set }: { set: CriteriaSet }) {
  const n = leaves(set.tree).length;
  const matched = Math.round(set.groundingPassRate * n);
  const donor = set.extractorModel.startsWith("transfer:") ? set.extractorModel.slice("transfer:".length) : null;
  if (set.status === "needs_review")
    return (
      <Banner tone="insufficient" icon={<TriangleAlert />} title={donor ? `Imported from a similar policy (${donor}). A reviewer must confirm it.` : "Waiting for a reviewer"}>
        {donor
          ? `${matched} of ${n} requirements match this policy's wording. A reviewer needs to update the rest before it's used to check cases.`
          : "This checklist was prepared automatically. It's used to check cases only after a reviewer approves it."}
      </Banner>
    );
  if (set.status === "approved")
    return (
      <Banner tone="met" icon={<Check />} title={donor ? "Imported from a similar policy and confirmed" : "Reviewed and approved"}>
        All {n} requirements match this policy&apos;s wording
        {set.reviewedBy ? `. Reviewed by ${set.reviewedBy.fullName} ${fmtRelative(set.reviewedAt)}` : ""}.
      </Banner>
    );
  return (
    <Banner tone="neutral" icon={<TriangleAlert />} title={STATUS_LABEL[set.status] ?? "Not in use"}>
      {set.notes ?? "This checklist isn't being used."}
    </Banner>
  );
}

function Banner({ tone, icon, title, children }: { tone: "met" | "insufficient" | "neutral"; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div role="status" className="flex gap-3 rounded-lg border border-border bg-surface p-3.5 [&>span>svg]:size-4">
      <span className={cn("mt-0.5", tone === "met" ? "text-met" : tone === "insufficient" ? "text-insufficient" : "text-muted")}>{icon}</span>
      <div className="grid gap-0.5">
        <p className="text-[13px] font-medium text-fg">{title}</p>
        <p className="text-[13px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}

function SideBySide({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="grid gap-3 text-[13px] leading-relaxed md:grid-cols-2">
      {(["before", "after"] as const).map((side) => (
        <div key={side} className="rounded-lg border border-border bg-surface-2/40 p-3">
          <p className="mb-1.5 text-[11px] font-medium text-subtle">{side === "before" ? "Before" : "After"}</p>
          <p className="text-fg">
            {hunks.map((h, i) =>
              h.op === "equal" ? (
                <span key={i}>{h.text}</span>
              ) : (side === "before" && h.op === "delete") || (side === "after" && h.op === "insert") ? (
                <span key={i} className={cn("rounded-[3px] px-0.5", h.op === "delete" ? "bg-notmet-soft text-notmet-fg line-through decoration-notmet/50" : "bg-met-soft text-met-fg")}>
                  {h.text}
                </span>
              ) : null,
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

function useScrollSpy(ids: string[]) {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    if (!ids.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -65% 0px", threshold: 0 },
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, [ids]);
  return active;
}

function ReadingProgress({ target }: { target: React.RefObject<HTMLElement | null> }) {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const on = () => {
      const el = target.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const total = r.height - window.innerHeight + 120;
      setPct(Math.min(1, Math.max(0, (120 - r.top) / Math.max(1, total))));
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, [target]);
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-label="Reading progress" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-brand transition-[width] duration-150" style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

/* ── tabs ────────────────────────────────────────────────────────────────── */
function TextTab({ d }: { d: PolicyDetail }) {
  const ids = useMemo(() => d.sections.map((s) => `sec-${s.id}`), [d.sections]);
  const active = useScrollSpy(ids);
  const bodyRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyLink = async (id: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#${id}`);
      setCopied(id);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      toast.error("Couldn't copy the link");
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[232px_minmax(0,1fr)]">
      <nav className="hidden content-start gap-3 lg:sticky lg:top-20 lg:grid" aria-label="Sections">
        <ReadingProgress target={bodyRef} />
        <ol className="grid gap-0.5">
          {d.sections.map((s, i) => {
            const on = active === `sec-${s.id}`;
            return (
              <li key={s.id}>
                <a href={`#sec-${s.id}`} aria-current={on ? "location" : undefined} className={cn("flex items-baseline gap-2 rounded-md px-2.5 py-1.5 text-[13px] transition-colors", on ? "bg-surface text-fg shadow-e1" : "text-muted hover:text-fg")}>
                  <span className="tabular text-[11px] text-subtle">{String(i + 1).padStart(2, "0")}</span>
                  {s.title}
                </a>
              </li>
            );
          })}
        </ol>
      </nav>
      <Card>
        <CardBody className="pt-6">
          <article ref={bodyRef} className="max-w-[76ch]">
            {d.sections.map((s) => (
              <section key={s.id} id={`sec-${s.id}`} className="group mb-9 scroll-mt-24">
                <h2 className="flex items-center gap-2 text-[16px] font-semibold tracking-tight text-fg">
                  {s.title}
                  <button onClick={() => copyLink(`sec-${s.id}`)} className="rounded p-1 text-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100" aria-label={`Copy link to ${s.title}`}>
                    {copied === `sec-${s.id}` ? <Check className="size-3.5 text-met" /> : <Link2 className="size-3.5" />}
                  </button>
                </h2>
                <div className="mt-2.5 grid gap-3 text-[14.5px] leading-[1.8] text-fg">
                  {s.text.split("\n").filter(Boolean).map((para, i) => (
                    <p key={i} className={cn(/^\s*(\d+\.|[-•*])\s/.test(para) && "pl-4 -indent-4")}>
                      {para}
                    </p>
                  ))}
                </div>
              </section>
            ))}
            <p className="border-t border-border pt-4 text-xs text-subtle">
              Condensed for display. The authoritative text is version {d.version} in the CMS Medicare Coverage Database.
            </p>
          </article>
        </CardBody>
      </Card>
    </div>
  );
}

function CriteriaTab({ id, sourceText }: { id: string; sourceText: string }) {
  const criteria = usePolicyCriteria(id);
  if (criteria.isPending) return <Skeleton className="h-64 rounded-xl" />;
  if (!criteria.data)
    return (
      <Card>
        <EmptyState
          art="spark"
          title="No requirements checklist yet"
          description="A checklist turns this policy into items your team can check each case against. Your administrator prepares and reviews it."
          action={
            <Can perm="knowledge:admin">
              <Button asChild variant="secondary" size="sm">
                <Link href="/knowledge?tab=review">Open Policy updates</Link>
              </Button>
            </Can>
          }
        />
      </Card>
    );
  const set = criteria.data;
  const n = leaves(set.tree).length;
  return (
    <div className="grid gap-4">
      <Provenance set={set} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card>
          <CardHeader title={`Requirements checklist · ${n}`} description="Each requirement quotes the part of the policy it comes from" />
          <CardBody>
            <CriteriaTreeView node={set.tree} sourceText={sourceText} />
          </CardBody>
        </Card>
        <Card className="h-fit lg:sticky lg:top-20">
          <CardHeader title="Review status" />
          <CardBody>
            <DataList
              items={[
                { label: "Status", value: <Badge tone={set.status === "approved" ? "met" : set.status === "needs_review" ? "insufficient" : "neutral"}>{STATUS_LABEL[set.status] ?? set.status}</Badge> },
                { label: "Prepared by", value: set.extractorModel.startsWith("transfer:") ? `Imported from ${set.extractorModel.slice(9)}` : set.extractorModel === "curated" ? "Clinical content team" : "Prepared automatically" },
                {
                  label: "Matches the policy",
                  value: (
                    <span className={cn(set.groundingPassRate < 1 && "text-insufficient-fg")}>
                      {Math.round(set.groundingPassRate * n)} of {n} requirements
                    </span>
                  ),
                },
                { label: "Reviewed", value: set.reviewedBy ? `${set.reviewedBy.fullName}, ${fmtDate(set.reviewedAt)}` : "Not yet" },
              ]}
            />
            <Can perm="criteria:review">
              <Button asChild variant={set.status === "needs_review" ? "primary" : "secondary"} size="sm" className="mt-4 w-full">
                <Link href={`/knowledge/criteria/${set.id}`}>
                  {set.status === "needs_review" ? "Review now" : "Edit checklist"} <ArrowRight />
                </Link>
              </Button>
            </Can>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function VersionsTab({ d }: { d: PolicyDetail }) {
  const [from, setFrom] = useState(d.versions[1]?.version ?? d.version);
  const [to, setTo] = useState(d.version);
  const [layout, setLayout] = useState<"inline" | "split">("inline");
  const [showSame, setShowSame] = useState(false);
  const diff = usePolicyDiff(d.id, from, to, from !== to);
  const summary = useMemo(() => {
    const sec = diff.data?.sections ?? [];
    return { changed: sec.filter((s) => s.status !== "same").length, total: sec.length };
  }, [diff.data]);
  const versions = [...d.versions].sort((a, b) => b.version - a.version);

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader title="Version history" description={`${d.versions.length} ${d.versions.length === 1 ? "version" : "versions"} on record`} />
        <CardBody>
          <ol className="relative grid gap-4 border-l border-border pl-5">
            {versions.map((v) => {
              const current = v.version === d.version;
              const selected = v.version === from || v.version === to;
              return (
                <li key={v.id} className="relative">
                  <span className={cn("absolute -left-[26px] top-1 size-2.5 rounded-full ring-4 ring-surface", current ? "bg-brand" : selected ? "bg-fg" : "bg-border-strong")} aria-hidden />
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-fg">v{v.version}</span>
                    {current ? <Badge tone="brand" size="xs">Current</Badge> : null}
                    <span className="ml-auto text-xs text-subtle">{fmtDate(v.effectiveFrom)}</span>
                  </div>
                  {v.summary ? <p className="mt-1 text-xs leading-relaxed text-muted">{v.summary}</p> : null}
                  {!current ? (
                    <button onClick={() => { setFrom(v.version); setTo(d.version); }} className="mt-1 text-xs text-brand hover:underline">
                      Compare with current
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </CardBody>
      </Card>
      <Card className="min-w-0">
        <CardHeader
          title="Compare versions"
          description="See exactly what changed between two versions"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Select size="sm" className="w-24" value={String(from)} onValueChange={(v) => setFrom(Number(v))} options={versions.map((v) => ({ value: String(v.version), label: `v${v.version}` }))} aria-label="Older version" />
              <ArrowRight className="size-3.5 text-subtle" aria-hidden />
              <Select size="sm" className="w-24" value={String(to)} onValueChange={(v) => setTo(Number(v))} options={versions.map((v) => ({ value: String(v.version), label: `v${v.version}` }))} aria-label="Newer version" />
              <Segmented
                size="xs"
                value={layout}
                onValueChange={setLayout}
                options={[
                  { value: "inline", label: <span className="flex items-center gap-1"><Rows2 className="size-3" /> Inline</span> },
                  { value: "split", label: <span className="flex items-center gap-1"><Columns2 className="size-3" /> Split</span> },
                ]}
              />
            </div>
          }
        />
        <CardBody className="grid gap-5">
          {from === to ? (
            <EmptyState compact art="search" title="Choose two different versions" description="Pick an older version on the left, or use the menus above." />
          ) : diff.isPending ? (
            <Skeleton className="h-48" />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2/60 px-3 py-2 text-xs text-muted">
                <span className="font-medium text-fg">
                  v{diff.data?.from} → v{diff.data?.to}
                </span>
                <span>
                  {summary.changed} of {summary.total} sections changed
                </span>
                <button onClick={() => setShowSame((x) => !x)} className="ml-auto text-brand hover:underline">
                  {showSame ? "Hide unchanged" : "Show unchanged"}
                </button>
              </div>
              {diff.data?.sections
                .filter((s) => showSame || s.status !== "same")
                .map((s) => (
                  <div key={s.sectionKey} className="grid gap-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[13px] font-semibold text-fg">{s.title}</h3>
                      <Badge tone={s.status === "changed" ? "insufficient" : s.status === "added" ? "met" : s.status === "removed" ? "notmet" : "neutral"} size="xs">
                        {s.status === "changed" ? "Changed" : s.status === "added" ? "Added" : s.status === "removed" ? "Removed" : "Unchanged"}
                      </Badge>
                    </div>
                    {s.status === "same" ? <p className="line-clamp-2 text-[13px] text-subtle">{s.hunks[0]?.text}</p> : layout === "split" ? <SideBySide hunks={s.hunks} /> : <DiffViewer hunks={s.hunks} />}
                  </div>
                ))}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

const SYSTEMS: { value: PolicyCode["codeSystem"]; label: string; short: string }[] = [
  { value: "HCPCS", label: "Procedure codes", short: "Procedures" },
  { value: "ICD10_COVERED", label: "Covered diagnoses", short: "Covered diagnoses" },
  { value: "ICD10_NONCOVERED", label: "Diagnoses not covered", short: "Not covered" },
];

function CodesTab({ d }: { d: PolicyDetail }) {
  const [system, setSystem] = useState<PolicyCode["codeSystem"]>("HCPCS");
  const codes = usePolicyCodes(d.id, system);
  const [filter, setFilter] = useState("");
  const groups = useMemo(() => {
    const list = (codes.data?.items ?? []).filter((c) => `${c.code} ${c.description}`.toLowerCase().includes(filter.toLowerCase()));
    const m = new Map<number, PolicyCode[]>();
    for (const c of list) m.set(c.groupNo, [...(m.get(c.groupNo) ?? []), c]);
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [codes.data, filter]);
  const total = groups.reduce((a, [, l]) => a + l.length, 0);
  return (
    <Card>
      <CardHeader
        title="Codes"
        description="Procedure and diagnosis codes listed in the related billing and coding article"
        actions={
          <Segmented
            size="xs"
            value={system}
            onValueChange={setSystem}
            options={SYSTEMS.map((s) => ({ value: s.value, label: d.codeCounts?.[s.value] != null ? `${s.short} · ${fmtNumber(d.codeCounts[s.value])}` : s.short }))}
          />
        }
      />
      <CardBody className="grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input placeholder="Filter by code or description" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 max-w-xs" aria-label="Filter codes" />
          <span className="text-xs text-muted">{codes.isPending ? "Loading…" : `${fmtNumber(total)} codes in ${groups.length} ${groups.length === 1 ? "group" : "groups"}`}</span>
        </div>
        {codes.isPending ? (
          <Skeleton className="h-40" />
        ) : total === 0 ? (
          <EmptyState compact art="search" title="No codes in this group" description="Code lists are published in the linked billing and coding article." />
        ) : (
          <div className="grid gap-4">
            {groups.map(([group, list]) => (
              <div key={group} className="overflow-hidden rounded-lg border border-border">
                <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2 text-xs">
                  <span className="font-medium text-fg">Group {group}</span>
                  <span className="text-subtle">{list.length} codes</span>
                  {system === "ICD10_NONCOVERED" ? <Badge tone="notmet" size="xs">Not covered</Badge> : system === "ICD10_COVERED" ? <Badge tone="met" size="xs">Covered</Badge> : null}
                </div>
                <table className="w-full text-[13px]">
                  <caption className="sr-only">
                    {SYSTEMS.find((s) => s.value === system)?.label} group {group}
                  </caption>
                  <tbody>
                    {list.slice(0, 200).map((c) => (
                      <tr key={`${c.codeSystem}-${c.code}`} className="border-t border-border/70 first:border-0 hover:bg-surface-2/50">
                        <td className="w-28 px-3 py-2 align-top">
                          <Link href={`/codes?code=${c.code}&system=${c.codeSystem === "HCPCS" ? "HCPCS" : "ICD10CM"}`} className="font-mono text-xs font-semibold text-brand hover:underline">
                            {c.code}
                          </Link>
                          {c.isRange ? <span className="ml-1 text-[11px] text-subtle">range</span> : null}
                        </td>
                        <td className="px-3 py-2 text-fg">{c.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] text-subtle">Procedure descriptions are summaries. Copyrighted CPT® descriptors are not shown.</p>
      </CardBody>
    </Card>
  );
}

function JurisdictionTab({ d }: { d: PolicyDetail }) {
  const national = d.docType === "NCD";
  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <Card>
        <CardHeader title="Where this policy applies" description={national ? "National policy. It applies in every state." : `${d.states.length} states, issued by ${d.contractors.length === 1 ? "one Medicare contractor" : `${d.contractors.length} Medicare contractors`}`} />
        <CardBody className="grid gap-4">
          {REGIONS.map((r) => (
            <div key={r.name} className="grid gap-1.5">
              <p className="text-[11px] font-medium text-subtle">{r.name}</p>
              <div className="flex flex-wrap gap-1">
                {r.states.map((s) => {
                  const on = national || d.states.includes(s);
                  return (
                    <span key={s} title={on ? `${s}: applies` : `${s}: not covered by this policy`} className={cn("flex h-7 w-9 items-center justify-center rounded-md font-mono text-[11px] font-medium transition-colors", on ? "bg-brand text-brand-contrast" : "bg-surface-2 text-subtle")}>
                      {s}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="flex items-center gap-4 border-t border-border pt-3 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-brand" /> Applies
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm bg-surface-3" /> Not covered by this policy
            </span>
          </div>
        </CardBody>
      </Card>
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader title="Issued by" />
          <CardBody className="grid gap-2">
            {national ? (
              <p className="text-[13px] text-muted">Centers for Medicare &amp; Medicaid Services (national policy).</p>
            ) : (
              d.contractors.map((c) => (
                <div key={c.id} className="flex items-center gap-3 rounded-lg border border-border p-3">
                  <span className="text-[11px] text-subtle">Medicare contractor</span>
                  <span className="text-[13px] font-medium text-fg">{c.name}</span>
                </div>
              ))
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Related policies" description="Policies and articles this one works with" />
          <CardBody className="grid gap-2">
            {d.linked.length === 0 ? <p className="text-[13px] text-muted">No related policies.</p> : null}
            {d.linked.map((l) => (
              <Link key={`${l.policyId}-${l.relation}`} href={`/policies/${l.policyId}`} className="group flex items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:border-border-strong hover:bg-surface-2/40">
                <span className="grid min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs font-medium text-fg">{l.sourceKey}</span>
                    <span className="text-[11px] text-subtle">{DOC_LABEL[l.docType] ?? l.docType}</span>
                  </span>
                  <span className="line-clamp-2 text-[13px] text-muted">{l.title}</span>
                </span>
                <ArrowRight className="ml-auto mt-1 size-3.5 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-fg" />
              </Link>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/* ── page ────────────────────────────────────────────────────────────────── */
export default function PolicyPage() {
  const { id: ref } = useParams<{ id: string }>();
  const router = useRouter();
  const p = usePolicy(ref);
  const criteria = usePolicyCriteria(p.data?.id ?? "");
  const [tab, setTab] = useState("sections");

  if (p.isPending)
    return (
      <AppPage wide>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-3 h-8 w-2/3" />
        <Skeleton className="mt-6 h-10 w-full rounded-lg" />
        <Skeleton className="mt-4 h-[520px] rounded-xl" />
      </AppPage>
    );
  if (!p.data)
    return (
      <AppPage>
        <EmptyState art="search" title="Policy not found" description="It may have been retired, or the identifier is mistyped." action={<Button onClick={() => router.push("/policies")}>Back to library</Button>} />
      </AppPage>
    );

  const d = p.data;
  const cs = criteria.data;
  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Policy library", href: "/policies" }, { label: d.sourceKey }]} />} wide>
      <div className="flex flex-col gap-4 pb-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">{DOC_LABEL[d.docType] ?? d.docType}</span>
            <span className="font-mono text-sm font-medium text-fg">{d.sourceKey}</span>
            <Badge tone="outline" size="xs">
              v{d.version}
            </Badge>
            <Badge tone={d.status === "active" ? "met" : d.status === "future" ? "info" : "neutral"} size="xs" dot>
              {d.status === "future" ? `Takes effect ${fmtDate(d.effectiveFrom)}` : d.status === "retired" ? "No longer in effect" : "In effect"}
            </Badge>
            {cs ? (
              <button onClick={() => setTab("criteria")} className="outline-none">
                <Badge tone={cs.status === "approved" ? "met" : "insufficient"} size="xs">
                  {cs.status === "approved" ? `${leaves(cs.tree).length} requirements` : "Checklist needs review"}
                </Badge>
              </button>
            ) : null}
          </div>
          <h1 className="mt-2 max-w-3xl text-[22px] font-semibold leading-tight tracking-[-0.02em] text-fg text-balance">{d.title}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
            <span className="flex items-center gap-1.5">
              {d.contractors[0]?.name ?? "Medicare, nationwide"}
              {d.contractors.length > 1 ? ` +${d.contractors.length - 1}` : ""}
            </span>
            <span className="flex items-center gap-1.5">
              In effect from {fmtDate(d.effectiveFrom)}
              {d.effectiveTo ? ` – ${fmtDate(d.effectiveTo)}` : ""}
            </span>
            <span className="flex items-center gap-1.5">
              {d.docType === "NCD" ? "All states" : `${d.states.length} states`}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => router.push(`/assistant?q=${encodeURIComponent(`Summarize the coverage indications and documentation requirements of ${d.sourceKey}`)}`)}>
            <MessageCircle /> Ask about this policy
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(d.sourceKey);
                toast.success(`Copied ${d.sourceKey}`);
              } catch {
                toast.error("Couldn't copy");
              }
            }}
            aria-label="Copy policy ID"
          >
            <Copy />
          </Button>
          {d.url ? (
            <Button asChild variant="ghost">
              <a href={d.url} target="_blank" rel="noreferrer">
                View on CMS.gov <ExternalLink />
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4 max-w-full overflow-x-auto scrollbar-thin">
          <TabsTrigger value="sections">Policy text</TabsTrigger>
          <TabsTrigger value="criteria" count={cs ? leaves(cs.tree).length : null}>
            Requirements
          </TabsTrigger>
          <TabsTrigger value="versions" count={d.versions.length}>
            What changed
          </TabsTrigger>
          <TabsTrigger value="codes" count={d.codeCount || null}>
            Codes
          </TabsTrigger>
          <TabsTrigger value="coverage">Where it applies</TabsTrigger>
        </TabsList>
        <TabsContent value="sections">
          <TextTab d={d} />
        </TabsContent>
        <TabsContent value="criteria">
          <CriteriaTab id={d.id} sourceText={d.sections.map((x) => x.text).join("\n")} />
        </TabsContent>
        <TabsContent value="versions">
          <VersionsTab d={d} />
        </TabsContent>
        <TabsContent value="codes">
          <CodesTab d={d} />
        </TabsContent>
        <TabsContent value="coverage">
          <JurisdictionTab d={d} />
        </TabsContent>
      </Tabs>
    </AppPage>
  );
}
