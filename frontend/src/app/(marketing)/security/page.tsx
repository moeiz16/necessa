import type { Metadata } from "next";
import { CircleCheck } from "lucide-react";

export const metadata: Metadata = {
  title: "Security & compliance",
  description: "How Necessa protects patient information, controls access, records every action and keeps a clinician in charge.",
};

const SECTIONS: { title: string; lead: string; points: string[] }[] = [
  {
    title: "Protecting patient information",
    lead: "Identifiers are masked by default and shared only when needed.",
    points: [
      "Names, dates of birth, member IDs, phone numbers and other identifiers are masked when a chart is added.",
      "Sensitive fields are encrypted. Showing an identifier requires the right permission and a stated reason, and the access is recorded.",
      "Necessa works with only the part of the chart relevant to each requirement, never the whole record at once.",
      "Letters are prepared with placeholders for patient details and filled in only when an authorized person opens or exports them.",
    ],
  },
  {
    title: "A person is always in charge",
    lead: "Necessa assists with documentation. It never decides coverage.",
    points: [
      "Results describe documentation readiness (ready, gaps found, or not supported). They never say approved or denied.",
      "If something isn’t documented, it isn’t counted as met. Statements such as “no active infection” need to be documented explicitly.",
      "Reviewers can change any result, with a recorded reason. Letters need a clinician’s review and approval before they are exported.",
      "Designed with state laws in mind that prohibit software from being the sole basis for a coverage denial.",
    ],
  },
  {
    title: "Access control and account security",
    lead: "People see only what their role requires.",
    points: [
      "Role-based access: coordinators, clinicians, reviewers, revenue-cycle managers, auditors and administrators each have their own permissions.",
      "Each organization’s information is kept separate from every other organization’s.",
      "Strong password protection, automatic session expiry, and an optional second verification step that your organization can require.",
      "Uploaded documents are screened, and anything suspicious is held back from the review.",
    ],
  },
  {
    title: "A record of everything",
    lead: "Every action can be reconstructed.",
    points: [
      "Views, reveals, reviews, changes, approvals and exports are logged with who, what and when.",
      "The log is tamper-evident, and an administrator can verify it at any time from the Compliance page.",
      "Each result keeps the policy version it was checked against, so it can be explained later.",
    ],
  },
  {
    title: "Policies and data sources",
    lead: "Public information, used responsibly.",
    points: [
      "Coverage policies come from the public Medicare Coverage Database and are kept up to date; the version in effect on the date of service is the one applied.",
      "Necessa does not distribute copyrighted procedure-code descriptions.",
      "The public demo uses made-up patients only.",
    ],
  },
];

export default function SecurityPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-16 sm:py-20">
      <p className="text-[13px] font-medium text-muted">Trust center</p>
      <h1 className="mt-2 text-4xl font-semibold tracking-[-0.025em] text-fg sm:text-5xl">Security & compliance</h1>
      <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-muted">
        Necessa is designed with HIPAA-aligned safeguards: patient information is protected, access is controlled, every action is recorded, and a person always makes the decision. This page is an overview, not legal advice.
      </p>
      <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-3 text-[13px] leading-relaxed text-muted">
        <span className="font-medium text-fg">An honest note.</span> Necessa does not hold a HIPAA or SOC 2 certification or audit report. The demo runs on made-up patient data. Before using real patient information, your organization will need the appropriate agreements with every service involved, and your compliance team should review the setup.
      </p>
      <div className="mt-14 grid gap-12">
        {SECTIONS.map((s) => (
          <section key={s.title} className="grid gap-4 border-t border-border pt-10 first:border-0 first:pt-0 md:grid-cols-[240px_1fr]">
            <div>
              <h2 className="text-[15px] font-semibold text-fg">{s.title}</h2>
              <p className="mt-1 text-[13px] text-muted">{s.lead}</p>
            </div>
            <ul className="grid gap-3">
              {s.points.map((p) => (
                <li key={p} className="flex gap-3 text-[14px] leading-relaxed text-fg">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-met" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
