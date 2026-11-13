import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export function MarketingNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
        <Link href="/" aria-label="Necessa home">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-5 text-[13px] text-muted md:flex" aria-label="Marketing">
          <Link href="/#how" className="hover:text-fg">
            How it works
          </Link>
          <Link href="/#architecture" className="hover:text-fg">
            Architecture
          </Link>
          <Link href="/security" className="hover:text-fg">
            Security
          </Link>
          <Link href="/changelog" className="hover:text-fg">
            Changelog
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild variant="primary" size="sm">
            <Link href="/login?demo=1">Explore the demo</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="grid content-start gap-3">
          <Logo />
          <p className="max-w-xs text-[13px] text-muted">Medical-necessity intelligence for prior authorization and denial appeals teams.</p>
        </div>
        {[
          { h: "Product", l: [["How it works", "/#how"], ["Architecture", "/#architecture"], ["Live demo", "/login?demo=1"]] },
          { h: "Trust", l: [["Security & compliance", "/security"], ["Changelog", "/changelog"]] },
          { h: "Account", l: [["Sign in", "/login"], ["Create account", "/signup"]] },
        ].map((c) => (
          <div key={c.h} className="grid content-start gap-2 text-[13px]">
            <p className="font-medium text-fg">{c.h}</p>
            {c.l.map(([label, href]) => (
              <Link key={label} href={href!} className="text-muted hover:text-fg">
                {label}
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-6xl px-5 py-6 text-xs leading-relaxed text-subtle">
          Necessa supports documentation review. It does not make coverage determinations, predict payer decisions or provide medical advice; a licensed professional reviews every output. The demo uses synthetic patients only.
          Policy identifiers reference the public CMS Medicare Coverage Database; excerpts are paraphrased for illustration. CPT® is a registered trademark of the American Medical Association. © {new Date().getFullYear()} Necessa.
        </p>
      </div>
    </footer>
  );
}
