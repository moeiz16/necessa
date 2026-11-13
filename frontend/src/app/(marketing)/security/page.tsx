import type { Metadata } from "next";
import { CircleCheck } from "lucide-react";

export const metadata: Metadata = { title: "Security & compliance" };

const SECTIONS: { title: string; lead: string; points: string[] }[] = [
  {
    title: "Protected health information",
    lead: "De-identification first, encryption at rest, and the minimum necessary for every call.",
    points: [
      "Charts are de-identified at intake: known identifiers from the patient record and pattern-based identifiers (MRN, member ID, phone, SSN, dates) are tokenized before any model sees them.",
      "Raw text is encrypted at rest with field-level encryption; revealing identifiers requires a permission and writes an audit event.",
      "Every model call carries a data class (PUBLIC, INTERNAL, PHI). The model router refuses PHI-class calls unless the text is de-identified and the destination is on the approved list — in production, only endpoints covered by a BAA.",
      "Minimum necessary: the model receives only the evidence passages for one criterion at a time — never the full chart.",
    ],
  },
  {
    title: "Human-in-the-loop by design",
    lead: "Necessa assists documentation review. It never decides coverage.",
    points: [
      "Outputs describe documentation readiness — Ready, Gaps, Not supported — never approved or denied.",
      "Absence of evidence is not treated as met; negative criteria (e.g. no active infection) require an explicit attestation.",
      "Reviewers override any verdict with a recorded reason. Overrides feed the evaluation set after triage.",
      "Aligned with state laws that prohibit AI as the sole basis for adverse determinations (e.g. WA SB 5395, IA HF 2635) and the transparency expectations of FDA's non-device CDS criteria.",
    ],
  },
  {
    title: "Application security",
    lead: "Controls mapped to OWASP ASVS L2 and the OWASP Top 10 for LLM Applications (2025).",
    points: [
      "Argon2id passwords, short-lived access tokens, rotating refresh tokens with reuse detection, and TOTP MFA (enforceable per organization).",
      "Role-based access with tenant isolation enforced server-side and by Postgres row-level security; vector search filters are injected by the server, never the client.",
      "Prompt-injection screening on every upload and retrieved passage; suspicious documents are quarantined and excluded from evidence.",
      "Strict output schemas, verbatim citation validation and an allowlisted, read-only SQL sandbox for analytics questions.",
      "Token budgets, recursion limits, timeouts and circuit breakers prevent runaway agent loops and unbounded consumption.",
    ],
  },
  {
    title: "Auditability",
    lead: "Every decision can be reconstructed.",
    points: [
      "Hash-chained, append-only audit log of views, reveals, evaluations, overrides, letters and exports — verifiable from the admin console.",
      "Each verdict stores the policy version, criteria-set version, retrieved chunk IDs, models and prompt versions used.",
      "Policy indexes are versioned with blue/green aliases; any answer can be replayed against the index that produced it.",
    ],
  },
  {
    title: "Licensing & data sources",
    lead: "Public data, used responsibly.",
    points: [
      "Coverage policies come from the public CMS Medicare Coverage Database; downloads require accepting AMA/ADA/AHA terms, and that content is never redistributed.",
      "CPT® descriptors are not shipped; HCPCS Level II and ICD-10-CM code sets are public domain.",
      "Development and the public demo use synthetic patients only.",
    ],
  },
];

export default function SecurityPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-20">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">Trust center</p>
      <h1 className="mt-3 font-display text-5xl tracking-tight text-fg">Security & compliance</h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
        Necessa is engineered for HIPAA-aligned workflows: privacy controls in every layer, humans in control, and an audit trail for everything the system suggests. This page is an engineering overview, not legal advice.
      </p>
      <div className="mt-6 flex flex-wrap gap-2 text-xs">
        {["De-identification at intake", "Field-level encryption", "Hash-chained audit log", "RBAC + tenant isolation", "No coverage decisions"].map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-muted">
            <CircleCheck className="size-3.5 text-met" />
            {t}
          </span>
        ))}
      </div>
      <p className="mt-6 rounded-lg border border-border bg-surface-2/60 px-4 py-3 text-[13px] text-muted">
        Necessa has not been audited for HIPAA or SOC 2 compliance. The public demo runs on synthetic data; any real deployment needs Business Associate Agreements with every service that touches PHI.
      </p>
      <div className="mt-14 grid gap-12">
        {SECTIONS.map((s) => (
          <section key={s.title} className="grid gap-4 border-t border-border pt-10 first:border-0 first:pt-0 md:grid-cols-[240px_1fr]">
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight text-fg">{s.title}</h2>
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
