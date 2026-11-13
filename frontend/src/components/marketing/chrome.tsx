"use client";

import { ArrowRight, Menu, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { Dialog as D } from "radix-ui";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

const LINKS: [string, string][] = [
  ["Product", "/#product"],
  ["Use cases", "/#use-cases"],
  ["Security & compliance", "/security"],
  ["What’s new", "/changelog"],
];

export function MarketingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={cn("sticky top-0 z-40 border-b bg-bg transition-colors duration-150", scrolled ? "border-border" : "border-transparent")}>
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
        <Link href="/" aria-label="Necessa home" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-5 text-[13px] text-muted md:flex" aria-label="Marketing">
          {LINKS.map(([label, href]) => (
            <Link key={href} href={href} className="transition-colors hover:text-fg">
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-2 sm:flex">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild variant="primary" size="sm">
            <Link href="/login?demo=1">
              Explore the demo
              <ArrowRight />
            </Link>
          </Button>
        </div>
        <D.Root open={open} onOpenChange={setOpen}>
          <D.Trigger asChild>
            <Button variant="ghost" size="icon" className="ml-auto sm:hidden" aria-label="Open menu">
              <Menu />
            </Button>
          </D.Trigger>
          <D.Portal>
            <D.Overlay className="fixed inset-0 z-50 bg-[rgb(10_10_10/0.32)] data-[state=open]:animate-[fade-in_150ms] data-[state=closed]:animate-[fade-out_120ms]" />
            <D.Content
              aria-describedby={undefined}
              className="fixed inset-x-3 top-3 z-50 rounded-lg border border-border bg-surface p-4 shadow-e3 outline-none data-[state=open]:animate-[scale-in_180ms_var(--ease-out)] data-[state=closed]:animate-[scale-out_120ms_var(--ease-out)]"
            >
              <div className="flex items-center justify-between">
                <D.Title asChild>
                  <span>
                    <Logo />
                  </span>
                </D.Title>
                <D.Close className="rounded-md p-1.5 text-subtle hover:bg-surface-2 hover:text-fg" aria-label="Close menu">
                  <X className="size-4" />
                </D.Close>
              </div>
              <nav className="mt-4 grid" aria-label="Marketing">
                {LINKS.map(([label, href]) => (
                  <Link key={href} href={href} onClick={() => setOpen(false)} className="rounded-md px-2 py-2.5 text-[15px] text-fg hover:bg-surface-2">
                    {label}
                  </Link>
                ))}
              </nav>
              <div className="mt-4 grid gap-2">
                <Button asChild variant="primary" size="lg">
                  <Link href="/login?demo=1" onClick={() => setOpen(false)}>
                    Explore the demo <ArrowRight />
                  </Link>
                </Button>
                <Button asChild variant="secondary" size="lg">
                  <Link href="/login" onClick={() => setOpen(false)}>
                    Sign in
                  </Link>
                </Button>
              </div>
            </D.Content>
          </D.Portal>
        </D.Root>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div className="grid content-start gap-4">
          <Logo />
          <p className="max-w-xs text-[13px] leading-relaxed text-muted">
            Prior authorization and denial appeals, ready the first time. Necessa checks each case against the payer’s policy and leaves every decision with your team.
          </p>
          <span className="inline-flex w-fit items-center gap-1.5 text-[12px] text-muted">
            <ShieldCheck className="size-3.5 text-met" /> Sample data only in the demo
          </span>
        </div>
        {[
          { h: "Product", l: [["Product tour", "/#product"], ["Use cases", "/#use-cases"], ["Insights for leaders", "/#insights"], ["Explore the demo", "/login?demo=1"]] },
          { h: "Trust", l: [["Security & compliance", "/security"], ["Questions", "/#faq"], ["What’s new", "/changelog"]] },
          { h: "Account", l: [["Sign in", "/login"], ["Create an account", "/signup"]] },
        ].map((c) => (
          <div key={c.h} className="grid content-start gap-2.5 text-[13px]">
            <p className="font-medium text-fg">{c.h}</p>
            {c.l.map(([label, href]) => (
              <Link key={label} href={href!} className="text-muted transition-colors hover:text-fg">
                {label}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-6xl px-5 py-6 text-xs leading-relaxed text-subtle">
          Necessa supports documentation review. It does not make coverage decisions, predict payer outcomes or provide medical or legal advice, and a licensed professional reviews every output. Necessa is designed with HIPAA-aligned safeguards; it is not a certification, and your organization remains responsible for its own compliance program and for the agreements required before real patient data is used. The demo uses made-up patients and references public Medicare coverage policies. CPT® is a registered trademark of the American Medical Association. © {new Date().getFullYear()} Necessa.
        </p>
      </div>
    </footer>
  );
}
