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
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
  optional?: boolean;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      {label ? (
        <div className="flex items-baseline justify-between">
          <Label htmlFor={htmlFor}>{label}</Label>
          {optional ? <span className="text-xs text-subtle">Optional</span> : null}
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
