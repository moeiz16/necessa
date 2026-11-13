import { FileText, Quote, ShieldCheck } from "lucide-react";
import type { Verdict } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { ReadinessRing, VerdictIcon } from "@/components/domain/verdict";

const ROWS: { text: string; verdict: Verdict }[] = [
  { text: "Pain supported by history and exam", verdict: "MET" },
  { text: "Functional limitation on a standard scale", verdict: "MET" },
  { text: "At least 4 weeks of conservative care", verdict: "INSUFFICIENT" },
  { text: "Imaging consistent with symptoms", verdict: "MET" },
  { text: "Image guidance planned", verdict: "MET" },
  { text: "No active infection (signed statement)", verdict: "INSUFFICIENT" },
];

/** Calm, static product preview: a case checked against the payer's policy. Sample data only. */
export function HeroVisual() {
  const met = ROWS.filter((r) => r.verdict === "MET").length;
  return (
    <figure className="m-0" aria-label="Preview of a case checked against the payer policy (sample data)">
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <ReadinessRing size={40} stroke={3.5} score={met / ROWS.length} readiness="gaps" />
            <div className="grid min-w-0 leading-tight">
              <span className="truncate text-[13px] font-medium text-fg">Right L5-S1 epidural steroid injection</span>
              <span className="truncate text-xs text-muted">Medicare Part B · Texas · Date of service Nov 18</span>
            </div>
          </div>
          <span className="hidden shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted sm:inline">Awaiting review</span>
        </div>
        <ul className="divide-y divide-border">
          {ROWS.map((r) => (
            <li key={r.text} className="flex items-center gap-3 px-4 py-2.5">
              <VerdictIcon verdict={r.verdict} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{r.text}</span>
              <span className={cn("shrink-0 text-[12px] font-medium", r.verdict === "MET" ? "text-met-fg" : "text-insufficient-fg")}>
                {r.verdict === "MET" ? "Met" : "Needs documentation"}
              </span>
            </li>
          ))}
        </ul>
        <div className="grid gap-3 border-t border-border bg-surface-2/60 px-4 py-3.5">
          <div className="grid gap-1.5">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-subtle">
              <FileText className="size-3" /> From the chart · MRI lumbar spine, Aug 30
            </span>
            <p className="flex gap-2 text-[13px] leading-snug text-fg">
              <Quote className="mt-0.5 size-3.5 shrink-0 text-subtle" />
              <span>
                <mark className="mark-evidence">L5-S1 disc protrusion contacting the descending right S1 nerve root</mark>
              </span>
            </p>
            <span className="inline-flex items-center gap-1 text-[11px] text-met-fg">
              <ShieldCheck className="size-3" /> Quote verified against the chart
            </span>
          </div>
          <p className="border-t border-border pt-3 text-[13px] text-muted">
            <span className="font-medium text-fg">Next step:</span> add the physical therapy dates and a signed pre-procedure statement.
          </p>
        </div>
      </div>
      <figcaption className="mt-2 text-[11px] text-subtle">Sample data</figcaption>
    </figure>
  );
}
