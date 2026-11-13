import { CircleAlert, CircleCheck, Quote, ScrollText, ShieldCheck, UserCheck } from "lucide-react";

/** Quiet, static side panel for the sign-in screens. */
export function AuthAside() {
  return (
    <aside className="hidden border-l border-border bg-surface lg:block" aria-hidden>
      <div className="flex h-full flex-col justify-center px-14 xl:px-20">
        <div className="grid max-w-md gap-3">
          <div className="rounded-lg border border-border bg-bg p-4">
            <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <CircleCheck className="size-4 text-met" /> Imaging consistent with symptoms
              <span className="ml-auto text-[12px] font-medium text-met-fg">Met</span>
            </div>
            <p className="mt-2 flex gap-2 text-[12.5px] leading-relaxed text-muted">
              <Quote className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <mark className="mark-evidence text-fg">L5-S1 disc protrusion contacting the descending right S1 nerve root</mark>, in line with the stated symptoms.
              </span>
            </p>
            <p className="mt-2 flex items-center gap-1 text-[11px] text-subtle">
              MRI lumbar spine · Aug 30 · <ShieldCheck className="size-3 text-met" /> Quote verified
            </p>
          </div>
          <div className="rounded-lg border border-border bg-bg p-4">
            <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
              <CircleAlert className="size-4 text-insufficient" /> No active infection
              <span className="ml-auto text-[12px] font-medium text-insufficient-fg">Needs documentation</span>
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-muted">Not documented. Anything missing from the chart is never counted as met.</p>
          </div>
        </div>
        <p className="mt-12 max-w-md text-3xl font-semibold leading-[1.15] tracking-[-0.02em] text-fg">Every result shows the policy and the chart.</p>
        <p className="mt-3 max-w-md text-[14px] leading-relaxed text-muted">
          Necessa helps your team submit complete prior authorizations, and leaves every decision with the people accountable for it.
        </p>
        <ul className="mt-8 grid max-w-md gap-2.5 text-[13px] text-muted">
          {[
            [ShieldCheck, "Patient information is masked by default"],
            [UserCheck, "A clinician signs off before anything is sent"],
            [ScrollText, "Every action is recorded in an audit trail"],
          ].map(([Icon, t]) => {
            const I = Icon as typeof ShieldCheck;
            return (
              <li key={t as string} className="flex items-center gap-2.5">
                <I className="size-4 text-met" />
                {t as string}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
