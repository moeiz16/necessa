import Link from "next/link";
import { LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <LogoMark size={36} className="text-brand" />
      <h1 className="mt-8 text-3xl font-semibold tracking-[-0.02em] text-fg">We can’t find that page.</h1>
      <p className="mt-3 max-w-md text-sm text-muted">The link may be out of date, or the record may have been removed.</p>
      <div className="mt-8 flex gap-2">
        <Button asChild variant="primary">
          <Link href="/dashboard">Go to home</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">Back to the website</Link>
        </Button>
      </div>
    </main>
  );
}
