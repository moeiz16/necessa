import { cn } from "@/lib/utils";

/**
 * Necessa mark — "the stem and the tick".
 * A single continuous stroke draws an N whose final two strokes form a check:
 * the left stem is the *criterion*, the descent + long ascent is the *verification*.
 * Geometry lives on a 32-unit grid; strokes are round-capped for a calm, clinical feel.
 */
export const MARK_PATH = "M9 23V9.5l7.6 9.8L24 8.5";

type MarkProps = {
  size?: number;
  className?: string;
  title?: string;
  /** "glyph" = stroke only (currentColor). "badge" = filled tile (currentColor) with knocked-out glyph. */
  variant?: "glyph" | "badge";
  /** glyph color inside a badge */
  contrast?: string;
  strokeWidth?: number;
};

export function LogoMark({
  size = 28,
  className,
  title = "Necessa",
  variant = "badge",
  contrast = "var(--brand-contrast, #fff)",
  strokeWidth = 3.1,
}: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label={title}
      className={cn("shrink-0", className)}
    >
      <title>{title}</title>
      {variant === "badge" ? (
        <>
          <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="currentColor" />
          <rect
            x="0.5"
            y="0.5"
            width="31"
            height="31"
            rx="9"
            fill="url(#necessa-sheen)"
            opacity="0.18"
          />
          <path
            d={MARK_PATH}
            stroke={contrast}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <defs>
            <linearGradient id="necessa-sheen" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
              <stop stopColor="#fff" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
          </defs>
        </>
      ) : (
        <path
          d={MARK_PATH}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function LogoWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-sans text-[17px] font-semibold leading-none tracking-[-0.035em] text-fg",
        className,
      )}
    >
      necessa
    </span>
  );
}

export function Logo({
  className,
  size = 26,
  showWordmark = true,
  markClassName,
}: {
  className?: string;
  size?: number;
  showWordmark?: boolean;
  markClassName?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark size={size} className={cn("text-brand", markClassName)} />
      {showWordmark ? <LogoWordmark /> : null}
    </span>
  );
}
