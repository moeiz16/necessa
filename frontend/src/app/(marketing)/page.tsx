import {
  ArrowRight,
  Building2,
  ChartColumn,
  ClipboardCheck,
  FileSignature,
  Gavel,
  Lock,
  ScrollText,
  ShieldCheck,
  Stethoscope,
  UserCheck,
  UsersRound,
  Fingerprint,
} from "lucide-react";
import Link from "next/link";
import { Faq } from "@/components/marketing/faq";
import { HeroVisual } from "@/components/marketing/hero-visual";
import { ProductTour } from "@/components/marketing/product-tour";
import { Button } from "@/components/ui/button";

const STATS = [
  { value: "~40", label: "prior authorizations per physician, every week" },
  { value: "~13 hours", label: "of physician and staff time spent on them weekly" },
  { value: "40%", label: "of physicians employ staff who work only on prior authorization" },
  { value: "72 h · 7 days", label: "payer decision deadlines (urgent · standard) under CMS-0057-F" },
];

const STEPS = [
  {
    n: "1",
    title: "Add the case",
    body: "Enter the service, diagnosis, payer and date of service, then add the chart notes. Patient identifiers are masked from the start.",
  },
  {
    n: "2",
    title: "See what is missing",
    body: "Necessa finds the policy that applies, checks every requirement, and shows the policy’s wording beside the supporting text in the chart.",
  },
  {
    n: "3",
    title: "Submit with confidence",
    body: "Close the gaps, have your clinician review and sign, and send a complete request or appeal with a letter that cites its sources.",
  },
];

const ROLES = [
  {
    icon: ClipboardCheck,
    role: "Prior-authorization coordinators",
    need: "Catch missing documentation before a request goes out.",
    gives: "A requirements checklist for every case, a prioritized worklist ordered by payer deadline, and clear next steps.",
  },
  {
    icon: Stethoscope,
    role: "Clinicians",
    need: "Spend minutes, not hours, on letters of medical necessity.",
    gives: "Draft letters built from the chart with sources cited, ready to review, edit and sign.",
  },
  {
    icon: Gavel,
    role: "Revenue-cycle managers",
    need: "Understand why requests are denied and win appeals faster.",
    gives: "Denial reasons mapped to the policy requirement behind them, appeal drafts, and deadlines tracked in one place.",
  },
  {
    icon: ScrollText,
    role: "Compliance officers",
    need: "Evidence of who saw what, and who approved it.",
    gives: "A complete audit trail, role-based access, and a clinician sign-off recorded on every submission.",
  },
  {
    icon: Building2,
    role: "Practice leaders",
    need: "Visibility into performance and capacity.",
    gives: "Turnaround against payer deadlines, top documentation gaps, payer mix and staff time saved.",
  },
];

const INSIGHTS = [
  { title: "Turnaround against payer deadlines", body: "See which cases are at risk of missing the 72-hour and 7-day clocks, and where work is piling up." },
  { title: "Top documentation gaps", body: "Find the requirements your team misses most often, and fix them at the source with better templates." },
  { title: "Denial reasons and appeals", body: "Track why requests are denied, which payers and policies drive them, and how appeals turn out." },
  { title: "Staff time saved", body: "Measure hours returned to your team and how many requests are ready on the first pass." },
];

const SAFEGUARDS = [
  { icon: Fingerprint, title: "Patient information is protected", body: "Names, dates of birth, member IDs and other identifiers are masked by default. Showing one is a deliberate action, and it is recorded." },
  { icon: UsersRound, title: "Role-based access", body: "People see only what their role requires: coordinators, clinicians, reviewers, managers and auditors each get their own permissions." },
  { icon: ScrollText, title: "A complete audit trail", body: "Every view, edit, approval and export is logged and tamper-evident, so you can answer who did what, and when." },
  { icon: UserCheck, title: "A person signs off", body: "Nothing is submitted until a clinician has reviewed it. Every result can be changed, with a reason, by your team." },
  { icon: ShieldCheck, title: "Never approves or denies coverage", body: "Necessa reports documentation readiness. The coverage decision stays with the payer, and your team stays in charge." },
  { icon: Lock, title: "Encrypted and access-controlled", body: "Sensitive fields are encrypted, sessions expire, and sign-in supports a second verification step." },
];

const FAQ = [
  {
    q: "Does Necessa decide whether something will be covered?",
    a: "No. Necessa never approves or denies coverage and does not predict payer decisions. It shows whether your documentation meets what the policy asks for, so your team can fix gaps before submitting. Your clinician reviews and signs everything.",
  },
  {
    q: "How is patient information protected?",
    a: "Identifiers are masked by default, access depends on a person’s role, sensitive fields are encrypted, and every action is recorded in an audit trail. The demo uses made-up patients only.",
  },
  {
    q: "Is Necessa HIPAA compliant?",
    a: "Necessa is built with HIPAA-aligned safeguards and is designed to support your obligations. Compliance depends on how it is deployed and the agreements your organization has in place, and we don’t claim any certification. Please involve your compliance team before using real patient data.",
  },
  {
    q: "Which payers and policies does it cover?",
    a: "The demo includes public Medicare coverage policies and illustrative commercial examples. It is built to keep each policy up to date and to apply the version in effect on the date of service.",
  },
  {
    q: "Does it replace our prior-authorization staff?",
    a: "No. It gives them a clear checklist, a prioritized worklist and a first draft of each letter, so they spend their time on judgment calls instead of searching through documents.",
  },
  {
    q: "What do we need to get started?",
    a: "A short list of the payers and services you submit most often, and a few representative cases. Explore the demo first to see how a case moves from gaps to ready.",
  },
];

function Section({ id, eyebrow, title, intro, children, tint }: { id?: string; eyebrow?: string; title: string; intro?: string; children: React.ReactNode; tint?: boolean }) {
  return (
    <section id={id} className={tint ? "border-y border-border bg-surface" : undefined}>
      <div className="mx-auto max-w-6xl scroll-mt-20 px-5 py-20 sm:py-24">
        <div className="max-w-2xl">
          {eyebrow ? <p className="text-[13px] font-medium text-muted">{eyebrow}</p> : null}
          <h2 className="mt-2 text-3xl font-semibold tracking-[-0.02em] text-fg text-balance sm:text-[34px] sm:leading-[1.15]">{title}</h2>
          {intro ? <p className="mt-3 text-[16px] leading-relaxed text-muted text-pretty">{intro}</p> : null}
        </div>
        <div className="mt-10">{children}</div>
      </div>
    </section>
  );
}

export default function MarketingHome() {
  return (
    <>
      {/* Hero */}
      <section>
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-5 pb-20 pt-14 sm:pt-20 lg:grid-cols-[1.02fr_1fr] lg:gap-14 lg:pb-24">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-muted">Prior authorization for clinics and health systems</p>
            <h1 className="mt-4 text-[38px] font-semibold leading-[1.08] tracking-[-0.03em] text-fg text-balance min-[400px]:text-[42px] sm:text-6xl">
              Know what the payer will ask — before they ask.
            </h1>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted text-pretty">
              Necessa checks each case against the payer’s policy before you submit, shows exactly what is missing, and prepares the request or appeal for your clinician to review and sign.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild variant="primary" size="lg">
                <Link href="/login?demo=1">
                  Explore the demo
                  <ArrowRight />
                </Link>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <Link href="/signup">Create an account</Link>
              </Button>
            </div>
            <ul className="mt-8 grid gap-2 text-[13px] text-muted sm:grid-cols-2">
              {["A clinician signs off on everything", "HIPAA-aligned safeguards", "Never approves or denies coverage", "Every action recorded in an audit trail"].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <ShieldCheck className="size-4 shrink-0 text-met" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <HeroVisual />
        </div>
      </section>

      {/* The problem */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-14">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label}>
                <dt className="text-3xl font-semibold tracking-[-0.02em] text-fg sm:text-[34px]">{s.value}</dt>
                <dd className="mt-1.5 max-w-[16rem] text-[14px] leading-snug text-muted">{s.label}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-8 text-xs text-subtle">Sources: AMA 2025 Prior Authorization Physician Survey (fielded December 2025, 1,000 physicians); CMS Interoperability and Prior Authorization Final Rule (CMS-0057-F).</p>
        </div>
      </section>

      {/* How it works */}
      <Section
        id="how"
        eyebrow="How it works"
        title="From a new case to a complete submission in three steps."
        intro="Many delays and denials come down to paperwork: the chart doesn’t show what the policy asks for, or the reviewer can’t find it. Necessa closes that gap before you submit."
      >
        <ol className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-lg border border-border bg-surface p-6">
              <span className="flex size-7 items-center justify-center rounded-full border border-border-strong text-[13px] font-medium text-fg">{s.n}</span>
              <h3 className="mt-4 text-[17px] font-semibold text-fg">{s.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* Product tour */}
      <Section id="product" tint eyebrow="Product" title="See each case the way a reviewer will." intro="A clear checklist, the evidence behind every result, and a letter that is ready for sign-off.">
        <ProductTour />
      </Section>

      {/* Use cases */}
      <Section id="use-cases" eyebrow="Use cases" title="Built around the people who handle prior authorization." intro="Each role gets what they need to do their part, working from the same record.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ROLES.map((r) => (
            <article key={r.role} className="rounded-lg border border-border bg-surface p-6">
              <r.icon className="size-5 text-muted" aria-hidden />
              <h3 className="mt-4 text-[16px] font-semibold text-fg">{r.role}</h3>
              <p className="mt-1.5 text-[14px] text-fg">{r.need}</p>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{r.gives}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* Insights */}
      <Section id="insights" tint eyebrow="Insights for leaders" title="Know how your prior-authorization operation is performing." intro="Business reporting comes built in, so you can manage deadlines, denials and workload without exporting a spreadsheet.">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-start">
          <ul className="grid gap-5">
            {INSIGHTS.map((i) => (
              <li key={i.title} className="flex gap-3">
                <ChartColumn className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <div>
                  <h3 className="text-[15px] font-medium text-fg">{i.title}</h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-muted">{i.body}</p>
                </div>
              </li>
            ))}
          </ul>
          <figure className="m-0 rounded-lg border border-border bg-bg p-5" aria-label="Sample insights: average turnaround by payer type compared with payer deadlines">
            <figcaption className="text-[13px] font-medium text-fg">Average turnaround by payer type</figcaption>
            <p className="text-[12px] text-muted">Hours from case created to ready to submit</p>
            <div className="mt-5 grid gap-3.5">
              {[
                ["Medicare Part B", 31],
                ["Medicare Advantage", 44],
                ["Commercial", 52],
                ["Medicaid", 38],
              ].map(([label, hours]) => (
                <div key={label as string} className="grid grid-cols-[8.5rem_1fr_2.5rem] items-center gap-3 text-[13px]">
                  <span className="truncate text-muted">{label}</span>
                  <span className="h-2 rounded-full bg-surface-3">
                    <span className="block h-2 rounded-full bg-brand" style={{ width: `${(Number(hours) / 72) * 100}%` }} />
                  </span>
                  <span className="tabular text-right text-fg">{hours} h</span>
                </div>
              ))}
            </div>
            <p className="mt-5 border-t border-border pt-3 text-[12px] text-subtle">Urgent payer deadline: 72 hours · Sample data</p>
          </figure>
        </div>
      </Section>

      {/* Security & compliance */}
      <Section
        id="compliance"
        eyebrow="Security & compliance"
        title="Safeguards that support your HIPAA obligations."
        intro="Necessa is designed so that protected health information stays protected, access is controlled, and a person is always accountable."
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {SAFEGUARDS.map((s) => (
            <article key={s.title} className="rounded-lg border border-border bg-surface p-6">
              <s.icon className="size-5 text-met" aria-hidden />
              <h3 className="mt-4 text-[15px] font-semibold text-fg">{s.title}</h3>
              <p className="mt-2 text-[14px] leading-relaxed text-muted">{s.body}</p>
            </article>
          ))}
        </div>
        <div className="mt-6 grid gap-4 rounded-lg border border-border bg-surface p-6 md:grid-cols-[1fr_auto] md:items-center">
          <p className="text-[14px] leading-relaxed text-muted">
            <span className="font-medium text-fg">Why this matters now.</span> Since 2026, many payers must answer within 72 hours (urgent) or 7 days (standard) and give a specific reason for any denial, and a growing number of states require that a licensed clinician, not software, makes the final call on coverage. Necessa is built for that: it prepares the case, and people decide.
          </p>
          <Button asChild variant="secondary">
            <Link href="/security">
              Read the security overview
              <ArrowRight />
            </Link>
          </Button>
        </div>
        <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-subtle">
          <FileSignature className="mt-px size-3.5 shrink-0" aria-hidden />
          Necessa does not hold any compliance certification. Your organization remains responsible for its own compliance program and for the agreements required before real patient data is used.
        </p>
      </Section>

      {/* FAQ */}
      <Section id="faq" tint eyebrow="Questions" title="The things teams ask first.">
        <div className="max-w-3xl">
          <Faq items={FAQ.map((f) => ({ q: f.q, a: f.a }))} />
        </div>
      </Section>

      {/* Final call to action */}
      <section>
        <div className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
          <div className="rounded-lg border border-border bg-surface px-6 py-12 text-center sm:px-12">
            <h2 className="mx-auto max-w-xl text-3xl font-semibold tracking-[-0.02em] text-fg text-balance">See a case go from gaps to ready.</h2>
            <p className="mx-auto mt-3 max-w-lg text-[16px] leading-relaxed text-muted">Explore a complete workspace with made-up patients. No sign-up needed.</p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
              <Button asChild variant="primary" size="lg">
                <Link href="/login?demo=1">
                  Explore the demo
                  <ArrowRight />
                </Link>
              </Button>
              <Button asChild variant="secondary" size="lg">
                <Link href="/signup">Create an account</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
