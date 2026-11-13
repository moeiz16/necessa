"use client";

import { ChevronLeft, ChevronRight, FileText, Quote, ScrollText, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useCaseDocument, useCaseDocuments, usePolicy } from "@/lib/api/hooks";
import type { Evaluation } from "@/lib/api/types";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge, Card, Kbd, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { SplitPane } from "@/components/ui/widgets";
import { Provenance } from "@/components/domain/trust";
import { HighlightedText, VerdictBadge, VerdictIcon, type HighlightSpan } from "@/components/domain/verdict";

function findSpan(text: string, quote: string, start?: number | null, end?: number | null) {
  if (start != null && end != null && text.slice(start, end) === quote) return [start, end] as const;
  const i = text.indexOf(quote);
  if (i >= 0) return [i, i + quote.length] as const;
  const low = text.toLowerCase().indexOf(quote.toLowerCase());
  return low >= 0 ? ([low, low + quote.length] as const) : null;
}

const shortId = (id: string) => id.split(":").pop() ?? id;

export function EvidencePanel({ caseId, evaluation, criterionId, onCriterion }: { caseId: string; evaluation?: Evaluation; criterionId: string | null; onCriterion: (id: string) => void }) {
  const docs = useCaseDocuments(caseId);
  const policyId = evaluation?.policies[0]?.policyId ?? "";
  const policy = usePolicy(policyId);
  const criteria = useMemo(() => evaluation?.criteria ?? [], [evaluation]);
  const activeIndex = Math.max(
    0,
    criteria.findIndex((c) => c.criterionId === criterionId),
  );
  const active = criteria[activeIndex];

  const docOrder = useMemo(() => {
    const list = docs.data ?? [];
    const withEvidence = new Set(criteria.flatMap((c) => c.evidence.map((e) => e.documentId)));
    return [...list].sort((a, b) => Number(withEvidence.has(b.id)) - Number(withEvidence.has(a.id)));
  }, [docs.data, criteria]);

  const [docId, setDocId] = useState<string | null>(null);
  useEffect(() => {
    const target = active?.evidence[0]?.documentId;
    if (target) setDocId(target);
    else if (!docId && docOrder[0]) setDocId(docOrder[0].id);
  }, [active, docOrder, docId]);
  const doc = useCaseDocument(caseId, docId);

  const step = useCallback(
    (d: number) => {
      if (!criteria.length) return;
      const next = criteria[(activeIndex + d + criteria.length) % criteria.length]!;
      onCriterion(next.criterionId);
    },
    [criteria, activeIndex, onCriterion],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.key === "]") step(1);
      if (e.key === "[") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  if (!evaluation) return <Card><EmptyState art="documents" title="Run an evaluation to map evidence" description="Once criteria are checked, every quote is highlighted in the policy and in the chart, side by side." /></Card>;
  if (!criteria.length) return <Card><EmptyState art="documents" title="No criteria to map" description="This evaluation had no approved criteria for the applicable policy, so there's no evidence to show yet." /></Card>;

  const docSpans: HighlightSpan[] = [];
  if (doc.data?.text) {
    for (const c of criteria) {
      for (const e of c.evidence.filter((x) => x.documentId === doc.data!.id)) {
        const s = findSpan(doc.data.text, e.quote, e.charStart, e.charEnd);
        if (s) docSpans.push({ start: s[0], end: s[1], id: c.criterionId, tone: "evidence", label: `${shortId(c.criterionId)} · ${c.text}` });
      }
    }
  }
  const activeDocCount = (id: string) => active?.evidence.filter((e) => e.documentId === id).length ?? 0;

  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5" role="tablist" aria-label="Criteria">
          {criteria.map((c) => (
            <button
              key={c.criterionId}
              role="tab"
              aria-selected={active?.criterionId === c.criterionId}
              onClick={() => onCriterion(c.criterionId)}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[13px] outline-none transition-[border-color,background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-brand/30",
                active?.criterionId === c.criterionId ? "border-brand bg-brand-soft/50 text-fg shadow-[0_0_0_1px_var(--brand)]" : "border-border bg-surface text-muted hover:text-fg",
              )}
              title={c.text}
            >
              <VerdictIcon verdict={c.effectiveVerdict} className="size-3.5" />
              <span className="font-mono text-xs">{shortId(c.criterionId)}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs text-subtle">
          <Button size="icon-sm" variant="ghost" aria-label="Previous criterion" onClick={() => step(-1)}>
            <ChevronLeft />
          </Button>
          <span className="tabular">
            {activeIndex + 1} / {criteria.length}
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="Next criterion" onClick={() => step(1)}>
            <ChevronRight />
          </Button>
          <span className="hidden items-center gap-1 lg:inline-flex">
            <Kbd>[</Kbd>
            <Kbd>]</Kbd>
          </span>
        </div>
      </div>

      {active ? (
        <Card className="grid gap-3 p-3 md:grid-cols-2">
          <div className="grid content-start gap-1.5">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              <ScrollText className="size-3.5 text-brand" /> Policy requires
            </p>
            <p className="text-[13px] leading-relaxed text-fg">
              <span className="font-mono text-xs text-subtle">{shortId(active.criterionId)}</span> {active.text}
            </p>
            {active.policyCitation.quote ? (
              <p className="rounded-md border-l-2 border-brand bg-brand-soft/30 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-fg">“{active.policyCitation.quote}”</p>
            ) : null}
          </div>
          <div className="grid content-start gap-1.5">
            <p className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">
              <span className="flex items-center gap-2">
                <Quote className="size-3.5 text-met" /> Chart shows
              </span>
              <VerdictBadge verdict={active.effectiveVerdict} overridden={!!active.override} size="xs" short />
            </p>
            {active.evidence.length ? (
              active.evidence.slice(0, 2).map((e) => (
                <div key={e.chunkId} className="grid gap-0.5">
                  <p className="rounded-md bg-met-soft/40 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-fg">“{e.quote}”</p>
                  <Provenance source={docs.data?.find((d) => d.id === e.documentId)?.filename ?? "chart"} detail={e.noteDate ? fmtDate(e.noteDate) : undefined} verified={active.verification.quoteValid} />
                </div>
              ))
            ) : (
              <p className="rounded-md border border-dashed border-border-strong px-2.5 py-2 text-[12.5px] text-muted">
                No passage in the chart addresses this criterion{active.kind === "negative_attestation" ? " — an explicit attestation is required" : ""}.
              </p>
            )}
          </div>
        </Card>
      ) : null}

      <SplitPane
        className="min-h-[560px] gap-3 lg:gap-0"
        initial={0.46}
        left={
          <Card className="flex h-full max-h-[70vh] min-h-[420px] flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <ScrollText className="size-4 shrink-0 text-brand" />
              <span className="text-[13px] font-medium">{evaluation.policies[0]?.sourceKey}</span>
              <span className="min-w-0 truncate text-xs text-muted">{evaluation.policies[0]?.title}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 scrollbar-thin">
              {policy.isPending && policyId ? (
                <Skeleton className="h-64" />
              ) : (policy.data?.sections ?? []).length ? (
                (policy.data?.sections ?? []).map((s) => {
                  const spans: HighlightSpan[] = [];
                  for (const c of criteria) {
                    if (c.policyCitation.sectionKey !== s.sectionKey || !c.policyCitation.quote) continue;
                    const span = findSpan(s.text, c.policyCitation.quote);
                    if (span) spans.push({ start: span[0], end: span[1], id: c.criterionId, tone: "policy", label: shortId(c.criterionId) });
                  }
                  return (
                    <section key={s.id} className="mb-5">
                      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{s.title}</h4>
                      <HighlightedText text={s.text} spans={spans} activeId={active?.policyCitation.sectionKey === s.sectionKey ? active.criterionId : null} onSpanClick={onCriterion} />
                    </section>
                  );
                })
              ) : (
                <p className="text-[13px] text-muted">Policy text isn&apos;t available in this workspace. Criterion quotes above are verified against the ingested policy.</p>
              )}
            </div>
          </Card>
        }
        right={
          <Card className="flex h-full max-h-[70vh] min-h-[420px] flex-col overflow-hidden">
            <div className="flex gap-1 overflow-x-auto border-b border-border px-2 pt-2 scrollbar-thin" role="tablist" aria-label="Chart documents">
              {docOrder.map((d) => {
                const n = activeDocCount(d.id);
                return (
                  <button
                    key={d.id}
                    role="tab"
                    aria-selected={d.id === docId}
                    onClick={() => setDocId(d.id)}
                    className={cn("flex shrink-0 items-center gap-1.5 rounded-t-md px-2.5 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-brand/30", d.id === docId ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg")}
                  >
                    {d.quarantined ? <ShieldAlert className="size-3.5 text-notmet" /> : <FileText className="size-3.5" />}
                    <span className="max-w-[160px] truncate">{d.filename}</span>
                    {n ? (
                      <span className="tabular rounded-full bg-met-soft px-1.5 text-[10px] font-semibold text-met-fg" title={`${n} passage${n > 1 ? "s" : ""} for the selected criterion`}>
                        {n}
                      </span>
                    ) : criteria.some((c) => c.evidence.some((e) => e.documentId === d.id)) ? (
                      <span className="size-1.5 rounded-full bg-met/60" />
                    ) : null}
                  </button>
                );
              })}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-surface-2/40 px-4 py-4 scrollbar-thin">
              {doc.isPending && docId ? (
                <Skeleton className="h-64" />
              ) : doc.data ? (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <Badge size="xs">{doc.data.kind.replace(/_/g, " ")}</Badge>
                    {doc.data.noteDate ? <span>Note date {fmtDate(doc.data.noteDate)}</span> : null}
                    <span>· de-identified view</span>
                    {doc.data.quarantined ? (
                      <Badge tone="notmet" size="xs">
                        Quarantined — excluded from evidence
                      </Badge>
                    ) : null}
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
