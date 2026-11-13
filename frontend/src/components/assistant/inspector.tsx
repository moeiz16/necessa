"use client";

/** The policy sources behind an answer: which policy, which section, and the passage it relied on. */
import { ArrowUpRight, BookOpen, CircleSlash } from "lucide-react";
import Link from "next/link";
import type { Citation, RetrievalChunk, RouteTrace } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty";

type Chunk = RetrievalChunk & { snippet?: string; sectionTitle?: string | null };

type Source = { key: string; title: string; version?: number; section: string; quote?: string };

const SECTION_NAMES: Record<string, string> = {
  indication: "Covered indications",
  doc_reqs: "Documentation requirements",
  coding_guidelines: "Coding guidelines",
  dx_support: "Diagnoses that support coverage",
  dx_nonsupport: "Diagnoses that don't support coverage",
  limitations: "Limitations",
  description: "Description",
  cms_cov_policy: "Coverage policy",
  util_guide: "Utilization guidance",
  summary_of_evidence: "Summary of evidence",
  analysis_of_evidence: "Analysis of evidence",
  associated_info: "Related information",
  revision_history: "What changed",
};

function sectionName(key: string, title?: string | null) {
  const raw = SECTION_NAMES[key] ?? title ?? key.replace(/_/g, " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Cited passages first (what the answer actually used); otherwise the top retrieved passages. */
function toSources(chunks: Chunk[] | undefined, citations: Citation[] | undefined): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  const push = (s: Source) => {
    const id = `${s.key}|${s.section}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(s);
  };
  for (const c of citations ?? []) push({ key: c.sourceKey, title: c.title, version: c.version, section: sectionName(c.sectionKey), quote: c.quote });
  if (!out.length) for (const c of (chunks ?? []).slice(0, 5)) push({ key: c.sourceKey, title: c.title, version: c.version, section: sectionName(c.sectionKey, c.sectionTitle), quote: c.snippet ?? c.text });
  return out;
}

export function SourcesPanel({ route, chunks, citations, hasAnswer }: { route?: RouteTrace | null; chunks?: RetrievalChunk[]; citations?: Citation[]; hasAnswer: boolean }) {
  if (!hasAnswer) return <EmptyState compact art="documents" title="No sources yet" description="The policies behind each answer will appear here." />;
  const sources = toSources(chunks as Chunk[] | undefined, citations);
  const unsure = route?.abstained || sources.length === 0;
  if (unsure)
    return (
      <div className="flex items-start gap-2.5 rounded-md bg-surface-2 p-3 text-[13px] text-muted">
        <CircleSlash className="mt-0.5 size-4 shrink-0" />
        <p>Not enough information in your policies to answer this with confidence. Try naming the service, code or payer.</p>
      </div>
    );
  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted">
        Based on {sources.length} policy source{sources.length === 1 ? "" : "s"}
      </p>
      <ol className="grid gap-2.5">
        {sources.map((s, i) => (
          <li key={`${s.key}-${s.section}`} className={cn("grid gap-1.5 rounded-md border border-border bg-surface p-3")}>
            <div className="flex items-start gap-2">
              <span className="tabular mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10px] font-semibold text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium leading-snug text-fg">{s.title}</p>
                <p className="mt-0.5 text-xs text-subtle">
                  {s.key}
                  {s.version ? ` · version ${s.version}` : ""} · {s.section}
                </p>
              </div>
            </div>
            {s.quote ? <p className="line-clamp-4 border-l-2 border-border-strong pl-2.5 text-xs leading-relaxed text-muted">“{s.quote}”</p> : null}
            <Link href={`/policies/${encodeURIComponent(s.key)}`} className="inline-flex w-fit items-center gap-1 text-xs font-medium text-brand-fg hover:underline">
              <BookOpen className="size-3" /> Open policy <ArrowUpRight className="size-3" />
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
