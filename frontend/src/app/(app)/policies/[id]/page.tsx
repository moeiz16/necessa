"use client";

import { ArrowRight, BadgeCheck, ExternalLink, GitCompare, Hash, Link2, ListChecks, MapPin, ScrollText, Sparkles } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { usePolicy, usePolicyCodes, usePolicyCriteria, usePolicyDiff } from "@/lib/api/hooks";
import { Can } from "@/lib/api/session";
import { fmtDate, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { CriteriaTreeView } from "@/components/policies/criteria-tree";
import { DocTypeBadge } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { Segmented, Select, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, CardBody, CardHeader, DataList, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { DiffViewer } from "@/components/ui/widgets";

const US = "AK AL AR AZ CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY".split(" ");

export default function PolicyPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const p = usePolicy(id);
  const criteria = usePolicyCriteria(id);
  const [system, setSystem] = useState("HCPCS");
  const codes = usePolicyCodes(id, system);
  const [codeFilter, setCodeFilter] = useState("");
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  useEffect(() => {
    if (p.data) {
      setTo(p.data.version);
      setFrom(p.data.versions[1]?.version ?? p.data.version);
    }
  }, [p.data]);
  const diff = usePolicyDiff(id, from, to, !!p.data && from !== to);
  const filteredCodes = useMemo(() => (codes.data?.items ?? []).filter((c) => `${c.code} ${c.description}`.toLowerCase().includes(codeFilter.toLowerCase())), [codes.data, codeFilter]);

  if (p.isPending)
    return (
      <AppPage>
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="mt-4 h-96 rounded-xl" />
      </AppPage>
    );
  if (!p.data)
    return (
      <AppPage>
        <EmptyState art="search" title="Policy not found" action={<Button onClick={() => router.push("/policies")}>Back to library</Button>} />
      </AppPage>
    );

  const d = p.data;
  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Policy library", href: "/policies" }, { label: d.sourceKey }]} />} wide>
      <div className="flex flex-col gap-4 pb-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DocTypeBadge docType={d.docType} />
            <span className="font-mono text-sm font-medium text-fg">{d.sourceKey}</span>
            <Badge tone="outline" size="xs">
              v{d.version}
            </Badge>
            <Badge tone={d.status === "active" ? "met" : "info"} size="xs" dot>
              {titleCase(d.status)}
            </Badge>
          </div>
          <h1 className="mt-2 max-w-3xl text-[22px] font-semibold leading-tight tracking-[-0.02em] text-fg text-balance">{d.title}</h1>
          <p className="mt-2 text-[13px] text-muted">
            {d.contractors[0]?.name ?? "National coverage determination"} · effective {fmtDate(d.effectiveFrom)}
            {d.effectiveTo ? ` – ${fmtDate(d.effectiveTo)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => router.push(`/assistant?q=${encodeURIComponent(`Summarize the coverage indications and documentation requirements of ${d.sourceKey}`)}`)}>
            <Sparkles className="text-ai-2" /> Ask about this policy
          </Button>
          {d.url ? (
            <Button asChild variant="ghost">
              <a href={d.url} target="_blank" rel="noreferrer">
                CMS MCD <ExternalLink />
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      <Tabs defaultValue="sections">
        <TabsList className="mb-4">
          <TabsTrigger value="sections">
            <ScrollText /> Policy text
          </TabsTrigger>
          <TabsTrigger value="criteria">
            <ListChecks /> Criteria
          </TabsTrigger>
          <TabsTrigger value="versions" count={d.versions.length}>
            <GitCompare /> Versions
          </TabsTrigger>
          <TabsTrigger value="codes" count={d.codeCount || null}>
            <Hash /> Codes
          </TabsTrigger>
          <TabsTrigger value="coverage">
            <MapPin /> Jurisdiction & links
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sections">
          <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
            <nav className="hidden content-start gap-0.5 lg:sticky lg:top-20 lg:grid" aria-label="Sections">
              {d.sections.map((s) => (
                <a
                  key={s.id}
                  href={`#sec-${s.id}`}
                  onClick={() => setActiveSection(s.id)}
                  className={cn("rounded-md px-2.5 py-1.5 text-[13px] transition-colors", activeSection === s.id ? "bg-surface text-fg shadow-e1" : "text-muted hover:text-fg")}
                >
                  {s.title}
                </a>
              ))}
            </nav>
            <Card>
              <CardBody className="max-w-3xl pt-5">
                {d.sections.map((s) => (
                  <section key={s.id} id={`sec-${s.id}`} className="mb-8 scroll-mt-24">
                    <h2 className="text-[15px] font-semibold tracking-tight text-fg">{s.title}</h2>
                    <div className="mt-2 grid gap-3 text-[14px] leading-[1.75] text-fg">
                      {s.text.split("\n").map((para, i) => (
                        <p key={i}>{para}</p>
                      ))}
                    </div>
                  </section>
                ))}
                <p className="border-t border-border pt-4 text-xs text-subtle">Condensed for display. The authoritative text is the CMS Medicare Coverage Database version cited above.</p>
              </CardBody>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="criteria">
          {criteria.isPending ? (
            <Skeleton className="h-64 rounded-xl" />
          ) : criteria.data ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
              <Card>
                <CardHeader title="Compiled criteria" description="Atomic, checkable requirements — each grounded in a verbatim policy quote" />
                <CardBody>
                  <CriteriaTreeView node={criteria.data.tree} />
                </CardBody>
              </Card>
              <Card className="h-fit">
                <CardHeader title="Compilation" />
                <CardBody>
                  <DataList
                    items={[
                      { label: "Status", value: <Badge tone={criteria.data.status === "approved" ? "met" : "insufficient"}>{titleCase(criteria.data.status)}</Badge> },
                      { label: "Extractor", value: <span className="font-mono text-xs">{criteria.data.extractorModel}</span> },
                      { label: "Verifier", value: <span className="font-mono text-xs">{criteria.data.verifierModel}</span> },
                      { label: "Agreement", value: `${Math.round(criteria.data.agreement * 100)}%` },
                      { label: "Grounding", value: `${Math.round(criteria.data.groundingPassRate * 100)}% quotes verbatim` },
                      { label: "Reviewed", value: criteria.data.reviewedBy ? `${criteria.data.reviewedBy.fullName}, ${fmtDate(criteria.data.reviewedAt)}` : "Not yet" },
                    ]}
                  />
                  <Can perm="criteria:review">
                    <Button asChild variant="secondary" size="sm" className="mt-4 w-full">
                      <Link href={`/knowledge/criteria/${criteria.data.id}`}>
                        Open in review editor <ArrowRight />
                      </Link>
                    </Button>
                  </Can>
                </CardBody>
              </Card>
            </div>
          ) : (
            <Card>
              <EmptyState art="spark" title="Criteria not compiled yet" description="An admin can compile this policy version from Knowledge ops. Compilation runs quota-paced on the long-context model group and is verified by a second model family." />
            </Card>
          )}
        </TabsContent>

        <TabsContent value="versions">
          <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            <Card className="h-fit">
              <CardHeader title="Version history" />
              <CardBody className="grid gap-2">
                {d.versions.map((v) => (
                  <div key={v.id} className="rounded-lg border border-border p-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-medium text-fg">v{v.version}</span>
                      {v.version === d.version ? <Badge tone="met" size="xs">current</Badge> : null}
                      <span className="ml-auto text-xs text-subtle">{fmtDate(v.effectiveFrom)}</span>
                    </div>
                    {v.summary ? <p className="mt-1 text-xs text-muted">{v.summary}</p> : null}
                  </div>
                ))}
              </CardBody>
            </Card>
            <Card>
              <CardHeader
                title="Compare versions"
                description="Section-aligned diff — exactly what changed between the versions you select"
                actions={
                  <div className="flex items-center gap-2">
                    <Select size="sm" className="w-24" value={String(from)} onValueChange={(v) => setFrom(Number(v))} options={d.versions.map((v) => ({ value: String(v.version), label: `v${v.version}` }))} aria-label="From version" />
                    <ArrowRight className="size-3.5 text-subtle" />
                    <Select size="sm" className="w-24" value={String(to)} onValueChange={(v) => setTo(Number(v))} options={d.versions.map((v) => ({ value: String(v.version), label: `v${v.version}` }))} aria-label="To version" />
                  </div>
                }
              />
              <CardBody className="grid gap-5">
                {from === to ? (
                  <p className="text-[13px] text-muted">Pick two different versions to compare.</p>
                ) : diff.isPending ? (
                  <Skeleton className="h-48" />
                ) : (
                  diff.data?.sections.map((s) => (
                    <div key={s.sectionKey} className="grid gap-1.5">
                      <div className="flex items-center gap-2">
                        <h3 className="text-[13px] font-semibold">{s.title}</h3>
                        <Badge tone={s.status === "changed" ? "insufficient" : s.status === "added" ? "met" : s.status === "removed" ? "notmet" : "neutral"} size="xs">
                          {s.status}
                        </Badge>
                      </div>
                      {s.status === "same" ? <p className="line-clamp-2 text-[13px] text-subtle">{s.hunks[0]?.text}</p> : <DiffViewer hunks={s.hunks} />}
                    </div>
                  ))
                )}
              </CardBody>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="codes">
          <Card>
            <CardHeader
              title="Code groups"
              description="Procedure codes and ICD-10-CM groups from the related Billing & Coding article"
              actions={
                <Segmented
                  size="xs"
                  value={system}
                  onValueChange={setSystem}
                  options={[
                    { value: "HCPCS", label: "HCPCS / procedure" },
                    { value: "ICD10_COVERED", label: "ICD-10 covered" },
                    { value: "ICD10_NONCOVERED", label: "Non-covered" },
                  ]}
                />
              }
            />
            <CardBody className="grid gap-3">
              <Input placeholder="Filter codes" value={codeFilter} onChange={(e) => setCodeFilter(e.target.value)} className="h-8 max-w-xs" />
              {codes.isPending ? (
                <Skeleton className="h-40" />
              ) : filteredCodes.length === 0 ? (
                <EmptyState compact art="search" title="No codes in this group" description="Coverage criteria live in the LCD; code lists live in the linked article." />
              ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full text-[13px]">
                    <thead className="bg-surface-2 text-xs text-muted">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Code</th>
                        <th className="px-3 py-2 text-left font-medium">Description</th>
                        <th className="px-3 py-2 text-left font-medium">Group</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCodes.map((c) => (
                        <tr key={`${c.codeSystem}-${c.code}`} className="border-t border-border/70">
                          <td className="px-3 py-2">
                            <Link href={`/codes?code=${c.code}&system=${c.codeSystem === "HCPCS" ? "HCPCS" : "ICD10CM"}`} className="font-mono text-xs font-medium text-brand hover:underline">
                              {c.code}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-fg">{c.description}</td>
                          <td className="px-3 py-2 text-muted">Group {c.groupNo}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-[11px] text-subtle">Procedure descriptions are Necessa-authored summaries; CPT® descriptors are licensed content and are not displayed.</p>
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="coverage">
          <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
            <Card>
              <CardHeader title="Jurisdiction" description={d.contractors[0] ? `${d.contractors[0].name} · ${d.states.length} states` : "National — applies in every state"} icon={<MapPin />} />
              <CardBody>
                <div className="grid grid-cols-8 gap-1 sm:grid-cols-11">
                  {US.map((s) => {
                    const on = d.docType === "NCD" || d.states.includes(s);
                    return (
                      <span key={s} className={cn("flex h-8 items-center justify-center rounded-md font-mono text-[11px]", on ? "bg-brand text-brand-contrast" : "bg-surface-2 text-subtle")}>
                        {s}
                      </span>
                    );
                  })}
                </div>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Linked documents" icon={<Link2 />} />
              <CardBody className="grid gap-2">
                {d.linked.length === 0 ? <p className="text-[13px] text-muted">No linked documents.</p> : null}
                {d.linked.map((l) => (
                  <Link key={l.policyId} href={`/policies/${l.policyId}`} className="group flex items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:border-border-strong">
                    <DocTypeBadge docType={l.docType} />
                    <span className="grid min-w-0">
                      <span className="font-mono text-xs font-medium text-fg">{l.sourceKey}</span>
                      <span className="line-clamp-2 text-[13px] text-muted">{l.title}</span>
                    </span>
                    <ArrowRight className="ml-auto mt-1 size-3.5 shrink-0 text-subtle group-hover:text-fg" />
                  </Link>
                ))}
                {d.hasCriteria ? (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-met-fg">
                    <BadgeCheck className="size-3.5" /> Criteria compiled for the current version
                  </p>
                ) : null}
              </CardBody>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </AppPage>
  );
}
