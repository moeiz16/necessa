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
          <path d="M44 18l3.5 10.5L58 32l-10.5 3.5L44 46l-3.5-10.5L30 32l10.5-3.5z" stroke="var(--fg-subtle)" strokeWidth={1.8} className="fill-surface" />
          <path d="M60 46l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" stroke="var(--fg-subtle)" />
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

/** Error state with a correlation reference and retry — used for failed queries inside a page. */
export function ErrorState({
  title = "Couldn’t load this",
  description = "The request failed. Nothing you entered was lost.",
  onRetry,
  reference,
  className,
  compact,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  onRetry?: () => void;
  reference?: string | null;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-3 text-center", compact ? "py-8" : "py-14", className)}>
      <span className="flex size-10 items-center justify-center rounded-full bg-notmet-soft text-notmet">
        <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden>
          <path d="M8 1.75 14.5 13.5h-13z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M8 6.2v3.2M8 11.4v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
      <div className="grid max-w-sm gap-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {description ? <p className="text-[13px] text-muted text-pretty">{description}</p> : null}
        {reference ? <code className="mx-auto mt-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">ref {reference}</code> : null}
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="press inline-flex h-8 items-center gap-1.5 rounded-md bg-surface px-3 text-[13px] font-medium text-fg shadow-e1 hover:bg-surface-2"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** Inline notice for context, warnings and degraded-mode explanations. Icon + text, never color alone. */
export function Callout({
  tone = "info",
  title,
  children,
  icon,
  action,
  className,
}: {
  tone?: "info" | "warning" | "danger" | "success" | "ai" | "neutral";
  title?: React.ReactNode;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const styles = {
    info: "bg-info-soft/70 text-fg ring-info/20 [&_[data-icon]]:text-info",
    warning: "bg-insufficient-soft/70 text-fg ring-insufficient/25 [&_[data-icon]]:text-insufficient",
    danger: "bg-notmet-soft/70 text-fg ring-notmet/25 [&_[data-icon]]:text-notmet",
    success: "bg-met-soft/70 text-fg ring-met/25 [&_[data-icon]]:text-met",
    ai: "border border-border bg-surface text-fg",
    neutral: "bg-surface-2 text-fg ring-border [&_[data-icon]]:text-subtle",
  }[tone];
  const glyph = {
    info: <path d="M8 7.2v4M8 4.8v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
    warning: <path d="M8 4.6v4.2M8 11.2v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
    danger: <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
    success: <path d="M5.2 8.2l1.9 1.9 3.8-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
    ai: <path d="M8 3.2l1.2 3.6 3.6 1.2-3.6 1.2L8 12.8l-1.2-3.6L3.2 8l3.6-1.2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />,
    neutral: <path d="M8 7.2v4M8 4.8v.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
  }[tone];
  return (
    <div className={cn("flex gap-3 rounded-lg px-3.5 py-3 text-[13px] ring-1 ring-inset", styles, className)}>
      <span data-icon className="mt-px shrink-0 [&_svg]:size-4">
        {icon ?? (
          <svg viewBox="0 0 16 16" fill="none" aria-hidden>
            {tone !== "ai" ? <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3" /> : null}
            {glyph}
          </svg>
        )}
      </span>
      <div className="grid min-w-0 flex-1 gap-0.5">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        {children ? <div className="leading-relaxed text-muted">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}
