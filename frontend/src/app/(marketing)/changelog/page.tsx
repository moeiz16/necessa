import type { Metadata } from "next";

export const metadata: Metadata = { title: "What’s new" };

const ENTRIES = [
  {
    date: "November 2026",
    title: "Denials and appeals in one place",
    items: [
      "Add a denial letter and see which policy requirement each reason points to.",
      "Appeal letters are drafted from the chart, cite their sources, and wait for clinician sign-off.",
      "A denials board tracks every appeal deadline.",
    ],
  },
  {
    date: "October 2026",
    title: "Answers with sources",
    items: [
      "Ask Necessa a question about a policy and get an answer that links to the exact policy wording.",
      "Each answer shows the sources behind it and the policy version in effect on the date you choose.",
      "Questions about your own cases, such as the most common gaps this month, are answered as simple tables and charts.",
    ],
  },
  {
    date: "September 2026",
    title: "A clear checklist for every policy",
    items: [
      "Each policy becomes a plain requirements checklist, with the policy’s own wording attached to every item.",
      "Checklists are reviewed by a person before they’re used on a case.",
      "Statements such as “no active infection” always need to be documented, never assumed.",
    ],
  },
  {
    date: "August 2026",
    title: "Policies that stay current",
    items: [
      "Medicare policy updates are picked up weekly, and only what changed is refreshed.",
      "See what changed between versions of a policy, and which open cases it affects.",
    ],
  },
];

export default function ChangelogPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16 sm:py-20">
      <h1 className="text-4xl font-semibold tracking-[-0.025em] text-fg sm:text-5xl">What’s new</h1>
      <p className="mt-3 text-[16px] text-muted">Recent improvements that help your team submit complete requests the first time.</p>
      <ol className="mt-14 grid gap-12 border-l border-border pl-6">
        {ENTRIES.map((e) => (
          <li key={e.title} className="relative">
            <span className="absolute -left-[29px] top-1.5 size-2.5 rounded-full border-2 border-bg bg-border-strong" />
            <p className="text-xs text-subtle">{e.date}</p>
            <h2 className="mt-1 text-lg font-semibold text-fg">{e.title}</h2>
            <ul className="mt-3 grid gap-2 text-[14px] text-muted">
              {e.items.map((i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-subtle" />
                  {i}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
