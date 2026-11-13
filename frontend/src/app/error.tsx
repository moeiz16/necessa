"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-notmet-soft text-notmet">
        <TriangleAlert className="size-5" />
      </span>
      <h1 className="mt-5 text-xl font-semibold tracking-tight text-fg">Something went wrong</h1>
      <p className="mt-2 max-w-md text-sm text-muted">
        The error was logged with a correlation ID. Nothing you entered was lost — try again, and if it keeps happening, share the reference below with support.
      </p>
      {error.digest ? <code className="mt-3 rounded-md bg-surface-2 px-2 py-1 font-mono text-xs text-muted">ref {error.digest}</code> : null}
      <Button className="mt-6" variant="primary" onClick={reset}>
        <RotateCcw />
        Try again
      </Button>
    </main>
  );
}
