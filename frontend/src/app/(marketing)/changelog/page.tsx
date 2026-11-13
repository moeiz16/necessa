import type { Metadata } from "next";

export const metadata: Metadata = { title: "Changelog" };

const ENTRIES = [
  {
    date: "November 2026",
    version: "0.9",
    title: "Denial-to-criteria mapping and appeal drafting",
    items: [
      "Paste or upload a denial notice — CARC/RARC codes and reason text map to the criteria they cite.",
      "Redetermination letters draft from verified evidence with footnoted citations.",
      "Denials & appeals pipeline with deadline tracking.",
    ],
  },
  {
    date: "October 2026",
    version: "0.8",
    title: "Retrieval inspector and corrective retrieval",
    items: [
      "See intent, strategy, filters, retrievers and per-stage scores for every answer.",
      "Bounded corrective loop (rewrite → expand → relax one filter) before abstaining.",
      "Entity-guarded semantic cache — “with contrast” never matches “without contrast”.",
    ],
  },
  {
    date: "September 2026",
    version: "0.7",
    title: "Criteria compiler with cross-model verification",
    items: [
      "Policies compile into AND / OR / N-of-M criteria trees with verbatim source spans.",
      "A second model family verifies each tree; disagreements go to a reviewer queue.",
      "Negative attestations can never be satisfied by absence of evidence.",
    ],
  },
  {
    date: "August 2026",
    version: "0.6",
    title: "Blue/green policy indexes",
    items: ["Weekly CMS refreshes re-embed only changed sections.", "Atomic alias switch with smoke evaluation and one-click rollback."],
  },
];

export default function ChangelogPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-20">
      <h1 className="font-display text-5xl tracking-tight text-fg">Changelog</h1>
      <p className="mt-3 text-[15px] text-muted">What shipped, and why it matters for documentation quality.</p>
      <ol className="mt-14 grid gap-12 border-l border-border pl-6">
        {ENTRIES.map((e) => (
          <li key={e.version} className="relative">
            <span className="absolute -left-[29px] top-1.5 size-2.5 rounded-full border-2 border-bg bg-brand" />
            <p className="text-xs text-subtle">
              {e.date} · v{e.version}
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-fg">{e.title}</h2>
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
