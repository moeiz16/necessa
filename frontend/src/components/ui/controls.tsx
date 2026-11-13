"use client";

import { Check, ChevronDown, ChevronsUpDown, Minus } from "lucide-react";
import { Checkbox as CB, RadioGroup as RG, Select as S, Switch as SW, Tabs as TB, ToggleGroup as TG } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

/* ── Select ─────────────────────────────────────────────────────────────── */
export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  className,
  size = "md",
  id,
  disabled,
  "aria-label": ariaLabel,
}: {
  value?: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: React.ReactNode; hint?: string }[];
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <S.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <S.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-left text-sm text-fg outline-none hover:border-border-strong focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/15 data-[placeholder]:text-subtle",
          size === "sm" ? "h-8 text-[13px]" : "h-9",
          className,
        )}
      >
        <S.Value placeholder={placeholder} />
        <S.Icon>
          <ChevronDown className="size-4 text-subtle" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={6} className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-e3 data-[state=open]:animate-[rise_150ms]">
          <S.Viewport>
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                className="relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-7 pr-2 text-[13px] outline-none data-[highlighted]:bg-surface-2"
              >
                <S.ItemIndicator className="absolute left-2">
                  <Check className="size-3.5 text-brand" />
                </S.ItemIndicator>
                <S.ItemText>{o.label}</S.ItemText>
                {o.hint ? <span className="ml-auto text-xs text-subtle">{o.hint}</span> : null}
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

/* ── Checkbox ───────────────────────────────────────────────────────────── */
export function Checkbox({ className, ...props }: React.ComponentProps<typeof CB.Root>) {
  return (
    <CB.Root
      className={cn(
        "peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border-strong bg-surface outline-none transition-colors focus-visible:ring-3 focus-visible:ring-brand/20 data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=indeterminate]:border-brand data-[state=indeterminate]:bg-brand",
        className,
      )}
      {...props}
    >
      <CB.Indicator className="text-brand-contrast">
        {props.checked === "indeterminate" ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}
      </CB.Indicator>
    </CB.Root>
  );
}

/* ── Switch ─────────────────────────────────────────────────────────────── */
export function Switch({ className, ...props }: React.ComponentProps<typeof SW.Root>) {
  return (
    <SW.Root
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full bg-surface-3 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-brand/20 data-[state=checked]:bg-brand",
        className,
      )}
      {...props}
    >
      <SW.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform data-[state=checked]:translate-x-[18px]" />
    </SW.Root>
  );
}

/* ── Radio cards ────────────────────────────────────────────────────────── */
export function RadioCards({
  value,
  onValueChange,
  options,
  className,
  columns = 2,
}: {
  value?: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: React.ReactNode; description?: React.ReactNode; icon?: React.ReactNode }[];
  className?: string;
  columns?: 1 | 2 | 3 | 4;
}) {
  return (
    <RG.Root
      value={value}
      onValueChange={onValueChange}
      className={cn("grid gap-2", columns === 2 && "sm:grid-cols-2", columns === 3 && "sm:grid-cols-3", columns === 4 && "sm:grid-cols-4", className)}
    >
      {options.map((o) => (
        <RG.Item
          key={o.value}
          value={o.value}
          className="group flex items-start gap-3 rounded-lg border border-border bg-surface p-3 text-left outline-none transition-[border,box-shadow,background] hover:border-border-strong focus-visible:ring-3 focus-visible:ring-brand/20 data-[state=checked]:border-brand data-[state=checked]:bg-brand-soft/40 data-[state=checked]:shadow-[0_0_0_1px_var(--brand)]"
        >
          {o.icon ? <span className="mt-0.5 text-muted group-data-[state=checked]:text-brand [&_svg]:size-4">{o.icon}</span> : null}
          <span className="grid gap-0.5">
            <span className="text-[13px] font-medium text-fg">{o.label}</span>
            {o.description ? <span className="text-xs text-muted">{o.description}</span> : null}
          </span>
          <span className="ml-auto mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong group-data-[state=checked]:border-brand">
            <RG.Indicator className="size-2 rounded-full bg-brand" />
          </span>
        </RG.Item>
      ))}
    </RG.Root>
  );
}

/* ── Tabs ───────────────────────────────────────────────────────────────── */
export const Tabs = TB.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof TB.List>) {
  return <TB.List className={cn("flex items-center gap-1 overflow-x-auto border-b border-border scrollbar-thin", className)} {...props} />;
}
export function TabsTrigger({ className, children, count, ...props }: React.ComponentProps<typeof TB.Trigger> & { count?: number | null }) {
  return (
    <TB.Trigger
      className={cn(
        "relative -mb-px inline-flex h-10 shrink-0 items-center gap-1.5 px-2.5 text-[13px] font-medium text-muted outline-none transition-colors hover:text-fg focus-visible:text-fg data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-1.5 data-[state=active]:after:bottom-0 data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-fg [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined && count !== null ? (
        <span className="tabular rounded-full bg-surface-2 px-1.5 text-[11px] leading-[18px] text-muted">{count}</span>
      ) : null}
    </TB.Trigger>
  );
}
export const TabsContent = ({ className, ...props }: React.ComponentProps<typeof TB.Content>) => (
  <TB.Content className={cn("outline-none data-[state=active]:animate-[fade-in_160ms]", className)} {...props} />
);

/* ── Segmented control ──────────────────────────────────────────────────── */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  className,
  size = "sm",
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode }[];
  className?: string;
  size?: "xs" | "sm";
}) {
  return (
    <TG.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v as T)}
      className={cn("inline-flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5", className)}
    >
      {options.map((o) => (
        <TG.Item
          key={o.value}
          value={o.value}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 font-medium text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-brand/30 data-[state=on]:bg-surface data-[state=on]:text-fg data-[state=on]:shadow-e1 [&_svg]:size-3.5",
            size === "xs" ? "h-6 text-xs" : "h-7 text-[13px]",
          )}
        >
          {o.icon}
          {o.label}
        </TG.Item>
      ))}
    </TG.Root>
  );
}

export { ChevronsUpDown };
