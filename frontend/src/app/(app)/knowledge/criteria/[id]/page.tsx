"use client";

import { BadgeCheck, CircleCheck, CircleX, Layers, Plus, Trash2, XCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useCriteriaSet, usePolicy, useUpdateCriteriaSet } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import type { CriteriaNode } from "@/lib/api/types";
import { fmtDate, fmtPct, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { quoteFound } from "@/components/policies/criteria-tree";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, CardBody, CardHeader, DataList, Skeleton } from "@/components/ui/display";
import { Input, Textarea } from "@/components/ui/input";

type Path = number[];

function updateAt(n: CriteriaNode, p: Path, fn: (x: CriteriaNode) => CriteriaNode | null): CriteriaNode {
  if (!p.length) return fn(n) ?? n;
  const [h, ...rest] = p;
  const children = [...(n.children ?? [])];
  if (!rest.length) {
    const next = fn(children[h!]!);
    if (next === null) children.splice(h!, 1);
    else children[h!] = next;
  } else children[h!] = updateAt(children[h!]!, rest, fn);
  return { ...n, children };
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "must", "from", "are", "has", "have", "been", "per", "any", "all", "of", "to", "a", "an", "or", "in", "on", "be", "is", "by"]);
const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

/** Suggests the sentence in this policy that shares the most words with a quote that no longer matches
 *  (for example, a different issuer's wording). The reviewer decides. */
function closestPassage(quote: string, text: string): { text: string; score: number; section?: string } | null {
  const q = new Set(words(quote));
  if (!q.size) return null;
  let best: { text: string; score: number } | null = null;
  for (const raw of text.split(/\n+|(?<=\.)\s+(?=[A-Z0-9])/)) {
    const cand = raw.replace(/^\s*\d+\.\s*/, "").trim();
    if (cand.length < 12) continue;
    const c = new Set(words(cand));
    const inter = [...q].filter((w) => c.has(w)).length;
    const score = inter / new Set([...q, ...c]).size;
    if (!best || score > best.score) best = { text: cand, score };
  }
  return best && best.score >= 0.3 ? best : null;
}

function nextId(tree: CriteriaNode) {
  const ids: number[] = [];
  const walk = (n: CriteriaNode) => {
    if (n.id) ids.push(Number(n.id.replace(/\D/g, "")) || 0);
    n.children?.forEach(walk);
  };
  walk(tree);
  return `C${Math.max(0, ...ids) + 1}`;
}

function Editor({ node, path, sections, onChange, selected, onSelect }: { node: CriteriaNode; path: Path; sections: Record<string, string>; onChange: (p: Path, fn: (x: CriteriaNode) => CriteriaNode | null) => void; selected: string | null; onSelect: (id: string | null) => void }) {
  if (node.children) {
    return (
      <div className={cn("grid gap-2", path.length > 0 && "rounded-lg border border-dashed border-border-strong bg-surface-2/30 p-2.5")}>
        <div className="flex items-center gap-2">
          <Layers className="size-3.5 text-subtle" />
          <Select
            size="sm"
            className="w-48"
            value={node.op ?? "AND"}
            onValueChange={(v) => onChange(path, (x) => ({ ...x, op: v as CriteriaNode["op"], n: v === "N_OF_M" ? x.n ?? 1 : undefined }))}
            options={[
              { value: "AND", label: "All of the following" },
              { value: "OR", label: "Any one of" },
              { value: "N_OF_M", label: "At least N of" },
            ]}
            aria-label="Group operator"
          />
          {node.op === "N_OF_M" ? <Input type="number" min={1} className="h-8 w-16" value={node.n ?? 1} onChange={(e) => onChange(path, (x) => ({ ...x, n: Number(e.target.value) }))} aria-label="N" /> : null}
        </div>
        {node.children.map((c, i) => (
          <Editor key={c.id ?? `g${i}`} node={c} path={[...path, i]} sections={sections} onChange={onChange} selected={selected} onSelect={onSelect} />
        ))}
      </div>
    );
  }
  const sectionText = sections[node.sourceSpan?.section ?? ""] ?? "";
  const quote = node.sourceSpan?.quote ?? "";
  const grounded = !!quote && quoteFound(quote, sectionText);
  const suggestion = !grounded && quote.length > 12 ? closestPassage(quote, Object.values(sections).join("\n")) : null;
  return (
    <div className={cn("grid gap-2 rounded-lg border bg-surface p-3", selected === node.id ? "border-brand shadow-[0_0_0_1px_var(--brand)]" : "border-border")} onFocus={() => onSelect(node.id ?? null)}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-subtle">{node.id}</span>
        <Input value={node.text ?? ""} onChange={(e) => onChange(path, (x) => ({ ...x, text: e.target.value }))} className="h-8" aria-label="Requirement text" />
        <Button variant="ghost" size="icon-sm" aria-label="Remove requirement" onClick={() => onChange(path, () => null)}>
          <Trash2 />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm"
          className="w-40"
          value={node.kind ?? "positive"}
          onValueChange={(v) => onChange(path, (x) => ({ ...x, kind: v as CriteriaNode["kind"] }))}
          aria-label="Type"
          options={[
            { value: "positive", label: "Clinical" },
            { value: "documentation", label: "Documentation" },
            { value: "temporal", label: "Duration" },
            { value: "numeric", label: "Measure" },
            { value: "negative_attestation", label: "Must be confirmed" },
          ]}
        />
        <Select
          size="sm"
          className="w-48"
          value={node.sourceSpan?.section ?? "indication"}
          onValueChange={(v) => onChange(path, (x) => ({ ...x, sourceSpan: { section: v, quote: x.sourceSpan?.quote ?? "" } }))}
          aria-label="Policy section"
          options={Object.keys(sections).map((k) => ({ value: k, label: titleCase(k) }))}
        />
        {node.kind === "temporal" ? <Input type="number" className="h-8 w-28" value={node.lookbackDays ?? ""} placeholder="within days" onChange={(e) => onChange(path, (x) => ({ ...x, lookbackDays: Number(e.target.value) || null }))} aria-label="Within days" /> : null}
      </div>
      <div className="grid gap-1">
        <Textarea value={node.sourceSpan?.quote ?? ""} onChange={(e) => onChange(path, (x) => ({ ...x, sourceSpan: { section: x.sourceSpan?.section ?? "indication", quote: e.target.value } }))} className="min-h-14 text-[12.5px]" aria-label="Quote from the policy" />
        <p className={cn("flex items-center gap-1 text-xs", grounded ? "text-met-fg" : "text-notmet-fg")}>
          {grounded ? <CircleCheck className="size-3.5" /> : <CircleX className="size-3.5" />}
          {grounded ? "Quote matches the policy text" : "This quote doesn't match the policy text. Fix it before approving."}
        </p>
        {suggestion ? (
          <div className="mt-1 grid gap-1.5 rounded-lg border border-dashed border-border-strong bg-surface-2/50 p-2.5">
            <p className="text-[11px] font-medium text-muted">Closest wording in this policy ({Math.round(suggestion.score * 100)}% similar)</p>
            <p className="text-[12.5px] leading-relaxed text-fg">“{suggestion.text}”</p>
            <div>
              <Button
                size="xs"
                variant="secondary"
                onClick={() => onChange(path, (x) => ({ ...x, sourceSpan: { section: suggestion.section ?? x.sourceSpan?.section ?? "indication", quote: suggestion.text } }))}
              >
                Use this quote
              </Button>
              <span className="ml-2 text-[11px] text-subtle">Check that the meaning still fits the requirement before approving.</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function CriteriaEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can } = useSession();
  const set = useCriteriaSet(id);
  // The policy endpoint accepts the CMS source key, so this works against both the API and demo mode.
  const policyId = set.data?.sourceKey ?? "";
  const policy = usePolicy(policyId);
  const save = useUpdateCriteriaSet(id);
  const [tree, setTree] = useState<CriteriaNode | null>(null);
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (set.data) {
      setTree(structuredClone(set.data.tree));
      setNotes(set.data.notes ?? "");
    }
  }, [set.data]);

  const sections = useMemo(() => Object.fromEntries((policy.data?.sections ?? []).map((s) => [s.sectionKey, s.text])), [policy.data]);
  const leaves = useMemo(() => {
    const out: CriteriaNode[] = [];
    const walk = (n: CriteriaNode) => (n.children ? n.children.forEach(walk) : out.push(n));
    if (tree) walk(tree);
    return out;
  }, [tree]);
  const ungrounded = leaves.filter((l) => !(l.sourceSpan?.quote && quoteFound(l.sourceSpan.quote, sections[l.sourceSpan.section] ?? ""))).length;
  const selectedLeaf = leaves.find((l) => l.id === selected);

  if (set.isPending || !tree)
    return (
      <AppPage>
        <Skeleton className="h-96 rounded-xl" />
      </AppPage>
    );
  const s = set.data!;
  const change = (p: Path, fn: (x: CriteriaNode) => CriteriaNode | null) => setTree((t) => (t ? updateAt(t, p, fn) : t));
  const canEdit = can("criteria:review");

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Policy updates", href: "/knowledge?tab=review" }, { label: `${s.sourceKey} requirements` }]} />} wide>
      <div className="flex flex-col gap-3 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Badge tone={s.status === "approved" ? "met" : "insufficient"} dot>
              {titleCase(s.status)}
            </Badge>
            <span className="font-mono text-xs text-subtle">
              {s.sourceKey} v{s.version}
            </span>
          </div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.02em]">{s.policyTitle}</h1>
        </div>
        {canEdit ? (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => save.mutate({ tree, notes }, { onSuccess: () => toast.success("Draft saved") })} loading={save.isPending}>
              Save draft
            </Button>
            <Button variant="secondary" onClick={() => save.mutate({ status: "rejected", notes }, { onSuccess: () => (toast.success("Checklist rejected"), router.push("/knowledge?tab=review")) })}>
              <XCircle /> Reject
            </Button>
            <Button variant="primary" disabled={ungrounded > 0} onClick={() => save.mutate({ tree, notes, status: "approved" }, { onSuccess: () => (toast.success("Checklist approved", { description: "New case checks will use it." }), router.push("/knowledge?tab=review")) })}>
              <BadgeCheck /> Approve
            </Button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          {ungrounded ? (
            <p className="rounded-lg bg-notmet-soft px-3 py-2 text-[13px] text-notmet-fg">
              {ungrounded} {ungrounded > 1 ? "requirements don't" : "requirement doesn't"} match the policy text. Approval is blocked until every quote does.
            </p>
          ) : (
            <p className="rounded-lg bg-met-soft px-3 py-2 text-[13px] text-met-fg">All {leaves.length} requirements match the policy text.</p>
          )}
          <Editor node={tree} path={[]} sections={sections} onChange={change} selected={selected} onSelect={setSelected} />
          {canEdit ? (
            <Button
              variant="ghost"
              size="sm"
              className="w-fit"
              onClick={() => setTree((t) => (t ? { ...t, children: [...(t.children ?? []), { id: nextId(t), text: "New requirement", kind: "documentation", sourceSpan: { section: "indication", quote: "" } }] } : t))}
            >
              <Plus /> Add requirement
            </Button>
          ) : null}
        </div>
        <div className="grid content-start gap-4 xl:sticky xl:top-20">
          <Card>
            <CardHeader title="How this checklist was prepared" />
            <CardBody>
              <DataList
                items={[
                  { label: "Prepared by", value: s.extractorModel?.startsWith("transfer:") ? `Imported from ${s.extractorModel.slice(9)}` : s.extractorModel === "curated" ? "Clinical content team" : "Prepared automatically" },
                  { label: "Quotes matching the policy", value: fmtPct(s.groundingPassRate) },
                  { label: "Prepared on", value: fmtDate(s.createdAt) },
                ]}
              />
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reviewer notes" className="mt-4 min-h-20" />
            </CardBody>
          </Card>
          <Card className="max-h-[60vh] overflow-hidden">
            <CardHeader title="Policy text" description={selectedLeaf ? `Showing ${selectedLeaf.sourceSpan?.section?.replace(/_/g, " ")} for ${selectedLeaf.id}` : "Select a requirement to see where it comes from"} />
            <CardBody className="max-h-[48vh] overflow-y-auto scrollbar-thin">
              {(policy.data?.sections ?? [])
                .filter((sec) => !selectedLeaf || sec.sectionKey === selectedLeaf.sourceSpan?.section)
                .map((sec) => {
                  const q = selectedLeaf?.sourceSpan?.quote ?? "";
                  const i = q ? sec.text.toLowerCase().indexOf(q.toLowerCase()) : -1;
                  return (
                    <section key={sec.id} className="mb-4">
                      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-subtle">{sec.title}</h4>
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
                        {i >= 0 ? (
                          <>
                            {sec.text.slice(0, i)}
                            <mark className="mark-policy mark-active">{sec.text.slice(i, i + q.length)}</mark>
                            {sec.text.slice(i + q.length)}
                          </>
                        ) : (
                          sec.text
                        )}
                      </p>
                    </section>
                  );
                })}
            </CardBody>
          </Card>
        </div>
      </div>
    </AppPage>
  );
}
