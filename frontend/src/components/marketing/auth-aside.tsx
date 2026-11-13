import { CircleAlert, CircleCheck, Quote } from "lucide-react";

export function AuthAside() {
  return (
    <aside className="relative hidden overflow-hidden border-l border-border bg-surface lg:block" aria-hidden>
      <div className="bg-grid absolute inset-0 opacity-60" />
      <div className="absolute -right-32 -top-32 size-[520px] rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--ai-1)_28%,transparent),transparent_65%)]" />
      <div className="absolute -bottom-40 -left-24 size-[460px] rounded-full bg-[radial-gradient(circle,color-mix(in_oklab,var(--ai-3)_20%,transparent),transparent_65%)]" />
      <div className="relative flex h-full flex-col justify-center px-14 xl:px-20">
        <div className="grid max-w-md gap-3">
          <div className="rotate-[-1.5deg] rounded-xl border border-border bg-surface p-4 shadow-e2">
            <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <CircleCheck className="size-4 text-met" /> Imaging consistent with presentation
            </div>
            <p className="mt-2 flex gap-2 text-[12.5px] leading-relaxed text-muted">
              <Quote className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <mark className="mark-evidence">L5-S1 disc protrusion contacting the descending right S1 nerve root</mark>, concordant with the stated radiculopathy.
              </span>
            </p>
            <p className="mt-2 text-[11px] text-subtle">MRI lumbar spine · 08/30/2026 · verified verbatim</p>
          </div>
          <div className="ml-10 rotate-[1deg] rounded-xl border border-border bg-surface p-4 shadow-e3">
            <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <CircleAlert className="size-4 text-insufficient" /> No active infection (attestation)
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">Not documented. Absence of evidence isn’t treated as met.</p>
            <p className="mt-2 rounded-md bg-insufficient-soft px-2 py-1.5 text-[12px] text-insufficient-fg">Suggested fix: add a signed pre-procedure attestation.</p>
          </div>
        </div>
        <p className="mt-14 max-w-md font-display text-[34px] leading-[1.1] tracking-tight text-fg">Every verdict cites the policy and the chart.</p>
        <p className="mt-3 max-w-md text-[14px] text-muted">Necessa helps your team submit complete, defensible prior authorizations — and leaves every decision with the people accountable for it.</p>
      </div>
    </aside>
  );
}
