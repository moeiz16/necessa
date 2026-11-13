"use client";

import { ChevronDown } from "lucide-react";
import { Accordion as A } from "radix-ui";

export function Faq({ items }: { items: { q: string; a: React.ReactNode }[] }) {
  return (
    <A.Root type="single" collapsible className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface">
      {items.map((it, i) => (
        <A.Item key={it.q} value={`q${i}`} className="group">
          <A.Header>
            <A.Trigger className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-[15px] font-medium text-fg outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2">
              {it.q}
              <ChevronDown className="size-4 shrink-0 text-subtle transition-transform duration-200 ease-out group-data-[state=open]:rotate-180" />
            </A.Trigger>
          </A.Header>
          <A.Content className="overflow-hidden data-[state=closed]:animate-[accordion-up_180ms_var(--ease-out)] data-[state=open]:animate-[accordion-down_220ms_var(--ease-out)]">
            <div className="px-5 pb-5 text-[14px] leading-relaxed text-muted">{it.a}</div>
          </A.Content>
        </A.Item>
      ))}
    </A.Root>
  );
}
