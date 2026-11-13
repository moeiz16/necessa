import * as React from "react";
import { cn } from "@/lib/utils";

type Art = "cases" | "search" | "documents" | "inbox" | "chart" | "shield" | "spark";

/** Small, quiet line illustrations drawn on the 32-unit brand grid. */
function Illustration({ art }: { art: Art }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg width="88" height="72" viewBox="0 0 88 72" aria-hidden className="text-border-strong">
      <rect x="6" y="10" width="76" height="54" rx="10" className="fill-surface-2" stroke="none" />
      {art === "cases" && (
        <g {...common}>
          <rect x="22" y="18" width="44" height="38" rx="5" className="fill-surface" />
          <path d="M30 28h20M30 36h28M30 44h14" />
          <path d="M53 43l3.5 3.5L63 40" className="text-met" stroke="var(--met)" strokeWidth={2} />
        </g>
      )}
      {art === "search" && (
        <g {...common}>
          <circle cx="40" cy="34" r="12" className="fill-surface" />
          <path d="M49 43l9 9" strokeWidth={2.2} />
          <path d="M35 34h10" />
        </g>
      )}
      {art === "documents" && (
        <g {...common}>
          <rect x="26" y="20" width="30" height="36" rx="4" className="fill-surface" />
          <rect x="32" y="16" width="30" height="36" rx="4" className="fill-surface" />
          <path d="M38 26h18M38 32h18M38 38h11" />
        </g>
      )}
      {art === "inbox" && (
        <g {...common}>
          <path d="M22 40l7-18h30l7 18v12a4 4 0 01-4 4H26a4 4 0 01-4-4z" className="fill-surface" />
          <path d="M22 40h13l3 5h12l3-5h13" />
        </g>
      )}
      {art === "chart" && (
        <g {...common}>
          <path d="M22 54V22M22 54h44" />
          <path d="M28 46l9-9 7 5 12-14" stroke="var(--brand)" strokeWidth={2} />
          <circle cx="56" cy="28" r="2.4" fill="var(--brand)" stroke="none" />
        </g>
      )}
      {art === "shield" && (
        <g {...common}>
          <path d="M44 16l16 6v12c0 10-7 17-16 21-9-4-16-11-16-21V22z" className="fill-surface" />
          <path d="M37 35l5 5 9-10" stroke="var(--met)" strokeWidth={2} />
        </g>
      )}
      {art === "spark" && (
        <g {...common}>
          <path d="M44 18l3.5 10.5L58 32l-10.5 3.5L44 46l-3.5-10.5L30 32l10.5-3.5z" stroke="var(--ai-2)" strokeWidth={1.8} className="fill-surface" />
          <path d="M60 46l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" stroke="var(--ai-3)" />
        </g>
      )}
    </svg>
  );
}

export function EmptyState({
  art = "search",
  title,
  description,
  action,
  className,
  compact,
}: {
  art?: Art;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "gap-2 py-8" : "gap-3 py-14", className)}>
      {!compact ? <Illustration art={art} /> : null}
      <div className="grid max-w-sm gap-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description ? <p className="text-[13px] text-muted text-pretty">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
