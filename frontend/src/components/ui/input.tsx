"use client";

import { Eye, EyeOff } from "lucide-react";
import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

const field =
  "w-full rounded-md border border-border bg-surface px-3 text-sm text-fg shadow-[inset_0_1px_1px_rgb(16_18_23/0.03)] transition-[border,box-shadow] outline-none placeholder:text-subtle hover:border-border-strong focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/15 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-notmet aria-[invalid=true]:ring-notmet/15";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { leading?: React.ReactNode; trailing?: React.ReactNode }>(
  ({ className, leading, trailing, ...props }, ref) => {
    if (!leading && !trailing) return <input ref={ref} className={cn(field, "h-9", className)} {...props} />;
    return (
      <div className="relative flex items-center">
        {leading ? <span className="pointer-events-none absolute left-2.5 flex text-subtle [&_svg]:size-4">{leading}</span> : null}
        <input ref={ref} className={cn(field, "h-9", leading && "pl-8", trailing && "pr-9", className)} {...props} />
        {trailing ? <span className="absolute right-2 flex items-center text-subtle">{trailing}</span> : null}
      </div>
    );
  },
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(field, "min-h-24 py-2 leading-relaxed", className)} {...props} />,
);
Textarea.displayName = "Textarea";

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn("text-[13px] font-medium text-fg", className)} {...props} />;
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
  optional,
  action,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
  optional?: boolean;
  /** Right-aligned element on the label row (e.g. "Forgot password?"). */
  action?: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      {label ? (
        <div className="flex items-baseline justify-between gap-3">
          <Label htmlFor={htmlFor}>{label}</Label>
          {action ?? (optional ? <span className="text-xs text-subtle">Optional</span> : null)}
        </div>
      ) : null}
      {children}
      {error ? (
        <p role="alert" className="text-xs text-notmet-fg">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/** Password input with an accessible show/hide toggle. */
export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">>(({ className, ...props }, ref) => {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative flex items-center">
      <input ref={ref} type={show ? "text" : "password"} className={cn(field, "h-9 pr-10", className)} {...props} />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="absolute right-1.5 flex size-7 items-center justify-center rounded-md text-subtle outline-none hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-brand/30"
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";

/**
 * Segmented one-time-code input (TOTP / recovery). Supports paste of the whole code, arrow keys and
 * backspace navigation; exposes a single value to the form.
 */
export function OtpInput({
  value,
  onChange,
  length = 6,
  autoFocus,
  invalid,
  onComplete,
  "aria-label": ariaLabel = "Verification code",
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  autoFocus?: boolean;
  invalid?: boolean;
  onComplete?: (v: string) => void;
  "aria-label"?: string;
}) {
  const refs = React.useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? "");
  const set = (next: string) => {
    const clean = next.replace(/\D/g, "").slice(0, length);
    onChange(clean);
    if (clean.length === length) onComplete?.(clean);
  };
  return (
    <div className="flex items-center justify-between gap-2" role="group" aria-label={ariaLabel}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          value={d}
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          autoFocus={autoFocus && i === 0}
          aria-label={`Digit ${i + 1}`}
          aria-invalid={invalid || undefined}
          maxLength={length}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "");
            if (!v) return;
            if (v.length > 1) {
              set(v);
              refs.current[Math.min(length - 1, v.length)]?.focus();
              return;
            }
            const arr = digits.slice();
            arr[i] = v;
            set(arr.join(""));
            refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace") {
              e.preventDefault();
              const arr = digits.slice();
              if (arr[i]) {
                arr[i] = "";
                set(arr.join(""));
              } else if (i > 0) {
                arr[i - 1] = "";
                set(arr.join(""));
                refs.current[i - 1]?.focus();
              }
            } else if (e.key === "ArrowLeft") refs.current[i - 1]?.focus();
            else if (e.key === "ArrowRight") refs.current[i + 1]?.focus();
          }}
          onPaste={(e) => {
            e.preventDefault();
            set(e.clipboardData.getData("text"));
          }}
          className={cn(
            "h-12 w-full min-w-0 rounded-lg border border-border bg-surface text-center font-mono text-xl text-fg shadow-[inset_0_1px_1px_rgb(16_18_23/0.03)] outline-none transition-[border,box-shadow] focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/15",
            d && "border-border-strong",
            invalid && "border-notmet ring-notmet/15",
          )}
        />
      ))}
    </div>
  );
}
