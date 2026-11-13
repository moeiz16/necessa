"use client";

import { CircleAlert, CircleCheck, FileText, Quote, ShieldCheck, UserCheck } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

type TabId = "check" | "evidence" | "letter";

const TABS: { id: TabId; title: string; body: string }[] = [
  {
    id: "check",
    title: "See what is missing",
    body: "Every requirement in the payer’s policy is listed with its status, so gaps surface before submission, not after a denial.",
  },
  {
    id: "evidence",
    title: "Check the evidence",
    body: "The policy’s exact wording sits next to the supporting text from the chart. Reviewers see why each result was reached.",
  },
  {
    id: "letter",
    title: "Prepare the letter",
    body: "Request and appeal letters are drafted from verified facts, cite their sources, and wait for a clinician to review and sign.",
  },
];

function CheckPanel() {
  const gaps = [
    { title: "Conservative care for at least 4 weeks", fix: "Add physical therapy dates and outcome. The policy asks for 4 weeks of documented care." },
    { title: "No active infection", fix: "Add a signed pre-procedure statement. Silence in the chart is never counted as met." },
  ];
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-3 divide-x divide-border rounded-md border border-border text-center">
        {[
          ["4", "Met"],
          ["2", "Need documentation"],
          ["0", "Not met"],
        ].map(([n, l]) => (
          <div key={l} className="px-2 py-3">
            <p className="tabular text-xl font-semibold text-fg">{n}</p>
            <p className="text-[11px] text-muted">{l}</p>
          </div>
        ))}
      </div>
      <ul className="grid gap-2.5">
        {gaps.map((g) => (
          <li key={g.title} className="flex gap-3 rounded-md border border-border p-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-insufficient" />
            <div className="grid gap-0.5">
              <p className="text-[13px] font-medium text-fg">{g.title}</p>
              <p className="text-[13px] leading-relaxed text-muted">{g.fix}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EvidencePanel() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-md border border-border p-3.5">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-subtle">
          <FileText className="size-3" /> The policy says
        </p>
        <p className="mt-2 flex gap-2 text-[13px] leading-relaxed text-fg">
          <Quote className="mt-0.5 size-3.5 shrink-0 text-subtle" />
          <span>
            <mark className="mark-policy">Imaging should be consistent with the clinical presentation</mark> before the procedure is performed.
          </span>
        </p>
        <p className="mt-2 text-[11px] text-subtle">Medicare LCD L36920 · Indications</p>
      </div>
      <div className="rounded-md border border-border p-3.5">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-subtle">
          <FileText className="size-3" /> The chart shows
        </p>
        <p className="mt-2 flex gap-2 text-[13px] leading-relaxed text-fg">
          <Quote className="mt-0.5 size-3.5 shrink-0 text-subtle" />
          <span>
            MRI lumbar spine: <mark className="mark-evidence">L5-S1 disc protrusion contacting the descending right S1 nerve root</mark>, concordant with the stated radiculopathy.
          </span>
        </p>
        <p className="mt-2 flex items-center gap-1 text-[11px] text-subtle">
          Radiology report · Aug 30 · <ShieldCheck className="size-3 text-met" /> Quote verified
        </p>
      </div>
      <p className="flex items-center gap-2 text-[13px] text-met-fg md:col-span-2">
        <CircleCheck className="size-4" /> Met. Reviewed against the policy text and double-checked.
      </p>
    </div>
  );
}

function LetterPanel() {
  return (
    <div className="grid gap-3">
      <div className="rounded-md border border-border p-4">
        <p className="text-[12px] text-subtle">Letter of medical necessity · Draft</p>
        <p className="mt-2 text-[13px] leading-[1.7] text-fg">
          Mr. [Patient] has had right-sided radicular pain for more than three months. MRI on August 30 showed an L5-S1 disc protrusion contacting the right S1 nerve root
          <sup className="ml-0.5 text-muted">1</sup>. His Oswestry Disability Index was 46%, consistent with severe limitation<sup className="ml-0.5 text-muted">2</sup>. A transforaminal injection with image guidance is requested.
        </p>
        <ol className="mt-3 grid gap-0.5 border-t border-border pt-2.5 text-[11.5px] text-subtle">
          <li>1 · Radiology report, Aug 30</li>
          <li>2 · Progress note, Oct 28</li>
        </ol>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3.5 py-2.5">
        <span className="flex items-center gap-2 text-[13px] text-muted">
          <UserCheck className="size-4" /> Waiting for clinician review and signature
        </span>
        <span className="rounded-md bg-brand px-2.5 py-1 text-[12px] font-medium text-brand-contrast">Review and sign</span>
      </div>
    </div>
  );
}

/** Manual (click-to-select) tour. Nothing animates on its own. Sample data only. */
export function ProductTour() {
  const [tab, setTab] = useState<TabId>("check");
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] lg:gap-10">
      <div role="tablist" aria-label="Product tour" className="grid content-start gap-1">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              role="tab"
              id={`tour-tab-${t.id}`}
              aria-selected={active}
              aria-controls={`tour-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              className={cn(
                "rounded-md border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/30",
                active ? "border-border bg-surface" : "border-transparent hover:bg-surface-2/70",
              )}
            >
              <span className={cn("block text-[14px] font-medium", active ? "text-fg" : "text-muted")}>{t.title}</span>
              {active ? <span className="mt-1 block text-[13px] leading-relaxed text-muted">{t.body}</span> : null}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`tour-panel-${tab}`} aria-labelledby={`tour-tab-${tab}`} className="min-w-0 rounded-lg border border-border bg-surface p-4 sm:p-5">
        {tab === "check" ? <CheckPanel /> : tab === "evidence" ? <EvidencePanel /> : <LetterPanel />}
        <p className="mt-4 text-[11px] text-subtle">Sample data</p>
      </div>
    </div>
  );
}
