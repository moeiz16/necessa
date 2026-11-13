import {
  ArrowRight,
  BellRing,
  BookOpen,
  CircleCheck,
  Database,
  FileSignature,
  Fingerprint,
  Gavel,
  GitBranch,
  ClipboardCheck,
  Landmark,
  Stethoscope,
  ChartNoAxesCombined,
  Layers,
  ListChecks,
  Lock,
  Network,
  Radar,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Split,
  Table2,
  UserCheck,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { Faq } from "@/components/marketing/faq";
import { HeroVisual } from "@/components/marketing/hero-visual";
import { ProductTour } from "@/components/marketing/product-tour";
import { Button } from "@/components/ui/button";
import { Reveal, Stagger, StaggerItem } from "@/components/ui/motion";

const STATS = [
  { value: "~40", label: "prior authorizations per physician, every week" },
  { value: "~13 h", label: "of physician and staff time spent on them weekly" },
  { value: "40%", label: "of physicians employ staff dedicated only to prior auth" },
  { value: "72 h · 7 d", label: "payer decision clocks now in force under CMS-0057-F" },
];

const STEPS = [
  {
    icon: ScanSearch,
    title: "Resolve the right policy",
    body: "Service codes, diagnoses, state and date of service resolve deterministically to the version-correct LCD, NCD and Billing & Coding article — no guessing, no stale rules.",
  },
  {
    icon: ListChecks,
    title: "Compile criteria you can audit",
    body: "Each policy becomes an AND / OR / N-of-M tree of atomic criteria. Every criterion carries a verbatim source quote, verified by a second model family and approved by a reviewer.",
  },
  {
    icon: Radar,
    title: "Check the chart, one criterion at a time",
    body: "Per-criterion hybrid retrieval over the de-identified chart. Verdicts are Met, Not met or Insufficient — with quoted evidence, entailment checks and three-valued aggregation.",
  },
  {
    icon: FileSignature,
    title: "Close gaps, then draft",
    body: "Actionable fixes before submission; letters of medical necessity and appeals with footnoted citations, signed off by a clinician. Denials map back to the criteria they cite.",
  },
];

const ASSIST = [
  { icon: Sparkles, title: "Next best actions", body: "Every case shows what to do next — upload, attest, review, draft or submit — ranked by impact." },
  { icon: BookOpen, title: "Live policy matching", body: "While you type codes, Necessa previews the matching policy and the documentation it will ask for." },
  { icon: Gavel, title: "Denial → criteria mapping", body: "Paste a denial notice; CARC/RARC codes and reason text map to the exact criteria to address." },
  { icon: BellRing, title: "Policy change alerts", body: "Weekly CMS refreshes are diffed section by section, and open cases affected by a change are flagged." },
  { icon: Table2, title: "Ask your data", body: "Natural-language analytics over your own cases via guarded text-to-SQL — with the SQL shown." },
  { icon: Layers, title: "Retrieval inspector", body: "See the route, filters, retrievers, fusion and rerank scores behind every answer. Nothing is a black box." },
];

const ROUTES = [
  { k: "S1", t: "Exact identifier", d: "SQL exact → BM25", icon: Database },
  { k: "S2", t: "Coverage relationships", d: "Graph & SQL tools", icon: Network },
  { k: "S3", t: "Your analytics", d: "Guarded text-to-SQL", icon: Table2 },
  { k: "S4–S7", t: "Policy & chart text", d: "Dense + sparse + BM25 → RRF → cross-encoder", icon: Split },
  { k: "S8", t: "Multi-hop", d: "Decompose → graph + hybrid", icon: GitBranch },
  { k: "S11", t: "Out of scope", d: "Abstain with reason", icon: ShieldCheck },
];

const TRUST = [
  { icon: Lock, title: "De-identified before any model call", body: "Known identifiers and patterns are tokenized at intake, raw text is encrypted at rest, and calls that still look identifying are refused." },
  { icon: UserCheck, title: "Humans decide", body: "Necessa never outputs approved or denied. Clinicians review and override verdicts with a reason — every override is audited." },
  { icon: ScrollText, title: "Tamper-evident audit", body: "Every view, reveal, verdict, override and letter is written to a hash-chained audit log you can verify in one click." },
  { icon: Fingerprint, title: "Guardrails at every stage", body: "Prompt-injection screening on uploads, relevance thresholds, verbatim citation checks and policy enforcement on outputs." },
];

const ROLES = [
  {
    icon: ClipboardCheck,
    role: "Prior auth coordinators",
    title: "Submit complete packets the first time",
    points: ["Worklist sorted by payer clock (72 h / 7 d)", "Gaps with the exact fix before submission", "Policy match while you type codes"],
  },
  {
    icon: Stethoscope,
    role: "Clinicians",
    title: "Sign letters you can stand behind",
    points: ["Every sentence traceable to the chart", "Override any verdict with a reason", "Peer-to-peer prep from the same evidence"],
  },
  {
    icon: ChartNoAxesCombined,
    role: "Revenue cycle leaders",
    title: "See where documentation breaks",
    points: ["Top gap criteria and denial reasons", "Ask your own data in plain English", "Turnaround and readiness trends"],
  },
  {
    icon: Landmark,
    role: "Compliance & audit",
    title: "Reconstruct any decision",
    points: ["Hash-chained audit log with one-click verify", "PHI reveals require a permission and are logged", "Model, prompt and policy versions on every verdict"],
  },
];

const FAQ = [
  {
    q: "Does Necessa approve or deny prior authorizations?",
    a: "No. It assesses documentation readiness — Ready, Gaps or Not supported — against the applicable policy's criteria. Payers make coverage determinations, and a licensed professional at your practice reviews every Necessa output before anything is submitted.",
  },
  {
    q: "Which policies does it know?",
    a: "The public CMS Medicare Coverage Database — National and Local Coverage Determinations and Billing & Coding articles — resolved by service code, diagnosis, contractor jurisdiction and date of service. Commercial payer policies can be added as documents; the demo includes synthetic payer policies.",
  },
  {
    q: "How is patient data protected?",
    a: "Identifiers are tokenized at intake and raw text is encrypted at rest. Only de-identified passages for one criterion at a time reach a model, every model call carries a data class, and revealing identifiers requires a permission and is written to a tamper-evident audit log. The public demo uses synthetic patients only.",
  },
  {
    q: "What happens when the evidence is ambiguous?",
    a: "Necessa says so. A criterion is Insufficient unless the chart supports it with a verbatim quote that a second model family confirms. Negative criteria — such as “no active infection” — need an explicit attestation; silence never counts as met.",
  },
  {
    q: "Which models does it use?",
    a: "It is model-agnostic. Requests go through LiteLLM with per-task routing, fallbacks across providers and token budgets, so you can point production traffic at the endpoints your organization has approved.",
  },
];

export default function LandingPage() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="bg-grid absolute inset-0 -z-10 [mask-image:radial-gradient(70%_60%_at_50%_0%,#000,transparent)]" />
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-5 pb-20 pt-16 md:pt-24 lg:grid-cols-[1.05fr_1fr] [&>*]:min-w-0">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted shadow-e1">
              <span className="size-1.5 rounded-full bg-met" />
              For prior authorization & denial appeals teams
            </span>
            <h1 className="mt-6 font-display text-[40px] leading-[1.04] tracking-[-0.02em] text-fg text-balance min-[400px]:text-[44px] sm:text-6xl">
              Know what the payer will ask — <em className="ai-gradient-text not-italic">before they ask.</em>
            </h1>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-muted text-pretty">
              Necessa checks a patient&apos;s chart against the exact, version-correct coverage criteria of the applicable policy — criterion by criterion, with citations to both — then drafts the request or appeal for clinician sign-off.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" variant="primary">
                <Link href="/login?demo=1">
                  Explore the live demo
                  <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link href="/signup">Create an account</Link>
              </Button>
            </div>
            <ul className="mt-8 grid gap-2 text-[13px] text-muted sm:grid-cols-2">
              {["Never auto-approves or denies", "Absence of evidence ≠ met", "Cites policy and chart, verbatim", "Model-agnostic via LiteLLM"].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <CircleCheck className="size-4 text-met" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <HeroVisual />
        </div>
      </section>

      {/* Stats */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-x-6 px-5 lg:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="py-6 sm:py-8 lg:px-6 lg:first:pl-0">
              <p className="font-display text-[32px] tracking-tight text-fg sm:text-4xl">{s.value}</p>
              <p className="mt-2 max-w-[16rem] text-[13px] text-muted">{s.label}</p>
            </div>
          ))}
        </div>
        <p className="mx-auto max-w-6xl px-5 pb-6 text-[11px] text-subtle">Sources: AMA 2025 Prior Authorization Physician Survey (fielded Dec 2025, n = 1,000); CMS Interoperability & Prior Authorization Final Rule (CMS-0057-F).</p>
      </section>

      {/* Product tour */}
      <section id="product" className="mx-auto max-w-6xl scroll-mt-20 px-5 pt-24">
        <Reveal>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">The product</p>
          <h2 className="mt-3 max-w-2xl font-display text-4xl tracking-tight text-fg text-balance">One workspace from codes to a signed letter.</h2>
          <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">Built for the people who assemble prior authorizations every day — dense where it needs to be, calm everywhere else, and honest about what the AI did.</p>
        </Reveal>
        <Reveal className="mt-12" delay={0.05}>
          <ProductTour />
        </Reveal>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl scroll-mt-20 px-5 py-24">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">How it works</p>
        <h2 className="mt-3 max-w-2xl font-display text-4xl tracking-tight text-fg text-balance">From codes to a defensible packet in minutes, not hours.</h2>
        <Stagger inView className="relative mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <span aria-hidden className="absolute left-6 right-6 top-[34px] hidden h-px bg-[linear-gradient(90deg,transparent,var(--border-strong)_10%,var(--border-strong)_90%,transparent)] lg:block" />
          {STEPS.map((s, i) => (
            <StaggerItem key={s.title} className="lift relative rounded-xl bg-surface p-5 shadow-e1">
              <span className="relative z-[1] flex size-9 items-center justify-center rounded-lg bg-brand-soft text-brand ring-4 ring-bg">
                <s.icon className="size-[18px]" />
              </span>
              <span className="absolute right-5 top-5 font-mono text-[11px] text-subtle">0{i + 1}</span>
              <h3 className="mt-4 text-[15px] font-semibold tracking-tight text-fg">{s.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{s.body}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </section>

      {/* Architecture */}
      <section id="architecture" className="scroll-mt-20 border-y border-border bg-surface">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-5 py-24 lg:grid-cols-[0.9fr_1.1fr] [&>*]:min-w-0">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">Hybrid RAG, engineered</p>
            <h2 className="mt-3 font-display text-4xl tracking-tight text-fg text-balance">Every question takes the path that can actually answer it.</h2>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">
              Exact identifiers go to SQL. Relationships go to the coverage graph. Your own metrics go to guarded text-to-SQL. Policy and chart language goes through dense + sparse + BM25 retrieval, reciprocal-rank fusion and a cross-encoder — then answers are checked against the quoted source before you see them.
            </p>
            <div className="mt-6 grid gap-2 text-[13px]">
              {[
                "Metadata filters first: payer, jurisdiction, date of service",
                "Blue/green index aliases with one-click rollback",
                "Calibrated thresholds — abstains instead of guessing",
                "Evaluated nightly: recall@10, false-met rate, faithfulness",
              ].map((t) => (
                <p key={t} className="flex items-center gap-2 text-muted">
                  <Workflow className="size-4 text-subtle" />
                  {t}
                </p>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-bg p-5">
            <div className="rounded-lg border border-border bg-surface px-4 py-3 text-[13px] shadow-e1">
              <span className="text-subtle">Question · </span>
              <span className="text-fg">“Is M17.11 covered for TKA in Arizona, and what documentation is needed?”</span>
            </div>
            <div className="mx-auto h-5 w-px bg-border-strong" />
            <div className="rounded-lg bg-surface-2 px-4 py-3 text-center text-[12px] text-muted">
              Query understanding · regex extractors → intent kNN → small-model router · self-query filters
            </div>
            <div className="mx-auto h-5 w-px bg-border-strong" />
            <div className="grid gap-2 sm:grid-cols-3">
              {ROUTES.map((r) => (
                <div key={r.k} className={`rounded-lg border bg-surface p-3 ${r.k === "S8" ? "border-brand shadow-[0_0_0_1px_var(--brand)]" : "border-border"}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] font-semibold text-brand-fg">{r.k}</span>
                    <r.icon className="size-3.5 text-subtle" />
                  </div>
                  <p className="mt-1.5 text-[12.5px] font-medium text-fg">{r.t}</p>
                  <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{r.d}</p>
                </div>
              ))}
            </div>
            <div className="mx-auto h-5 w-px bg-border-strong" />
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg bg-surface-2 px-4 py-3 text-[12px] text-muted">
                <span className="font-medium text-fg">Context assembly</span> · MMR diversity, parent expansion, best-first & best-last ordering, token budget
              </div>
              <div className="rounded-lg bg-surface-2 px-4 py-3 text-[12px] text-muted">
                <span className="font-medium text-fg">Verification</span> · verbatim quote check, cross-family entailment, citation validity = 100%
              </div>
            </div>
            <div className="mx-auto h-5 w-px bg-border-strong" />
            <div className="ai-border rounded-lg px-4 py-3 text-[13px]">
              <span className="font-medium text-fg">Grounded answer</span> <span className="text-muted">with numbered citations — or a clear abstention.</span>
            </div>
          </div>
        </div>
      </section>

      {/* Assistive AI */}
      <section className="mx-auto max-w-6xl px-5 py-24">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">Assistive, not autonomous</p>
        <h2 className="mt-3 max-w-2xl font-display text-4xl tracking-tight text-fg text-balance">AI woven through the workflow — not bolted on as a chatbot.</h2>
        <Stagger inView className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {ASSIST.map((a) => (
            <StaggerItem key={a.title} className="group bg-surface p-6 transition-colors hover:bg-surface-2/40">
              <span className="flex size-9 items-center justify-center rounded-lg bg-[color-mix(in_oklab,var(--ai-2)_12%,transparent)] text-ai-2 transition-transform duration-200 ease-out group-hover:scale-105">
                <a.icon className="size-[18px]" />
              </span>
              <h3 className="mt-4 text-[15px] font-semibold tracking-tight text-fg">{a.title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{a.body}</p>
            </StaggerItem>
          ))}
        </Stagger>
      </section>

      {/* Roles */}
      <section className="border-t border-border bg-surface/60">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <Reveal>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">Who it’s for</p>
            <h2 className="mt-3 max-w-2xl font-display text-4xl tracking-tight text-fg text-balance">Every role in the prior-auth loop, on the same evidence.</h2>
          </Reveal>
          <Stagger inView className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ROLES.map((r) => (
              <StaggerItem key={r.role} className="lift flex flex-col rounded-xl border border-border bg-surface p-5">
                <r.icon className="size-5 text-brand" />
                <p className="mt-4 text-xs font-semibold uppercase tracking-[0.08em] text-subtle">{r.role}</p>
                <h3 className="mt-1.5 text-[15px] font-semibold tracking-tight text-fg">{r.title}</h3>
                <ul className="mt-4 grid gap-2 text-[13px] text-muted">
                  {r.points.map((pt) => (
                    <li key={pt} className="flex gap-2">
                      <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-met" />
                      {pt}
                    </li>
                  ))}
                </ul>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      {/* Trust */}
      <section className="border-t border-border bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">Security & compliance</p>
              <h2 className="mt-3 max-w-xl font-display text-4xl tracking-tight text-fg text-balance">Built for HIPAA-aligned workflows and state AI rules.</h2>
            </div>
            <Button asChild variant="secondary">
              <Link href="/security">
                Read the security overview <ArrowRight />
              </Link>
            </Button>
          </div>
          <Stagger inView className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {TRUST.map((t) => (
              <StaggerItem key={t.title} className="rounded-xl border border-border bg-bg/40 p-5">
                <span className="flex size-9 items-center justify-center rounded-lg bg-met-soft text-met">
                  <t.icon className="size-[18px]" />
                </span>
                <h3 className="mt-4 text-[14px] font-semibold text-fg">{t.title}</h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{t.body}</p>
              </StaggerItem>
            ))}
          </Stagger>
          <p className="mt-8 text-xs text-subtle">Engineering controls, not certifications: this project has not undergone a HIPAA or SOC 2 audit. The public demo uses synthetic data only.</p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="mx-auto grid max-w-6xl scroll-mt-20 grid-cols-1 gap-10 px-5 py-24 lg:grid-cols-[0.8fr_1.2fr] [&>*]:min-w-0">
        <Reveal>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand">Questions</p>
          <h2 className="mt-3 font-display text-4xl tracking-tight text-fg text-balance">The things a clinical team asks first.</h2>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            More detail on controls and data handling lives in the{" "}
            <Link href="/security" className="text-brand underline-offset-4 hover:underline">
              security overview
            </Link>
            .
          </p>
        </Reveal>
        <Reveal delay={0.05}>
          <Faq items={FAQ} />
        </Reveal>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-5 pb-24">
        <div className="relative overflow-hidden rounded-3xl bg-fg px-8 py-14 text-bg md:px-14">
          <div className="bg-grid absolute inset-0 opacity-[0.15] [mask-image:radial-gradient(60%_80%_at_80%_0%,#000,transparent)]" />
          <div className="absolute -right-24 -top-24 size-80 rounded-full bg-[radial-gradient(circle,var(--ai-2),transparent_70%)] opacity-40" />
          <h2 className="relative max-w-2xl font-display text-4xl tracking-tight text-balance md:text-5xl">See a case go from gaps to ready.</h2>
          <p className="relative mt-4 max-w-xl text-[15px] opacity-75">The demo runs entirely in your browser with synthetic patients and real CMS policy identifiers. No sign-up, no PHI.</p>
          <div className="relative mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg" className="bg-bg text-fg hover:bg-surface-2">
              <Link href="/login?demo=1">
                Explore the live demo <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
