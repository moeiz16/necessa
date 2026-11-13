import Link from "next/link";
import { LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="bg-grid flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <LogoMark size={40} className="text-brand" />
      <p className="mt-8 font-mono text-xs uppercase tracking-[0.2em] text-subtle">404 · criterion not found</p>
      <h1 className="mt-3 font-display text-5xl tracking-tight text-fg">This page isn’t documented.</h1>
      <p className="mt-3 max-w-md text-sm text-muted">The link may be outdated, or the record was archived. Absence of evidence isn’t evidence of absence — but in this case, it really isn’t here.</p>
      <div className="mt-8 flex gap-2">
        <Button asChild variant="primary">
          <Link href="/dashboard">Go to dashboard</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </main>
  );
}
