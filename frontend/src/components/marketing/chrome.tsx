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
  ["How it works", "/#how"],
  ["Architecture", "/#architecture"],
  ["Security", "/security"],
  ["FAQ", "/#faq"],
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
    <header className={cn("sticky top-0 z-40 border-b bg-bg/80 backdrop-blur-md transition-colors duration-200", scrolled ? "border-border" : "border-transparent")}>
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
            <D.Overlay className="fixed inset-0 z-50 bg-[rgb(10_11_13/0.4)] data-[state=open]:animate-[fade-in_140ms] data-[state=closed]:animate-[fade-out_140ms]" />
            <D.Content
              aria-describedby={undefined}
              className="fixed inset-x-3 top-3 z-50 rounded-2xl border border-border bg-surface p-4 shadow-e3 outline-none data-[state=open]:animate-[scale-in_180ms_var(--ease-out)] data-[state=closed]:animate-[scale-out_120ms_var(--ease-out)]"
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
                  <Link key={href} href={href} onClick={() => setOpen(false)} className="rounded-lg px-2 py-2.5 text-[15px] text-fg hover:bg-surface-2">
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
    <footer className="border-t border-border bg-surface/40">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div className="grid content-start gap-4">
          <Logo />
          <p className="max-w-xs text-[13px] leading-relaxed text-muted">Medical-necessity intelligence for prior authorization and denial appeals teams. Every verdict cites the policy and the chart.</p>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] text-muted">
            <ShieldCheck className="size-3.5 text-met" /> Synthetic data in the demo · humans decide
          </span>
        </div>
        {[
          { h: "Product", l: [["Product tour", "/#product"], ["How it works", "/#how"], ["Architecture", "/#architecture"], ["Live demo", "/login?demo=1"]] },
          { h: "Trust", l: [["Security overview", "/security"], ["FAQ", "/#faq"], ["Changelog", "/changelog"]] },
          { h: "Account", l: [["Sign in", "/login"], ["Create account", "/signup"], ["Source code", "https://github.com/moeiz16/necessa"]] },
        ].map((c) => (
          <div key={c.h} className="grid content-start gap-2.5 text-[13px]">
            <p className="font-medium text-fg">{c.h}</p>
            {c.l.map(([label, href]) =>
              href!.startsWith("http") ? (
                <a key={label} href={href} target="_blank" rel="noreferrer" className="text-muted transition-colors hover:text-fg">
                  {label}
                </a>
              ) : (
                <Link key={label} href={href!} className="text-muted transition-colors hover:text-fg">
                  {label}
                </Link>
              ),
            )}
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-6xl px-5 py-6 text-xs leading-relaxed text-subtle">
          Necessa supports documentation review. It does not make coverage determinations, predict payer decisions or provide medical advice; a licensed professional reviews every output. The demo uses synthetic patients only. Policy identifiers reference the public CMS Medicare Coverage Database; excerpts are paraphrased for illustration. CPT® is a registered trademark of the American Medical Association. © {new Date().getFullYear()} Necessa.
        </p>
      </div>
    </footer>
  );
}
