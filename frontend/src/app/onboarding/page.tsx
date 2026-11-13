"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Building2, Database, Hospital, Loader2, Plus, Sparkles, Stethoscope, Trash2, Truck, Users, Warehouse, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api/client";
import { useDemoMode, useSession } from "@/lib/api/session";
import type { Org, PayerType, Role } from "@/lib/api/types";
import { PAYER_LABEL, ROLE_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Logo, LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { RadioCards, Select, Switch } from "@/components/ui/controls";
import { Stepper } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/input";

const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

const STEPS = [
  { label: "Practice", description: "Who you are" },
  { label: "Coverage footprint", description: "States & payers" },
  { label: "Team", description: "Invite colleagues" },
  { label: "Data", description: "Demo or empty" },
  { label: "Preferences", description: "SLAs & security" },
];

/** NPI check digit: Luhn over "80840" + first 9 digits. */
function validNpi(npi: string) {
  if (!/^\d{10}$/.test(npi)) return false;
  const digits = `80840${npi.slice(0, 9)}`.split("").map(Number);
  let sum = 0;
  digits.reverse().forEach((d, i) => {
    let v = d;
    if (i % 2 === 0) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  });
  return (10 - (sum % 10)) % 10 === Number(npi[9]);
}

function OnboardingInner() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { me, status } = useSession();
  const demoMode = useDemoMode();
  const creatingNew = params.get("new") === "1";
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);

  const [practice, setPractice] = useState({ name: "", npi: "", specialty: "Orthopedic surgery", practiceType: "clinic" as Org["practiceType"], timezone: "America/Chicago" });
  const [states, setStates] = useState<string[]>(["TX"]);
  const [payers, setPayers] = useState<{ type: PayerType; name: string }[]>([{ type: "medicare_ffs", name: "Medicare Part B" }]);
  const [invites, setInvites] = useState<{ email: string; role: Role }[]>([{ email: "", role: "coordinator" }]);
  const [data, setData] = useState<"demo" | "empty">("demo");
  const [prefs, setPrefs] = useState({ slaHoursStandard: 168, slaHoursExpedited: 72, requireMfa: false, dataRetentionDays: 365 });

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login?next=/onboarding");
    if (status === "authenticated" && me?.activeOrg?.onboardingCompletedAt && !creatingNew && !finished) router.replace("/dashboard");
  }, [status, me, router, creatingNew, finished]);

  const npiError = practice.npi && !validNpi(practice.npi) ? "That NPI fails the check-digit test — double-check the 10 digits." : null;
  const canNext = [
    practice.name.trim().length > 1 && !npiError,
    states.length > 0 && payers.length > 0 && payers.every((p) => p.name.trim()),
    invites.every((i) => !i.email || /^\S+@\S+\.\S+$/.test(i.email)),
    true,
    true,
  ][step];

  const finish = async () => {
    setBusy(true);
    try {
      const needsOrg = !me?.activeOrg || creatingNew;
      if (needsOrg) await api.post("/orgs", { ...practice, npi: practice.npi || null, states, payers });
      else await api.patch("/orgs/current", { ...practice, states, payers });
      await api.patch("/orgs/current", { settings: { ...prefs, defaultAsOf: "dos" } });
      for (const i of invites.filter((x) => x.email)) await api.post("/orgs/current/invitations", i);
      if (data === "demo") await api.post("/orgs/current/demo-data");
      await api.post("/orgs/current/onboarding/complete");
      await qc.invalidateQueries();
      setFinished(true);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (finished) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-bg px-6 text-center">
        <motion.div className="relative" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 18 }}>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              aria-hidden
              className="absolute inset-0 rounded-[28px] border border-brand/40"
              initial={{ scale: 1, opacity: 0.6 }}
              animate={{ scale: 1.9 + i * 0.4, opacity: 0 }}
              transition={{ duration: 1.6, delay: 0.5 + i * 0.25, ease: [0.22, 1, 0.36, 1] }}
            />
          ))}
          <svg width="96" height="96" viewBox="0 0 32 32" fill="none" aria-hidden className="relative">
            <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="var(--brand)" />
            <motion.path
              d="M9 23V9.5l7.6 9.8L24 8.5"
              stroke="var(--brand-contrast)"
              strokeWidth="3.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.9, ease: "easeOut", delay: 0.2 }}
            />
          </svg>
        </motion.div>
        <h1 className="mt-8 font-display text-5xl tracking-tight text-fg">You&apos;re all set.</h1>
        <p className="mt-3 max-w-md text-sm text-muted">
          {practice.name || "Your practice"} is ready. {data === "demo" ? "We loaded a synthetic dataset so you can see Necessa at work." : "Create your first case to get started."}
        </p>
        <div className="mt-8 flex gap-2">
          <Button variant="primary" size="lg" onClick={() => router.push(data === "demo" ? (demoMode.on ? "/cases/case-42" : "/cases") : "/cases/new")}>
            {data === "demo" ? (demoMode.on ? "Open a sample case" : "Open the worklist") : "Create your first case"}
            <ArrowRight />
          </Button>
          <Button variant="ghost" size="lg" onClick={() => router.push("/dashboard")}>
            Go to dashboard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-dvh bg-bg lg:grid-cols-[300px_1fr]">
      <aside className="hidden border-r border-border bg-surface px-6 py-6 lg:flex lg:flex-col">
        <Logo />
        <div className="mt-12">
          <Stepper steps={STEPS} current={step} onStepClick={setStep} />
        </div>
        <div className="mt-auto rounded-xl bg-surface-2 p-4 text-[13px] text-muted">
          <Sparkles className="mb-2 size-4 text-ai-2" />
          Your states decide which Medicare contractors — and which LCDs — apply to each case. You can change everything later in Settings.
        </div>
      </aside>
      <main id="main" className="flex flex-col px-5 py-6 sm:px-10">
        <div className="flex items-center justify-between lg:hidden">
          <LogoMark className="text-brand" />
          <span className="text-xs text-muted">
            Step {step + 1} of {STEPS.length}
          </span>
        </div>
        <div className="mx-auto w-full max-w-xl flex-1 py-10 lg:py-16">
          <div className="mb-3 hidden items-center justify-between text-xs text-subtle lg:flex">
            <span className="font-medium uppercase tracking-[0.08em]">
              Step {step + 1} of {STEPS.length} · {STEPS[step]!.label}
            </span>
            <span className="tabular">{Math.round(((step + 1) / STEPS.length) * 100)}%</span>
          </div>
          <div className="mb-8 h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={STEPS.length} aria-label="Setup progress">
            <motion.div className="h-full rounded-full bg-brand" animate={{ width: `${((step + 1) / STEPS.length) * 100}%` }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }} />
          </div>
          <AnimatePresence mode="wait">
            <motion.section key={step} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
              {step === 0 ? (
                <>
                  <h1 className="text-2xl font-semibold tracking-tight">Tell us about your practice</h1>
                  <p className="mt-1.5 text-sm text-muted">This appears on letters and helps Necessa pick the right policies.</p>
                  <div className="mt-8 grid gap-5">
                    <Field label="Practice name" htmlFor="pname">
                      <Input id="pname" value={practice.name} onChange={(e) => setPractice({ ...practice, name: e.target.value })} placeholder="e.g. Lakeshore Spine & Pain" autoFocus />
                    </Field>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label="Group NPI" htmlFor="npi" optional error={npiError} hint="10 digits — validated with the CMS check digit">
                        <Input id="npi" inputMode="numeric" maxLength={10} value={practice.npi} onChange={(e) => setPractice({ ...practice, npi: e.target.value.replace(/\D/g, "") })} className="font-mono" />
                      </Field>
                      <Field label="Primary specialty" htmlFor="spec">
                        <Select
                          id="spec"
                          value={practice.specialty}
                          onValueChange={(v) => setPractice({ ...practice, specialty: v })}
                          options={["Orthopedic surgery", "Interventional pain medicine", "Neurosurgery", "Sleep medicine", "Physical medicine & rehabilitation", "Durable medical equipment", "Multi-specialty"].map((s) => ({ value: s, label: s }))}
                        />
                      </Field>
                    </div>
                    <Field label="Practice type">
                      <RadioCards
                        value={practice.practiceType}
                        onValueChange={(v) => setPractice({ ...practice, practiceType: v as Org["practiceType"] })}
                        options={[
                          { value: "clinic", label: "Physician practice", description: "Part B professional claims", icon: <Stethoscope /> },
                          { value: "hospital", label: "Hospital / health system", description: "Part A & B", icon: <Hospital /> },
                          { value: "asc", label: "Ambulatory surgery center", icon: <Building2 /> },
                          { value: "dme", label: "DME supplier", description: "DME MAC policies", icon: <Truck /> },
                        ]}
                      />
                    </Field>
                  </div>
                </>
              ) : null}

              {step === 1 ? (
                <>
                  <h1 className="text-2xl font-semibold tracking-tight">Where do you see patients?</h1>
                  <p className="mt-1.5 text-sm text-muted">States map to Medicare Administrative Contractor jurisdictions — and to the LCDs that apply.</p>
                  <div className="mt-8 grid gap-6">
                    <Field label={`States served · ${states.length} selected`}>
                      <div className="flex flex-wrap gap-1.5">
                        {STATES.map((s) => {
                          const on = states.includes(s);
                          return (
                            <button
                              key={s}
                              type="button"
                              aria-pressed={on}
                              onClick={() => setStates(on ? states.filter((x) => x !== s) : [...states, s])}
                              className={cn(
                                "h-7 w-11 rounded-md font-mono text-xs transition-colors",
                                on ? "bg-brand text-brand-contrast shadow-e1" : "bg-surface text-muted ring-1 ring-inset ring-border hover:text-fg",
                              )}
                            >
                              {s}
                            </button>
                          );
                        })}
                      </div>
                    </Field>
                    <Field label="Payer mix">
                      <div className="grid gap-2">
                        {payers.map((p, i) => (
                          <div key={i} className="flex gap-2">
                            <Select
                              className="w-48"
                              value={p.type}
                              onValueChange={(v) => setPayers(payers.map((x, j) => (j === i ? { ...x, type: v as PayerType } : x)))}
                              options={(Object.keys(PAYER_LABEL) as PayerType[]).map((k) => ({ value: k, label: PAYER_LABEL[k] }))}
                            />
                            <Input value={p.name} onChange={(e) => setPayers(payers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Plan name" />
                            <Button variant="ghost" size="icon" aria-label="Remove payer" onClick={() => setPayers(payers.filter((_, j) => j !== i))} disabled={payers.length === 1}>
                              <X />
                            </Button>
                          </div>
                        ))}
                        <Button variant="ghost" size="sm" className="w-fit" onClick={() => setPayers([...payers, { type: "medicare_advantage", name: "" }])}>
                          <Plus /> Add payer
                        </Button>
                      </div>
                    </Field>
                  </div>
                </>
              ) : null}

              {step === 2 ? (
                <>
                  <h1 className="text-2xl font-semibold tracking-tight">Invite your team</h1>
                  <p className="mt-1.5 text-sm text-muted">Roles control who can edit cases, approve letters, review criteria and read the audit log.</p>
                  <div className="mt-8 grid gap-2">
                    {invites.map((inv, i) => (
                      <div key={i} className="flex gap-2">
                        <Input type="email" placeholder="colleague@practice.com" value={inv.email} onChange={(e) => setInvites(invites.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                        <Select
                          className="w-44"
                          value={inv.role}
                          onValueChange={(v) => setInvites(invites.map((x, j) => (j === i ? { ...x, role: v as Role } : x)))}
                          options={(["admin", "coordinator", "clinician", "reviewer", "rcm_manager", "auditor"] as Role[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                        />
                        <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => setInvites(invites.filter((_, j) => j !== i))} disabled={invites.length === 1}>
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                    <Button variant="ghost" size="sm" className="w-fit" onClick={() => setInvites([...invites, { email: "", role: "clinician" }])}>
                      <Plus /> Add another
                    </Button>
                    <p className="mt-2 flex items-center gap-2 text-xs text-subtle">
                      <Users className="size-3.5" /> You can skip this — invites can be sent any time from Settings → Organization.
                    </p>
                  </div>
                </>
              ) : null}

              {step === 3 ? (
                <>
                  <h1 className="text-2xl font-semibold tracking-tight">How would you like to start?</h1>
                  <p className="mt-1.5 text-sm text-muted">Policies are shared knowledge. Patient data is always yours alone.</p>
                  <div className="mt-8">
                    <RadioCards
                      columns={1}
                      value={data}
                      onValueChange={(v) => setData(v as "demo" | "empty")}
                      options={[
                        { value: "demo", label: "Load the synthetic demo dataset", description: "14 fictional patients and cases across ESI, TKA, CPAP, SCS and more — with evaluations, letters and denials.", icon: <Database /> },
                        { value: "empty", label: "Start with an empty workspace", description: "Begin with your first real case. The Medicare policy library is still available.", icon: <Warehouse /> },
                      ]}
                    />
                  </div>
                </>
              ) : null}

              {step === 4 ? (
                <>
                  <h1 className="text-2xl font-semibold tracking-tight">Service levels & security</h1>
                  <p className="mt-1.5 text-sm text-muted">Defaults follow CMS-0057-F payer decision timeframes.</p>
                  <div className="mt-8 grid gap-5">
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label="Standard SLA (hours)" hint="Default 168 h = 7 calendar days">
                        <Input type="number" min={24} value={prefs.slaHoursStandard} onChange={(e) => setPrefs({ ...prefs, slaHoursStandard: Number(e.target.value) })} />
                      </Field>
                      <Field label="Expedited SLA (hours)" hint="Default 72 h">
                        <Input type="number" min={12} value={prefs.slaHoursExpedited} onChange={(e) => setPrefs({ ...prefs, slaHoursExpedited: Number(e.target.value) })} />
                      </Field>
                    </div>
                    <Field label="Case data retention">
                      <Select
                        value={String(prefs.dataRetentionDays)}
                        onValueChange={(v) => setPrefs({ ...prefs, dataRetentionDays: Number(v) })}
                        options={[
                          { value: "90", label: "90 days after closure" },
                          { value: "365", label: "1 year after closure" },
                          { value: "2190", label: "6 years after closure", hint: "HIPAA documentation" },
                        ]}
                      />
                    </Field>
                    <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface p-3">
                      <span className="grid">
                        <span className="text-[13px] font-medium">Require two-step verification</span>
                        <span className="text-xs text-muted">Members must enable TOTP MFA before accessing cases.</span>
                      </span>
                      <Switch checked={prefs.requireMfa} onCheckedChange={(v) => setPrefs({ ...prefs, requireMfa: v })} />
                    </label>
                  </div>
                </>
              ) : null}
            </motion.section>
          </AnimatePresence>

          <div className="mt-10 flex items-center justify-between">
            <Button variant="ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || busy}>
              <ArrowLeft /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
                Continue <ArrowRight />
              </Button>
            ) : (
              <Button variant="primary" onClick={finish} loading={busy}>
                {busy ? "Setting up…" : "Finish setup"}
              </Button>
            )}
          </div>
          {me?.activeOrg?.onboardingCompletedAt && creatingNew ? (
            <p className="mt-6 text-center text-xs text-subtle">
              <Link href="/dashboard" className="hover:text-fg">
                Cancel and return to {me.activeOrg.name}
              </Link>
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<div className="flex min-h-dvh items-center justify-center"><Loader2 className="size-5 animate-spin text-subtle" /></div>}>
      <OnboardingInner />
    </Suspense>
  );
}
