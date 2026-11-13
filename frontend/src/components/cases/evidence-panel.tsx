"use client";

import { FileText, ScrollText, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useCaseDocument, useCaseDocuments, usePolicy } from "@/lib/api/hooks";
import type { Evaluation } from "@/lib/api/types";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge, Card, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { SplitPane } from "@/components/ui/widgets";
import { HighlightedText, VerdictIcon, type HighlightSpan } from "@/components/domain/verdict";

function findSpan(text: string, quote: string, start?: number | null, end?: number | null) {
  if (start != null && end != null && text.slice(start, end) === quote) return [start, end] as const;
  const i = text.indexOf(quote);
  if (i >= 0) return [i, i + quote.length] as const;
  const low = text.toLowerCase().indexOf(quote.toLowerCase());
  return low >= 0 ? ([low, low + quote.length] as const) : null;
}

export function EvidencePanel({ caseId, evaluation, criterionId, onCriterion }: { caseId: string; evaluation?: Evaluation; criterionId: string | null; onCriterion: (id: string) => void }) {
  const docs = useCaseDocuments(caseId);
  const policyId = evaluation?.policies[0]?.policyId ?? "";
  const policy = usePolicy(policyId);
  const active = evaluation?.criteria.find((c) => c.criterionId === criterionId) ?? evaluation?.criteria[0];

  const docOrder = useMemo(() => {
    const list = docs.data ?? [];
    const withEvidence = new Set(evaluation?.criteria.flatMap((c) => c.evidence.map((e) => e.documentId)) ?? []);
    return [...list].sort((a, b) => Number(withEvidence.has(b.id)) - Number(withEvidence.has(a.id)));
  }, [docs.data, evaluation]);

  const [docId, setDocId] = useState<string | null>(null);
  useEffect(() => {
    const target = active?.evidence[0]?.documentId;
    if (target) setDocId(target);
    else if (!docId && docOrder[0]) setDocId(docOrder[0].id);
  }, [active, docOrder, docId]);
  const doc = useCaseDocument(caseId, docId);

  if (!evaluation) return <Card><EmptyState art="documents" title="Run an evaluation to map evidence" description="Once criteria are checked, every quote is highlighted in the policy and in the chart side by side." /></Card>;

  const docSpans: HighlightSpan[] = [];
  if (doc.data?.text) {
    for (const c of evaluation.criteria) {
      for (const e of c.evidence.filter((x) => x.documentId === doc.data!.id)) {
        const s = findSpan(doc.data.text, e.quote, e.charStart, e.charEnd);
        if (s) docSpans.push({ start: s[0], end: s[1], id: c.criterionId, tone: "evidence", label: `${c.criterionId} · ${c.text}` });
      }
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Criteria">
        {evaluation.criteria.map((c) => (
          <button
            key={c.criterionId}
            role="tab"
            aria-selected={active?.criterionId === c.criterionId}
            onClick={() => onCriterion(c.criterionId)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] transition-colors",
              active?.criterionId === c.criterionId ? "border-brand bg-brand-soft/50 text-fg shadow-[0_0_0_1px_var(--brand)]" : "border-border bg-surface text-muted hover:text-fg",
            )}
            title={c.text}
          >
            <VerdictIcon verdict={c.effectiveVerdict} className="size-3.5" />
            <span className="font-mono text-xs">{c.criterionId}</span>
          </button>
        ))}
      </div>
      {active ? (
        <p className="rounded-lg bg-surface px-3 py-2 text-[13px] shadow-e1">
          <span className="font-mono text-xs text-subtle">{active.criterionId}</span> <span className="text-fg">{active.text}</span>
          <span className="ml-2 text-xs text-muted">{active.evidence.length ? `${active.evidence.length} evidence span${active.evidence.length > 1 ? "s" : ""}` : "no evidence found"}</span>
        </p>
      ) : null}
      <SplitPane
        className="min-h-[560px] gap-3 lg:gap-0"
        initial={0.46}
        left={
          <Card className="flex h-full max-h-[70vh] flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <ScrollText className="size-4 text-brand" />
              <span className="text-[13px] font-medium">{evaluation.policies[0]?.sourceKey}</span>
              <span className="truncate text-xs text-muted">{evaluation.policies[0]?.title}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scrollbar-thin">
              {policy.isPending ? (
                <Skeleton className="h-64" />
              ) : (
                (policy.data?.sections ?? []).map((s) => {
                  const spans: HighlightSpan[] = [];
                  for (const c of evaluation.criteria) {
                    if (c.policyCitation.sectionKey !== s.sectionKey || !c.policyCitation.quote) continue;
                    const span = findSpan(s.text, c.policyCitation.quote);
                    if (span) spans.push({ start: span[0], end: span[1], id: c.criterionId, tone: "policy", label: c.criterionId });
                  }
                  return (
                    <section key={s.id} className="mb-5">
                      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{s.title}</h4>
                      <HighlightedText text={s.text} spans={spans} activeId={active?.policyCitation.sectionKey === s.sectionKey ? active.criterionId : null} onSpanClick={onCriterion} />
                    </section>
                  );
                })
              )}
            </div>
          </Card>
        }
        right={
          <Card className="flex h-full max-h-[70vh] flex-col overflow-hidden">
            <div className="flex gap-1 overflow-x-auto border-b border-border px-2 pt-2 scrollbar-thin">
              {docOrder.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setDocId(d.id)}
                  className={cn("flex shrink-0 items-center gap-1.5 rounded-t-md px-2.5 py-2 text-xs", d.id === docId ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg")}
                >
                  {d.quarantined ? <ShieldAlert className="size-3.5 text-notmet" /> : <FileText className="size-3.5" />}
                  <span className="max-w-[160px] truncate">{d.filename}</span>
                  {evaluation.criteria.some((c) => c.evidence.some((e) => e.documentId === d.id)) ? <span className="size-1.5 rounded-full bg-met" /> : null}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-surface-2/40 px-4 py-4 scrollbar-thin">
              {doc.isPending ? (
                <Skeleton className="h-64" />
              ) : doc.data ? (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge size="xs">{doc.data.kind.replace(/_/g, " ")}</Badge>
                    {doc.data.noteDate ? <span>Note date {fmtDate(doc.data.noteDate)}</span> : null}
                    <span>· de-identified view</span>
                    {doc.data.quarantined ? <Badge tone="notmet" size="xs">Quarantined — excluded from evidence</Badge> : null}
                  </div>
                  <HighlightedText text={doc.data.text ?? ""} spans={docSpans} activeId={active?.criterionId} onSpanClick={onCriterion} className="font-[450]" />
                </>
              ) : (
                <EmptyState compact art="documents" title="No documents attached" />
              )}
            </div>
          </Card>
        }
      />
    </div>
  );
}
