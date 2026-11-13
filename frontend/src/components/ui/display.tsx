import { cva, type VariantProps } from "class-variance-authority";
import { Check, ChevronRight } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { cn, initials } from "@/lib/utils";

/* ── Badge ──────────────────────────────────────────────────────────────── */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] font-medium leading-none [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "bg-surface-2 text-muted ring-1 ring-inset ring-border",
        brand: "bg-brand-soft text-brand-fg",
        met: "bg-met-soft text-met-fg",
        notmet: "bg-notmet-soft text-notmet-fg",
        insufficient: "bg-insufficient-soft text-insufficient-fg",
        degraded: "bg-degraded-soft text-degraded-fg",
        info: "bg-info-soft text-info",
        outline: "text-muted ring-1 ring-inset ring-border-strong",
        ai: "ai-border text-fg",
      },
      size: { xs: "h-[18px] px-1.5 text-[11px]", sm: "h-5 px-1.5 text-xs", md: "h-6 px-2 text-xs" },
    },
    defaultVariants: { tone: "neutral", size: "sm" },
  },
);

export function Badge({ className, tone, size, dot, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { dot?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {dot ? <span className="size-1.5 rounded-full bg-current opacity-80" /> : null}
      {props.children}
    </span>
  );
}

/* ── Avatar ─────────────────────────────────────────────────────────────── */
export function Avatar({ name, color, size = 24, className }: { name?: string | null; color?: string | null; size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      title={name ?? undefined}
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white ring-2 ring-surface", className)}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.38), background: color || "var(--fg-subtle)" }}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ people, max = 3, size = 22 }: { people: { fullName: string; avatarColor?: string | null }[]; max?: number; size?: number }) {
  return (
    <span className="flex -space-x-1.5">
      {people.slice(0, max).map((p) => (
        <Avatar key={p.fullName} name={p.fullName} color={p.avatarColor} size={size} />
      ))}
      {people.length > max ? (
        <span className="inline-flex items-center justify-center rounded-full bg-surface-3 text-[10px] font-medium text-muted ring-2 ring-surface" style={{ width: size, height: size }}>
          +{people.length - max}
        </span>
      ) : null}
    </span>
  );
}

/* ── Card ───────────────────────────────────────────────────────────────── */
/** Surface container. `interactive` adds hover elevation for clickable cards. Accepts `ref` (React 19). */
export function Card({ className, interactive, ...props }: React.ComponentProps<"div"> & { interactive?: boolean }) {
  return (
    <div
      className={cn("rounded-lg bg-surface shadow-e1", interactive && "cursor-pointer transition-shadow duration-150 ease-out hover:shadow-e2", className)}
      {...props}
    />
  );
}
export function CardHeader({
  title,
  description,
  actions,
  className,
  icon,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-4 pb-2 pt-4", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? <span className="mt-0.5 text-subtle [&_svg]:size-4">{icon}</span> : null}
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium text-fg">{title}</h3>
          {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}
export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 pb-4", className)} {...props} />;
}

/* ── Skeleton / spinner-free loading ────────────────────────────────────── */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("skeleton rounded-md", className)} aria-hidden {...props} />;
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("grid gap-2", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10" style={{ opacity: 1 - i * 0.1 }} />
      ))}
    </div>
  );
}

/* ── Kbd ────────────────────────────────────────────────────────────────── */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-[4px] border border-border bg-surface-2 px-1 font-sans text-[11px] font-medium text-muted shadow-[inset_0_-1px_0_var(--border)]", className)}>
      {children}
    </kbd>
  );
}

/* ── Breadcrumb ─────────────────────────────────────────────────────────── */
export function Breadcrumb({ items }: { items: { label: React.ReactNode; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px] text-muted">
      {items.map((it, i) => {
        const last = i === items.length - 1;
        // Phones show only the current page; earlier crumbs would truncate to unreadable slivers.
        return (
          <span key={i} className={last ? "flex min-w-0 items-center gap-1" : "hidden min-w-0 items-center gap-1 sm:flex"}>
            {i > 0 ? <ChevronRight className="hidden size-3.5 shrink-0 text-subtle sm:block" /> : null}
            {it.href && !last ? (
              <Link href={it.href} className="truncate hover:text-fg">
                {it.label}
              </Link>
            ) : (
              <span className="truncate text-fg" aria-current={last ? "page" : undefined}>
                {it.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

/* ── Page header ────────────────────────────────────────────────────────── */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1.5">{eyebrow}</div> : null}
        <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-fg">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted text-pretty">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ── Data list (definition list) ────────────────────────────────────────── */
export function DataList({ items, className, cols = 1 }: { items: { label: React.ReactNode; value: React.ReactNode }[]; className?: string; cols?: 1 | 2 }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3", cols === 2 && "sm:grid-cols-2", className)}>
      {items.map((it, i) => (
        <div key={i} className="grid grid-cols-[minmax(7rem,38%)_1fr] items-baseline gap-3 text-[13px]">
          <dt className="text-muted">{it.label}</dt>
          <dd className="min-w-0 text-fg">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── Progress ───────────────────────────────────────────────────────────── */
export function Progress({ value, className, tone = "brand" }: { value: number; className?: string; tone?: "brand" | "met" | "insufficient" | "notmet" }) {
  const color = { brand: "bg-brand", met: "bg-met", insufficient: "bg-insufficient", notmet: "bg-notmet" }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full transition-[width] duration-300 ease-out", color)} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

/* ── Stepper ────────────────────────────────────────────────────────────── */
export function Stepper({ steps, current, onStepClick }: { steps: { label: string; description?: string }[]; current: number; onStepClick?: (i: number) => void }) {
  return (
    <ol className="flex flex-col gap-1">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={s.label}>
            <button
              type="button"
              disabled={!onStepClick || i > current}
              onClick={() => onStepClick?.(i)}
              className={cn("group flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors enabled:hover:bg-surface-2", active && "bg-surface-2")}
            >
              <span
                className={cn(
                  "mt-px flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium tabular",
                  done && "border-met bg-met text-white",
                  active && "border-brand bg-brand text-brand-contrast",
                  !done && !active && "border-border-strong text-subtle",
                )}
              >
                {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className="grid">
                <span className={cn("text-[13px] font-medium", active || done ? "text-fg" : "text-muted")}>{s.label}</span>
                {s.description ? <span className="text-xs text-subtle">{s.description}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ── Section label ──────────────────────────────────────────────────────── */
export function SectionLabel({ children, className, action }: { children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      <h4 className="text-[11px] font-medium text-subtle">{children}</h4>
      {action}
    </div>
  );
}

/* ── Code block ─────────────────────────────────────────────────────────── */
export function CodeBlock({ code, language, className }: { code: string; language?: string; className?: string }) {
  const html = language === "sql" ? highlightSql(code) : escapeHtml(code);
  return (
    <div className={cn("relative overflow-hidden rounded-lg border border-border bg-surface-2", className)}>
      {language ? <span className="absolute right-2 top-1.5 font-mono text-[10px] uppercase tracking-wider text-subtle">{language}</span> : null}
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-fg scrollbar-thin">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SQL_KW = /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|LIMIT|AS|AND|OR|ON|JOIN|LEFT|INNER|COUNT|AVG|ROUND|SUM|DESC|ASC|INTERVAL|CURRENT_DATE|IS NOT NULL|NOT|NULL|EXTRACT|EPOCH|date_trunc|numeric|WITH|CASE|WHEN|THEN|ELSE|END|IN)\b/g;
function highlightSql(s: string) {
  return escapeHtml(s)
    .replace(/('[^']*')/g, '<span style="color:var(--met-fg)">$1</span>')
    .replace(SQL_KW, '<span style="color:var(--brand-fg);font-weight:600">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span style="color:var(--insufficient-fg)">$1</span>');
}

/* ── Status dot ─────────────────────────────────────────────────────────── */
export function Dot({ tone = "neutral", pulse, className }: { tone?: "neutral" | "met" | "notmet" | "insufficient" | "brand" | "degraded"; pulse?: boolean; className?: string }) {
  const c = { neutral: "bg-subtle", met: "bg-met", notmet: "bg-notmet", insufficient: "bg-insufficient", brand: "bg-brand", degraded: "bg-degraded" }[tone];
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      <span className={cn("relative inline-flex size-2 rounded-full", c, pulse && "animate-pulse-dot")} />
    </span>
  );
}
