"use client";

import { X } from "lucide-react";
import { Dialog as D, DropdownMenu as DM, HoverCard as HC, Popover as P, Tooltip as T } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

const panel = "z-50 rounded-lg border border-border bg-surface text-fg shadow-e3 outline-none";
const anim =
  "data-[state=open]:animate-[rise_160ms_var(--ease-out-quart)] data-[state=closed]:animate-[fade-in_100ms_reverse]";

/* ── Dialog ─────────────────────────────────────────────────────────────── */
export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  size = "md",
  hideClose,
  ...props
}: React.ComponentProps<typeof D.Content> & { title: React.ReactNode; description?: React.ReactNode; size?: "sm" | "md" | "lg" | "xl"; hideClose?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-[rgb(10_11_13/0.42)] backdrop-blur-[2px] data-[state=open]:animate-[fade-in_160ms]" />
      <D.Content
        className={cn(
          panel,
          "fixed left-1/2 top-[12vh] z-50 max-h-[78vh] w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto p-0 scrollbar-thin data-[state=open]:animate-[rise_200ms_var(--ease-out-quart)]",
          size === "sm" && "max-w-sm",
          size === "md" && "max-w-lg",
          size === "lg" && "max-w-2xl",
          size === "xl" && "max-w-4xl",
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="grid gap-1">
            <D.Title className="text-[15px] font-semibold tracking-tight">{title}</D.Title>
            {description ? <D.Description className="text-[13px] text-muted">{description}</D.Description> : <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>}
          </div>
          {!hideClose ? (
            <D.Close className="-mr-1 rounded-sm p-1 text-subtle hover:bg-surface-2 hover:text-fg" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          ) : null}
        </div>
        <div className="px-5 py-4">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("-mx-5 -mb-4 mt-5 flex items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-5 py-3", className)} {...props} />;
}

/* ── Sheet (side drawer) ────────────────────────────────────────────────── */
export const Sheet = D.Root;
export const SheetTrigger = D.Trigger;
export function SheetContent({
  className,
  children,
  title,
  description,
  side = "right",
  ...props
}: React.ComponentProps<typeof D.Content> & { title: React.ReactNode; description?: React.ReactNode; side?: "right" | "left" }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-[rgb(10_11_13/0.32)] data-[state=open]:animate-[fade-in_160ms]" />
      <D.Content
        className={cn(
          "fixed inset-y-0 z-50 flex w-full max-w-[min(100vw,30rem)] flex-col border-border bg-surface shadow-e3 outline-none",
          side === "right" ? "right-0 border-l data-[state=open]:animate-[sheet-in-right_260ms_var(--ease-out-quart)]" : "left-0 border-r data-[state=open]:animate-[sheet-in-left_260ms_var(--ease-out-quart)]",
          className,
        )}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="grid gap-0.5">
            <D.Title className="text-[15px] font-semibold tracking-tight">{title}</D.Title>
            <D.Description className={cn("text-[13px] text-muted", !description && "sr-only")}>{description ?? "Panel"}</D.Description>
          </div>
          <D.Close className="rounded-sm p-1 text-subtle hover:bg-surface-2 hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>
      </D.Content>
    </D.Portal>
  );
}

/* ── Popover / HoverCard ────────────────────────────────────────────────── */
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export function PopoverContent({ className, align = "start", sideOffset = 6, ...props }: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content align={align} sideOffset={sideOffset} className={cn(panel, anim, "w-72 p-3", className)} {...props} />
    </P.Portal>
  );
}

export const HoverCard = HC.Root;
export const HoverCardTrigger = HC.Trigger;
export function HoverCardContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof HC.Content>) {
  return (
    <HC.Portal>
      <HC.Content sideOffset={sideOffset} className={cn(panel, anim, "w-80 p-3", className)} {...props} />
    </HC.Portal>
  );
}

/* ── Tooltip ────────────────────────────────────────────────────────────── */
export const TooltipProvider = T.Provider;
export function Tooltip({
  content,
  children,
  side = "top",
  delay,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  delay?: number;
}) {
  if (!content) return <>{children}</>;
  return (
    <T.Root delayDuration={delay}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className="z-[60] max-w-xs rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg shadow-e2 data-[state=delayed-open]:animate-[fade-in_120ms]"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

/* ── Dropdown ───────────────────────────────────────────────────────────── */
export const Dropdown = DM.Root;
export const DropdownTrigger = DM.Trigger;
export const DropdownGroup = DM.Group;
export const DropdownSub = DM.Sub;
export const DropdownRadioGroup = DM.RadioGroup;

export function DropdownContent({ className, sideOffset = 6, align = "end", ...props }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content sideOffset={sideOffset} align={align} className={cn(panel, anim, "min-w-48 p-1", className)} {...props} />
    </DM.Portal>
  );
}

const item =
  "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] text-fg outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-subtle";

export function DropdownItem({ className, danger, ...props }: React.ComponentProps<typeof DM.Item> & { danger?: boolean }) {
  return <DM.Item className={cn(item, danger && "text-notmet-fg [&_svg]:text-notmet", className)} {...props} />;
}
export function DropdownRadioItem({ className, children, ...props }: React.ComponentProps<typeof DM.RadioItem>) {
  return (
    <DM.RadioItem className={cn(item, "pl-7", className)} {...props}>
      <DM.ItemIndicator className="absolute left-2 flex size-3.5 items-center justify-center">
        <span className="size-1.5 rounded-full bg-brand" />
      </DM.ItemIndicator>
      {children}
    </DM.RadioItem>
  );
}
export function DropdownLabel({ className, ...props }: React.ComponentProps<typeof DM.Label>) {
  return <DM.Label className={cn("px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-subtle", className)} {...props} />;
}
export function DropdownSeparator({ className, ...props }: React.ComponentProps<typeof DM.Separator>) {
  return <DM.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}
export function DropdownSubTrigger({ className, ...props }: React.ComponentProps<typeof DM.SubTrigger>) {
  return <DM.SubTrigger className={cn(item, "data-[state=open]:bg-surface-2", className)} {...props} />;
}
export function DropdownSubContent({ className, ...props }: React.ComponentProps<typeof DM.SubContent>) {
  return (
    <DM.Portal>
      <DM.SubContent className={cn(panel, anim, "min-w-40 p-1", className)} {...props} />
    </DM.Portal>
  );
}
