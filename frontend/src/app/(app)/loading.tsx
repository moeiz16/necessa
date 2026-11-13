import { Skeleton } from "@/components/ui/display";

/** Route-level loading frame: mirrors the common page layout (header, KPI row, content) to avoid layout shift. */
export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy="true" aria-label="Loading">
      <div className="flex h-14 items-center gap-3 border-b border-border px-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="ml-auto hidden h-8 w-72 rounded-md sm:block" />
        <Skeleton className="size-7 rounded-full" />
      </div>
      <div className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-3 h-7 w-72 max-w-full" />
        <Skeleton className="mt-2 h-4 w-[28rem] max-w-full" />
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl bg-surface p-4 shadow-e1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-4 h-7 w-16" />
              <Skeleton className="mt-2 h-3 w-28" />
            </div>
          ))}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
          <div className="rounded-xl bg-surface p-4 shadow-e1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border/60 py-3 last:border-0">
                <Skeleton className="size-8 rounded-full" />
                <div className="grid flex-1 gap-1.5">
                  <Skeleton className="h-3.5 w-1/2" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
                <Skeleton className="h-5 w-20 rounded-md" />
              </div>
            ))}
          </div>
          <Skeleton className="h-80 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
