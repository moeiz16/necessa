"use client";

/**
 * Trust primitives. Quiet, plainly worded, never decorative. Rules they encode:
 *  - Anything Necessa prepared is labelled as such, with confidence and a way to see the basis.
 *  - Status is never conveyed by colour alone (icon + text, always).
 *  - Identifiers stay masked until a permitted user shows them; every reveal is recorded.
 *  - Humans decide: review state is visible wherever a result is shown.
 */
import { CircleCheck, CircleDashed, Eye, EyeOff, Info, LoaderCircle, Lock, ShieldCheck, Sparkles, TriangleAlert, UserCheck, UserPen } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/display";
import { Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/overlays";

type Tone = "neutral" | "brand" | "met" | "notmet" | "insufficient" | "degraded" | "info";

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  brand: "text-brand-fg",
  met: "text-met-fg",
  notmet: "text-notmet-fg",
  insufficient: "text-insufficient-fg",
  degraded: "text-degraded-fg",
  info: "text-info",
};
const TONE_ICON: Record<Tone, React.ComponentType<{ className?: string }>> = {
  neutral: CircleDashed,
  brand: Info,
  met: CircleCheck,
  notmet: TriangleAlert,
  insufficient: TriangleAlert,
  degraded: CircleDashed,
  info: Info,
};

/** Icon + label status (never colour alone). */
export function StatusLabel({ tone = "neutral", icon, children, className }: { tone?: Tone; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium", TONE_TEXT[tone], className)}>
      <span className="shrink-0 [&_svg]:size-3.5">{icon ?? <Icon />}</span>
      <span>{children}</span>
    </span>
  );
}

/** Marks content Necessa prepared. Hover explains what that means. */
export function AiBadge({ label = "Suggested by Necessa", className, size = "xs", detail }: { label?: string; className?: string; size?: "xs" | "sm"; detail?: React.ReactNode }) {
  return (
    <Tooltip content={detail ?? "Prepared by Necessa and checked against quoted policy text. A person reviews it before anything is submitted."}>
      <Badge tone="neutral" size={size} className={cn("cursor-default gap-1", className)}>
        <Sparkles />
        {label}
      </Badge>
    </Tooltip>
  );
}

/** "Necessa is working" indicator: a small spinner and plain text, nothing more. */
export function AiWorking({ label = "Checking", className }: { label?: React.ReactNode; className?: string }) {
  return (
    <span role="status" aria-live="polite" className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium text-muted", className)}>
      <LoaderCircle className="size-3.5 animate-spin text-subtle" aria-hidden />
      <span>{label}</span>
    </span>
  );
}

/** Wraps content that is still being prepared. Marks it busy for assistive tech; no visual effect. */
export function AiShimmer({ active, children, className }: { active: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("relative", className)} aria-busy={active || undefined}>
      {children}
    </div>
  );
}

function confidenceBand(v: number) {
  if (v >= 0.8) return { label: "High", tone: "met" as const };
  if (v >= 0.55) return { label: "Moderate", tone: "insufficient" as const };
  return { label: "Low", tone: "notmet" as const };
}

/** Confidence as words + number, not just bars. */
export function ConfidencePill({ value, className, showNumber = true }: { value: number; className?: string; showNumber?: boolean }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const band = confidenceBand(value);
  return (
    <Tooltip content={`Confidence ${pct}%. Lower-confidence items are flagged for your attention.`}>
      <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-[5px] bg-surface-2 px-1.5 text-[11.5px] text-muted ring-1 ring-inset ring-border", className)}>
        <span className="flex items-end gap-[2px]" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={cn("w-[3px] rounded-[1px]", i < (band.label === "High" ? 3 : band.label === "Moderate" ? 2 : 1) ? "bg-fg/70" : "bg-surface-3")}
              style={{ height: 5 + i * 2.5 }}
            />
          ))}
        </span>
        <span className="font-medium text-fg">{band.label}</span>
        {showNumber ? <span className="tabular">{pct}%</span> : null}
      </span>
    </Tooltip>
  );
}

/** "See basis" affordance: opens a popover explaining a result (the quote, the rule, the check). */
export function WhyButton({ children, title = "Basis for this result", className, label = "See basis" }: { children: React.ReactNode; title?: React.ReactNode; className?: string; label?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted outline-none transition-colors hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-brand/30",
            className,
          )}
        >
          <Info className="size-3.5" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <p className="text-[13px] font-medium text-fg">{title}</p>
        <div className="mt-2 grid gap-2 text-[13px] leading-relaxed text-muted">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

/** Human-in-the-loop state for any result Necessa prepared. */
export function ReviewBadge({ state, by, className }: { state: "pending" | "reviewed" | "overridden"; by?: string | null; className?: string }) {
  const meta = {
    pending: { icon: UserPen, label: "Awaiting your review", tone: "insufficient" as const },
    reviewed: { icon: UserCheck, label: by ? `Reviewed by ${by}` : "Reviewed by a person", tone: "met" as const },
    overridden: { icon: UserPen, label: by ? `Changed by ${by}` : "Changed by a reviewer", tone: "neutral" as const },
  }[state];
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone} size="xs" className={className}>
      <Icon />
      {meta.label}
    </Badge>
  );
}

/**
 * Masked identifier with an explicit, recorded reveal.
 * `onReveal` should call the API with `reveal=true`; the component shows the returned value.
 */
export function PhiMask({
  masked,
  value,
  onReveal,
  canReveal = true,
  label = "identifier",
  className,
}: {
  masked: React.ReactNode;
  value?: React.ReactNode | null;
  onReveal?: () => void | Promise<void>;
  canReveal?: boolean;
  label?: string;
  className?: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const shown = value != null && !hidden;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className={cn("tabular", shown ? "text-fg" : "font-mono text-muted")}>{shown ? value : masked}</span>
      {shown ? (
        <Tooltip content="Hide again">
          <button type="button" onClick={() => setHidden(true)} className="rounded p-0.5 text-subtle hover:bg-surface-2 hover:text-fg" aria-label={`Hide ${label}`}>
            <EyeOff className="size-3.5" />
          </button>
        </Tooltip>
      ) : canReveal && onReveal ? (
        <Tooltip content="Show. This access is recorded in the audit trail">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setHidden(false);
              if (value != null) return;
              setBusy(true);
              try {
                await onReveal();
              } finally {
                setBusy(false);
              }
            }}
            className="inline-flex items-center gap-1 rounded px-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
            aria-label={`Show ${label} (recorded)`}
          >
            <Eye className="size-3.5" />
            Show
          </button>
        </Tooltip>
      ) : (
        <Tooltip content="Your role can’t view patient identifiers">
          <Lock className="size-3.5 text-subtle" aria-label="Masked" />
        </Tooltip>
      )}
    </span>
  );
}

/** One-line source line for a quoted passage. */
export function Provenance({ source, detail, verified = true, className }: { source: React.ReactNode; detail?: React.ReactNode; verified?: boolean; className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-subtle", className)}>
      <span className="text-muted">{source}</span>
      {detail ? <span>· {detail}</span> : null}
      {verified ? (
        <span className="inline-flex items-center gap-1 text-met-fg">
          · <ShieldCheck className="size-3" /> quote verified
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-insufficient-fg">
          · <TriangleAlert className="size-3" /> quote not found
        </span>
      )}
    </p>
  );
}

/** Standing reminder used near results that could be mistaken for a coverage decision. */
export function DecisionDisclaimer({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 text-xs leading-relaxed text-subtle", className)}>
      <ShieldCheck className="mt-px size-3.5 shrink-0 text-met" />
      Necessa checks documentation readiness. It never approves or denies coverage, and a licensed professional reviews every output.
    </p>
  );
}
