"use client";

import { Command as Cmdk } from "cmdk";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./overlays";

export const Command = React.forwardRef<React.ElementRef<typeof Cmdk>, React.ComponentPropsWithoutRef<typeof Cmdk>>(({ className, ...props }, ref) => (
  <Cmdk ref={ref} className={cn("flex h-full w-full flex-col overflow-hidden text-fg", className)} {...props} />
));
Command.displayName = "Command";

export function CommandInput({ className, ...props }: React.ComponentProps<typeof Cmdk.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3">
      <Search className="size-4 shrink-0 text-subtle" />
      <Cmdk.Input className={cn("h-11 w-full bg-transparent text-sm outline-none placeholder:text-subtle", className)} {...props} />
    </div>
  );
}
export function CommandList({ className, ...props }: React.ComponentProps<typeof Cmdk.List>) {
  return <Cmdk.List className={cn("max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain p-1.5 scrollbar-thin", className)} {...props} />;
}
export function CommandEmpty(props: React.ComponentProps<typeof Cmdk.Empty>) {
  return <Cmdk.Empty className="px-3 py-8 text-center text-[13px] text-muted" {...props} />;
}
export function CommandGroup({ className, ...props }: React.ComponentProps<typeof Cmdk.Group>) {
  return (
    <Cmdk.Group
      className={cn(
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle",
        className,
      )}
      {...props}
    />
  );
}
export function CommandItem({ className, ...props }: React.ComponentProps<typeof Cmdk.Item>) {
  return (
    <Cmdk.Item
      className={cn(
        "flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-2 text-[13px] outline-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface-2 [&_svg]:size-4 [&_svg]:text-subtle",
        className,
      )}
      {...props}
    />
  );
}
export const CommandSeparator = (props: React.ComponentProps<typeof Cmdk.Separator>) => <Cmdk.Separator className="-mx-1.5 my-1 h-px bg-border" {...props} />;

/* ── Combobox (single or multi, async-friendly) ─────────────────────────── */
export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
}

export function Combobox({
  options,
  value,
  onChange,
  multiple,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  onSearch,
  loading,
  empty = "No results",
  className,
  renderValue,
  id,
}: {
  options: ComboOption[];
  value: string[];
  onChange: (v: string[]) => void;
  multiple?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  onSearch?: (q: string) => void;
  loading?: boolean;
  empty?: React.ReactNode;
  className?: string;
  renderValue?: (v: string) => React.ReactNode;
  id?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const listId = React.useId();
  // With async search (`onSearch`), cmdk keeps the previous highlight when results arrive, so Enter
  // would select nothing. Control the highlight and move it to the first result on every update.
  const itemKey = (o: ComboOption) => `${o.value} ${o.label}`;
  const firstKey = options[0] ? itemKey(options[0]) : "";
  const [active, setActive] = React.useState(firstKey);
  React.useEffect(() => {
    if (onSearch) setActive(firstKey);
  }, [firstKey, onSearch]);
  const toggle = (v: string) => {
    if (multiple) onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
    else {
      onChange([v]);
      setOpen(false);
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          className={cn(
            "flex min-h-9 w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-left text-sm outline-none hover:border-border-strong focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/15",
            className,
          )}
        >
          <span className="flex min-w-0 flex-1 flex-wrap gap-1">
            {value.length === 0 ? <span className="px-1 text-subtle">{placeholder}</span> : null}
            {value.map((v) =>
              multiple ? (
                <span key={v} className="inline-flex items-center gap-1 rounded-sm bg-surface-2 py-0.5 pl-1.5 pr-0.5 font-mono text-xs text-fg">
                  {renderValue ? renderValue(v) : v}
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Remove ${v}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onChange(value.filter((x) => x !== v));
                    }}
                    className="rounded-[3px] p-0.5 text-subtle hover:bg-surface-3 hover:text-fg"
                  >
                    <X className="size-3" />
                  </span>
                </span>
              ) : (
                <span key={v} className="truncate px-1">
                  {renderValue ? renderValue(v) : options.find((o) => o.value === v)?.label ?? v}
                </span>
              ),
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-subtle" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(28rem,calc(100vw-2rem))] p-0" align="start">
        <Command
          shouldFilter={!onSearch}
          value={onSearch ? active : undefined}
          onValueChange={onSearch ? setActive : undefined}
        >
          <CommandInput
            placeholder={searchPlaceholder}
            value={q}
            onValueChange={(v) => {
              setQ(v);
              onSearch?.(v);
            }}
          />
          <CommandList id={listId}>
            {loading ? <div className="px-3 py-6 text-center text-[13px] text-muted">Searching…</div> : <CommandEmpty>{empty}</CommandEmpty>}
            {options.map((o) => (
              <CommandItem key={o.value} value={itemKey(o)} onSelect={() => toggle(o.value)}>
                <span className={cn("flex size-4 items-center justify-center rounded-[4px] border", value.includes(o.value) ? "border-brand bg-brand text-brand-contrast" : "border-border-strong")}>
                  {value.includes(o.value) ? <Check className="size-3 !text-brand-contrast" strokeWidth={3} /> : null}
                </span>
                <span className="font-mono text-xs text-fg">{o.value}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{o.label}</span>
                {o.hint ? <span className="text-[11px] text-subtle">{o.hint}</span> : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
