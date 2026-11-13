"use client";

import { ArrowLeft, ArrowRight, BookOpen, Check, CircleAlert, CircleDashed, ClipboardPaste, FileJson, FileText, Flame, History, Lightbulb, Loader2, ShieldAlert, ShieldCheck, Sparkles, Trash2, UserRound, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api/client";
import { policySuggestions, useCodeSearch, useCreateCase, useOrg, usePatients, usePolicyCriteria } from "@/lib/api/hooks";
import type { CaseDocument, CriteriaNode, DocumentKind, PayerType, PolicyMatch } from "@/lib/api/types";
import { fmtBytes, fmtDate, PAYER_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { CodeChip, DocTypeBadge } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/command";
import { Checkbox, RadioCards, Segmented, Select } from "@/components/ui/controls";
import { Breadcrumb, Card, CardBody, CardHeader, SectionLabel, Skeleton } from "@/components/ui/display";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Dropzone } from "@/components/ui/widgets";
import { AiBadge } from "@/components/domain/trust";
import { Callout } from "@/components/ui/empty";

type PatientMode = "synthetic" | "fhir" | "manual";
type StepState = "pending" | "running" | "done" | "warn" | "error";
interface SubmitStep {
  id: string;
  label: string;
  state: StepState;
  detail?: string;
}

/** Drafts keep only non-identifying fields — names, DOBs, member IDs and chart text never touch browser storage. */
const DRAFT_KEY = "necessa.newcase.draft";
interface Draft {
  mode: PatientMode;
  patientId: string;
  service: string[];
  dx: string[];
  payerType: PayerType;
  payerName: string;
  state: string;
  dos: string;
  priority: "standard" | "expedited";
  title: string;
  savedAt: number;
}

const STEP_ICON: Record<StepState, React.ReactNode> = {
  pending: <CircleDashed className="size-4 text-subtle" />,
  running: <Loader2 className="size-4 animate-spin text-brand" />,
  done: <Check className="size-4 text-met" />,
  warn: <ShieldAlert className="size-4 text-insufficient" />,
  error: <CircleAlert className="size-4 text-notmet" />,
};
interface Staged {
  id: string;
  kind: DocumentKind;
  file?: File;
  text?: string;
  title: string;
  noteDate?: string;
}

const DOC_KINDS: { value: DocumentKind; label: string }[] = [
  { value: "clinical_note", label: "Clinical note" },
  { value: "imaging_report", label: "Imaging report" },
  { value: "therapy_note", label: "Therapy note" },
  { value: "fhir_bundle", label: "FHIR bundle" },
  { value: "pdf", label: "Other PDF" },
  { value: "other", label: "Other" },
];

function leafTexts(n?: CriteriaNode): string[] {
  if (!n) return [];
  if (n.children?.length) return n.children.flatMap(leafTexts);
  return n.text ? [n.text] : [];
}

function CodePicker({ system, value, onChange, placeholder }: { system: "HCPCS" | "ICD10CM"; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q);
  const codes = useCodeSearch(dq, system);
  const options = (codes.data ?? []).map((c) => ({ value: c.code, label: c.shortDesc }));
  return (
    <Combobox
      multiple
      value={value}
      onChange={onChange}
      options={options}
      onSearch={setQ}
      loading={codes.isFetching && !codes.data}
      placeholder={placeholder}
      searchPlaceholder={system === "HCPCS" ? "Search procedure / HCPCS codes…" : "Search ICD-10-CM…"}
      empty={q ? "No codes found" : "Type a code or description"}
    />
  );
}

const matchingBadge = (loading: boolean) =>
  loading ? (
    <span className="flex items-center gap-1 text-[11px] text-subtle">
      <Loader2 className="size-3 animate-spin" /> Matching…
    </span>
  ) : null;

function AssistPanel({ matches, loading, ready }: { matches: PolicyMatch[]; loading: boolean; ready: boolean }) {
  const top = matches[0];
  const criteria = usePolicyCriteria(top?.policyId ?? "");
  const needs = leafTexts(top ? criteria.data?.tree : undefined);
  return (
    <div className="grid gap-4 lg:sticky lg:top-20">
      <Card className="ai-border">
        <CardHeader title="Policy match" description="Resolved deterministically from codes, jurisdiction and date of service — no model involved" icon={<Sparkles className="text-ai-2" />} actions={matchingBadge(loading)} />
        <CardBody className="grid gap-2">
          {!ready ? (
            <p className="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-3 text-[13px] text-muted">
              <CircleDashed className="size-4 shrink-0 text-subtle" /> Add a service code and state to preview the applicable policy.
            </p>
          ) : loading && !matches.length ? (
            <Skeleton className="h-20" />
          ) : matches.length === 0 ? (
            <p className="rounded-md bg-insufficient-soft px-3 py-3 text-[13px] text-insufficient-fg">No active LCD lists these codes in this jurisdiction. Necessa will still check NCDs and any uploaded payer policy.</p>
          ) : (
            matches.slice(0, 3).map((m, i) => (
              <div key={m.policyVersionId} className={cn("rounded-lg border p-3", i === 0 ? "border-brand/40 bg-brand-soft/30" : "border-border")}>
                <div className="flex items-center gap-2">
                  <DocTypeBadge docType={m.docType} />
                  <span className="font-mono text-xs font-medium text-fg">{m.sourceKey}</span>
                  <span className="text-xs text-subtle">v{m.version}</span>
                  <span className="tabular ml-auto text-xs text-muted">{Math.round(m.score * 100)}%</span>
                </div>
                <p className="mt-1.5 text-[13px] font-medium leading-snug text-fg">{m.title}</p>
                <p className="mt-1 text-xs text-muted">{m.contractor?.name ?? "National"} · effective {fmtDate(m.effectiveFrom)}</p>
                <ul className="mt-2 grid gap-1">
                  {m.matchReasons.slice(0, 4).map((r) => (
                    <li key={`${r.type}-${r.value}`} className="flex items-start gap-1.5 text-xs text-muted">
                      {r.detail.startsWith("Outside") ? <CircleAlert className="mt-0.5 size-3 shrink-0 text-notmet" /> : <Check className="mt-0.5 size-3 shrink-0 text-met" />}
                      <span>
                        <span className="font-mono font-medium text-fg">{r.value}</span> — {r.detail}
                      </span>
                    </li>
                  ))}
                </ul>
                {m.criteriaSetStatus && m.criteriaSetStatus !== "approved" ? (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-insufficient-fg">
                    <CircleAlert className="size-3" /> Criteria {String(m.criteriaSetStatus) === "missing" ? "not compiled yet" : "pending review"} — verdicts may be unavailable
                  </p>
                ) : null}
              </div>
            ))
          )}
        </CardBody>
      </Card>
      {top ? (
        <Card>
          <CardHeader
            title="Documentation you'll likely need"
            description={`From ${top.sourceKey}'s reviewed criteria — attach these to avoid gaps`}
            icon={<Lightbulb />}
            actions={<AiBadge label="Preview" detail="Derived from the policy's approved criteria set. The full check runs after the case is created." />}
          />
          <CardBody>
            {criteria.isPending ? (
              <Skeleton className="h-24" />
            ) : needs.length ? (
              <ol className="grid gap-2">
                {needs.map((t, i) => (
                  <li key={t} className="flex gap-2.5 text-[13px] text-fg">
                    <span className="tabular mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-brand-soft text-[10px] font-semibold text-brand-fg">{i + 1}</span>
                    {t}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[13px] text-muted">Criteria for this policy haven&apos;t been compiled yet. An admin can compile them from Knowledge ops.</p>
            )}
          </CardBody>
        </Card>
      ) : null}
      <p className="px-1 text-xs leading-relaxed text-subtle">
        Patient identifiers are encrypted and replaced with tokens before any model call. Only the evidence for one criterion is ever sent at a time.
      </p>
    </div>
  );
}

export default function NewCasePage() {
  const router = useRouter();
  const org = useOrg();
  const patients = usePatients();
  const create = useCreateCase();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<PatientMode>("synthetic");
  const [patientId, setPatientId] = useState<string>("");
  const [manual, setManual] = useState({ fullName: "", dob: "", sex: "F", state: "", memberId: "" });
  const [fhirInfo, setFhirInfo] = useState<{ name: string; dob: string; sex: string; state: string; file: File } | null>(null);
  const [service, setService] = useState<string[]>([]);
  const [dx, setDx] = useState<string[]>([]);
  const [payerType, setPayerType] = useState<PayerType>("medicare_ffs");
  const [payerName, setPayerName] = useState("Medicare Part B");
  const [state, setState] = useState("");
  const [dos, setDos] = useState(() => new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10));
  const [priority, setPriority] = useState<"standard" | "expedited">("standard");
  const [title, setTitle] = useState("");
  const [docs, setDocs] = useState<Staged[]>([]);
  const [paste, setPaste] = useState({ text: "", kind: "clinical_note" as DocumentKind, noteDate: new Date().toISOString().slice(0, 10) });
  const [evaluateAfter, setEvaluateAfter] = useState(true);
  const [matches, setMatches] = useState<PolicyMatch[]>([]);
  const [matching, setMatching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<SubmitStep[] | null>(null);
  const [restored, setRestored] = useState<number | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const reduce = useReducedMotion();
  const codeSearch = useCodeSearch(service[0] ?? "", "HCPCS");

  // Restore a recent draft once, then autosave non-PHI fields.
  useEffect(() => {
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as Draft | null;
      if (d && Date.now() - d.savedAt < 7 * 86400_000 && (d.service.length || d.patientId)) {
        setMode(d.mode === "manual" || d.mode === "fhir" ? "synthetic" : d.mode);
        setPatientId(d.patientId);
        setService(d.service);
        setDx(d.dx);
        setPayerType(d.payerType);
        setPayerName(d.payerName);
        setState(d.state);
        setDos(d.dos);
        setPriority(d.priority);
        setTitle(d.title);
        setRestored(d.savedAt);
      }
    } catch {
      /* ignore corrupt drafts */
    }
    setDraftReady(true);
  }, []);
  useEffect(() => {
    if (!draftReady || progress) return;
    const t = setTimeout(() => {
      try {
        const empty = !service.length && !dx.length && !patientId && !title;
        if (empty) localStorage.removeItem(DRAFT_KEY);
        else localStorage.setItem(DRAFT_KEY, JSON.stringify({ mode, patientId, service, dx, payerType, payerName, state, dos, priority, title, savedAt: Date.now() } satisfies Draft));
      } catch {
        /* storage unavailable */
      }
    }, 500);
    return () => clearTimeout(t);
  }, [draftReady, progress, mode, patientId, service, dx, payerType, payerName, state, dos, priority, title]);
  const discardDraft = () => {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
    setPatientId("");
    setService([]);
    setDx([]);
    setPayerType("medicare_ffs");
    setPayerName("Medicare Part B");
    setState("");
    setPriority("standard");
    setTitle("");
    setStep(0);
    setRestored(null);
  };

  const selectedPatient = patients.data?.find((p) => p.id === patientId);
  const effectiveState = state || selectedPatient?.state || fhirInfo?.state || manual.state;

  useEffect(() => {
    if (!state && effectiveState) setState(effectiveState);
  }, [effectiveState, state]);

  useEffect(() => {
    if (!title && service[0] && codeSearch.data?.[0]?.code === service[0]) setTitle(codeSearch.data[0].shortDesc);
  }, [service, codeSearch.data, title]);

  const ready = service.length > 0 && !!effectiveState;
  useEffect(() => {
    if (!ready) {
      setMatches([]);
      return;
    }
    let live = true;
    setMatching(true);
    const t = setTimeout(async () => {
      try {
        const res = await policySuggestions({ serviceCodes: service, dxCodes: dx, state: effectiveState, payerType, dateOfService: dos });
        if (live) setMatches(res.matches);
      } catch {
        /* preview is best-effort */
      } finally {
        if (live) setMatching(false);
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ready, service, dx, effectiveState, payerType, dos]);

  const parseFhir = async (file: File) => {
    try {
      const json = JSON.parse(await file.text());
      const entries: { resource?: Record<string, unknown> }[] = json.entry ?? [];
      const p = (json.resourceType === "Patient" ? json : entries.find((e) => e.resource?.resourceType === "Patient")?.resource) as
        | { name?: { given?: string[]; family?: string }[]; birthDate?: string; gender?: string; address?: { state?: string }[] }
        | undefined;
      if (!p) throw new Error("No Patient resource found in this bundle.");
      const n = p.name?.[0];
      setFhirInfo({ name: [...(n?.given ?? []), n?.family].filter(Boolean).join(" "), dob: p.birthDate ?? "", sex: p.gender === "male" ? "M" : "F", state: p.address?.[0]?.state ?? "", file });
      toast.success("FHIR bundle parsed", { description: `${entries.length} resources · patient demographics extracted` });
    } catch (e) {
      toast.error("Couldn't read that FHIR bundle", { description: errorMessage(e) });
    }
  };

  const missing0 = (
    mode === "synthetic" ? [!patientId && "a patient"] : mode === "fhir" ? [!fhirInfo && "a FHIR bundle"] : [manual.fullName.trim().length < 2 && "full name", !manual.dob && "date of birth", !manual.state && "state"]
  ).filter(Boolean) as string[];
  const missing1 = [!service.length && "a service code", !dx.length && "a diagnosis code", !payerName && "a plan", !effectiveState && "jurisdiction", !dos && "date of service"].filter(Boolean) as string[];
  const patientValid = missing0.length === 0;
  const serviceValid = missing1.length === 0;
  const missing = step === 0 ? missing0 : step === 1 ? missing1 : [];
  const payerOptions = useMemo(() => {
    const fromOrg = (org.data?.payers ?? []).filter((p) => p.type === payerType).map((p) => p.name);
    const defaults: Record<PayerType, string[]> = {
      medicare_ffs: ["Medicare Part B", "Medicare Part A"],
      medicare_advantage: ["Humana Gold Plus (HMO)", "Aetna Medicare Advantage", "UnitedHealthcare Medicare Advantage"],
      commercial: ["Blue Cross Blue Shield of Texas", "Cigna", "Aetna"],
      medicaid: ["Texas Medicaid", "SoonerCare (Oklahoma)"],
    };
    return Array.from(new Set([...fromOrg, ...defaults[payerType]]));
  }, [org.data, payerType]);

  const submit = async () => {
    setSubmitting(true);
    const plan: SubmitStep[] = [
      { id: "case", label: "Create case and encrypt demographics", state: "running" },
      ...(mode === "fhir" && fhirInfo ? [{ id: "fhir", label: `Import ${fhirInfo.file.name}`, state: "pending" as StepState }] : []),
      ...docs.map((d) => ({ id: d.id, label: `De-identify and screen ${d.title}`, state: "pending" as StepState })),
      ...(evaluateAfter ? [{ id: "eval", label: "Start the medical-necessity check", state: "pending" as StepState }] : []),
    ];
    setProgress(plan);
    const mark = (id: string, state: StepState, detail?: string) => setProgress((p) => (p ? p.map((x) => (x.id === id ? { ...x, state, detail } : x)) : p));
    try {
      const body: Record<string, unknown> = { title: title || "Prior authorization", priority, payerType, payerName, state: effectiveState, serviceCodes: service, dxCodes: dx, dateOfService: dos };
      if (mode === "synthetic") body.patientId = patientId;
      else if (mode === "fhir" && fhirInfo) body.patient = { fullName: fhirInfo.name, dob: fhirInfo.dob, sex: fhirInfo.sex, state: fhirInfo.state || effectiveState };
      else body.patient = manual;
      const c = await create.mutateAsync(body);
      mark("case", "done", c.number);
      const track = (id: string, run: () => Promise<CaseDocument>) => {
        mark(id, "running");
        return run().then(
          (r) => {
            mark(id, r.quarantined ? "warn" : "done", r.quarantined ? "Quarantined — possible prompt injection; excluded from evidence" : "PHI tokenized · injection screen passed");
            return r;
          },
          (e) => {
            mark(id, "error", errorMessage(e));
            return null;
          },
        );
      };
      const uploads: Promise<CaseDocument | null>[] = [];
      if (mode === "fhir" && fhirInfo) {
        const form = new FormData();
        form.set("file", fhirInfo.file);
        form.set("kind", "fhir_bundle");
        uploads.push(track("fhir", () => api.upload<CaseDocument>(`/cases/${c.id}/documents`, form)));
      }
      for (const d of docs) {
        if (d.file) {
          const form = new FormData();
          form.set("file", d.file);
          form.set("kind", d.kind);
          if (d.noteDate) form.set("noteDate", d.noteDate);
          uploads.push(track(d.id, () => api.upload<CaseDocument>(`/cases/${c.id}/documents`, form)));
        } else if (d.text) uploads.push(track(d.id, () => api.post<CaseDocument>(`/cases/${c.id}/documents/text`, { kind: d.kind, text: d.text, title: d.title, noteDate: d.noteDate })));
      }
      const results = (await Promise.all(uploads)).filter(Boolean) as CaseDocument[];
      const q = results.filter((r) => r.quarantined).length;
      if (evaluateAfter) mark("eval", "running", "Opening the case workspace…");
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      toast.success(`${c.number} created`, { description: `${results.length} document${results.length === 1 ? "" : "s"} attached${q ? ` · ${q} quarantined for review` : ""}` });
      router.push(`/cases/${c.id}${evaluateAfter ? "?evaluate=1" : ""}`);
    } catch (e) {
      mark("case", "error", errorMessage(e));
      toast.error(errorMessage(e));
      setSubmitting(false);
    }
  };

  const steps = ["Patient", "Service & payer", "Documentation"];

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Cases", href: "/cases" }, { label: "New case" }]} />} wide>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div>
          <ol className="mb-6 flex items-center gap-3" aria-label="Steps">
            {steps.map((label, i) => (
              <li key={label} className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => i < step && !progress && setStep(i)}
                  aria-current={i === step ? "step" : undefined}
                  className={cn("flex items-center gap-2 rounded-md text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-brand/30", i <= step ? "text-fg" : "text-subtle", i < step && "hover:text-brand-fg")}
                  disabled={i > step}
                >
                  <span
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full text-[11px] font-semibold transition-colors duration-300",
                      i < step ? "bg-met text-white" : i === step ? "bg-brand text-brand-contrast shadow-[0_0_0_4px_color-mix(in_oklab,var(--brand)_18%,transparent)]" : "bg-surface-3 text-subtle",
                    )}
                  >
                    {i < step ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="hidden font-medium sm:inline">{label}</span>
                </button>
                {i < steps.length - 1 ? (
                  <span className="relative h-px w-10 bg-border" aria-hidden>
                    <span className="absolute inset-y-0 left-0 bg-met transition-[width] duration-500 ease-out" style={{ width: i < step ? "100%" : "0%" }} />
                  </span>
                ) : null}
              </li>
            ))}
          </ol>

          {restored && !progress ? (
            <Callout
              tone="neutral"
              icon={<History className="size-4" />}
              className="mb-4"
              title="Draft restored"
              action={
                <Button size="xs" variant="ghost" onClick={discardDraft}>
                  Start over
                </Button>
              }
            >
              Saved {new Date(restored).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Patient identifiers and chart text are never saved in drafts.
            </Callout>
          ) : null}

          <Card>
            <CardBody className="grid gap-6 pt-5">
              {progress ? (
                <div className="grid gap-4" role="status" aria-live="polite">
                  <div>
                    <h1 className="text-lg font-semibold tracking-tight">Creating the case</h1>
                    <p className="text-[13px] text-muted">Each document is de-identified and screened for prompt injection before it can be used as evidence.</p>
                  </div>
                  <ol className="grid gap-1.5">
                    {progress.map((p) => (
                      <motion.li
                        key={p.id}
                        layout={!reduce}
                        className={cn("flex items-start gap-3 rounded-lg border px-3 py-2.5 text-[13px] transition-colors", p.state === "running" ? "border-brand/30 bg-brand-soft/20" : p.state === "warn" ? "border-insufficient/30 bg-insufficient-soft/30" : p.state === "error" ? "border-notmet/30 bg-notmet-soft/30" : "border-border")}
                      >
                        <span className="mt-px">{STEP_ICON[p.state]}</span>
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className={cn("text-fg", p.state === "pending" && "text-muted")}>{p.label}</span>
                          {p.detail ? <span className="text-xs text-muted">{p.detail}</span> : null}
                        </span>
                      </motion.li>
                    ))}
                  </ol>
                  {progress.some((p) => p.state === "error") ? (
                    <Button variant="secondary" className="w-fit" onClick={() => setProgress(null)}>
                      <ArrowLeft /> Back to the form
                    </Button>
                  ) : (
                    <p className="flex items-center gap-1.5 text-xs text-subtle">
                      <ShieldCheck className="size-3.5 text-met" /> Raw text is encrypted at rest; only de-identified text is indexed.
                    </p>
                  )}
                </div>
              ) : (
              <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step}
                className="grid gap-6"
                initial={reduce ? false : { opacity: 0, x: 14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, x: -14 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              >
              {step === 0 ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h1 className="text-lg font-semibold tracking-tight">Who is this request for?</h1>
                      <p className="text-[13px] text-muted">Demographics are encrypted at rest and tokenized before AI processing.</p>
                    </div>
                    <Segmented
                      value={mode}
                      onValueChange={setMode}
                      options={[
                        { value: "synthetic", label: "Existing", icon: <Users /> },
                        { value: "fhir", label: "FHIR", icon: <FileJson /> },
                        { value: "manual", label: "Manual", icon: <UserRound /> },
                      ]}
                    />
                  </div>
                  {mode === "synthetic" ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(patients.data ?? []).map((p) => (
                        <button
                          key={p.id}
                          onClick={() => setPatientId(p.id)}
                          className={cn("flex items-center gap-3 rounded-lg border p-3 text-left transition-[border,background]", patientId === p.id ? "border-brand bg-brand-soft/40 shadow-[0_0_0_1px_var(--brand)]" : "border-border hover:border-border-strong")}
                        >
                          <span className="flex size-8 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-muted">{p.displayName.replace(/[. ]/g, "")}</span>
                          <span className="grid text-[13px]">
                            <span className="font-medium text-fg">{p.displayName}</span>
                            <span className="text-xs text-muted">
                              {p.sex} · born {p.birthYear} · {p.state}
                            </span>
                          </span>
                        </button>
                      ))}
                      {patients.isPending ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14" />) : null}
                    </div>
                  ) : mode === "fhir" ? (
                    <div className="grid gap-3">
                      <Dropzone accept=".json,application/fhir+json,application/json" multiple={false} hint="FHIR R4 Bundle or Patient resource (e.g. exported from Synthea)" onFiles={(f) => parseFhir(f[0]!)} />
                      {fhirInfo ? (
                        <div className="flex items-center gap-3 rounded-lg bg-met-soft/50 p-3 text-[13px]">
                          <FileJson className="size-4 text-met" />
                          <span className="min-w-0 flex-1">
                            <span className="font-medium text-fg">{fhirInfo.name || "Unnamed patient"}</span> · {fhirInfo.sex} · DOB {fhirInfo.dob || "—"} · {fhirInfo.state || "state not set"}
                          </span>
                          <span className="text-xs text-muted">{fhirInfo.file.name}</span>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Full name" htmlFor="m-name">
                        <Input id="m-name" value={manual.fullName} onChange={(e) => setManual({ ...manual, fullName: e.target.value })} />
                      </Field>
                      <Field label="Date of birth" htmlFor="m-dob">
                        <Input id="m-dob" type="date" value={manual.dob} onChange={(e) => setManual({ ...manual, dob: e.target.value })} />
                      </Field>
                      <Field label="Sex">
                        <Select value={manual.sex} onValueChange={(v) => setManual({ ...manual, sex: v })} options={[{ value: "F", label: "Female" }, { value: "M", label: "Male" }, { value: "U", label: "Unknown" }]} />
                      </Field>
                      <Field label="State of residence">
                        <Select value={manual.state} onValueChange={(v) => setManual({ ...manual, state: v })} placeholder="Select state" options={(org.data?.states ?? ["TX"]).map((s) => ({ value: s, label: s }))} />
                      </Field>
                      <Field label="Member ID / MBI" htmlFor="m-mbi" optional className="sm:col-span-2">
                        <Input id="m-mbi" value={manual.memberId} onChange={(e) => setManual({ ...manual, memberId: e.target.value })} className="font-mono" />
                      </Field>
                    </div>
                  )}
                </>
              ) : null}

              {step === 1 ? (
                <>
                  <div>
                    <h1 className="text-lg font-semibold tracking-tight">What&apos;s being requested?</h1>
                    <p className="text-[13px] text-muted">Codes and jurisdiction decide which policy version applies.</p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Service codes (HCPCS / procedure)" className="sm:col-span-2">
                      <CodePicker system="HCPCS" value={service} onChange={setService} placeholder="e.g. 64483, 27447, E0601" />
                    </Field>
                    <Field label="Diagnosis codes (ICD-10-CM)" className="sm:col-span-2">
                      <CodePicker system="ICD10CM" value={dx} onChange={setDx} placeholder="e.g. M54.17, M17.11" />
                    </Field>
                    <Field label="Payer type">
                      <Select
                        value={payerType}
                        onValueChange={(v) => {
                          setPayerType(v as PayerType);
                          setPayerName("");
                        }}
                        options={Object.entries(PAYER_LABEL).map(([value, label]) => ({ value, label }))}
                      />
                    </Field>
                    <Field label="Plan">
                      <Select value={payerName} onValueChange={setPayerName} placeholder="Select plan" options={payerOptions.map((p) => ({ value: p, label: p }))} />
                    </Field>
                    <Field label="Jurisdiction (state)" hint="Defaults to the patient's state">
                      <Select value={state} onValueChange={setState} placeholder="Select state" options={Array.from(new Set([...(org.data?.states ?? []), effectiveState].filter(Boolean))).map((s) => ({ value: s!, label: s! }))} />
                    </Field>
                    <Field label="Date of service" hint="Selects the policy version in effect">
                      <Input type="date" value={dos} onChange={(e) => setDos(e.target.value)} />
                    </Field>
                    <Field label="Case title" className="sm:col-span-2">
                      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Auto-filled from the first service code" />
                    </Field>
                    <Field label="Priority" className="sm:col-span-2">
                      <RadioCards
                        value={priority}
                        onValueChange={(v) => setPriority(v as "standard" | "expedited")}
                        options={[
                          { value: "standard", label: "Standard", description: `${Math.round((org.data?.settings.slaHoursStandard ?? 168) / 24)}-day payer clock` },
                          { value: "expedited", label: "Expedited", description: `${org.data?.settings.slaHoursExpedited ?? 72}-hour clock — health or function at risk`, icon: <Flame /> },
                        ]}
                      />
                    </Field>
                  </div>
                </>
              ) : null}

              {step === 2 ? (
                <>
                  <div>
                    <h1 className="text-lg font-semibold tracking-tight">Attach the chart</h1>
                    <p className="text-[13px] text-muted">Every upload is de-identified and screened for prompt injection before it can be used as evidence.</p>
                  </div>
                  <Dropzone
                    onFiles={(files) =>
                      setDocs((d) => [
                        ...d,
                        ...files.map((f) => ({ id: `${f.name}-${f.size}-${Math.random()}`, file: f, title: f.name, kind: (/mri|ct|xray|imaging/i.test(f.name) ? "imaging_report" : /pt|therapy/i.test(f.name) ? "therapy_note" : "clinical_note") as DocumentKind })),
                      ])
                    }
                  />
                  <div className="grid gap-2 rounded-xl border border-border p-3">
                    <SectionLabel>
                      <span className="flex items-center gap-1.5">
                        <ClipboardPaste className="size-3.5" /> Or paste a note
                      </span>
                    </SectionLabel>
                    <Textarea value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} placeholder="Paste a progress note, therapy summary or imaging impression…" className="min-h-28" />
                    <div className="flex flex-wrap items-center gap-2">
                      <Select size="sm" className="w-40" value={paste.kind} onValueChange={(v) => setPaste({ ...paste, kind: v as DocumentKind })} options={DOC_KINDS} />
                      <Input type="date" className="h-8 w-40" value={paste.noteDate} onChange={(e) => setPaste({ ...paste, noteDate: e.target.value })} aria-label="Note date" />
                      <Button
                        size="sm"
                        className="ml-auto"
                        disabled={paste.text.trim().length < 20}
                        onClick={() => {
                          setDocs((d) => [...d, { id: `paste-${Date.now()}`, text: paste.text, kind: paste.kind, title: `Pasted ${DOC_KINDS.find((k) => k.value === paste.kind)?.label.toLowerCase()}`, noteDate: paste.noteDate }]);
                          setPaste({ ...paste, text: "" });
                        }}
                      >
                        Add note
                      </Button>
                    </div>
                  </div>
                  {docs.length ? (
                    <ul className="grid gap-1.5">
                      {docs.map((d) => (
                        <li key={d.id} className="flex items-center gap-3 rounded-lg bg-surface-2/60 px-3 py-2">
                          <FileText className="size-4 text-subtle" />
                          <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{d.title}</span>
                          <span className="text-xs text-subtle">{d.file ? fmtBytes(d.file.size) : `${d.text?.length ?? 0} chars`}</span>
                          <Select size="sm" className="w-36" value={d.kind} onValueChange={(v) => setDocs(docs.map((x) => (x.id === d.id ? { ...x, kind: v as DocumentKind } : x)))} options={DOC_KINDS} />
                          <Button variant="ghost" size="icon-sm" aria-label="Remove" onClick={() => setDocs(docs.filter((x) => x.id !== d.id))}>
                            <Trash2 />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <label className="flex items-center gap-2.5 text-[13px] text-fg">
                    <Checkbox checked={evaluateAfter} onCheckedChange={(v) => setEvaluateAfter(v === true)} />
                    Run a medical-necessity check right after creating the case
                  </label>
                </>
              ) : null}

              </motion.div>
              </AnimatePresence>
              )}

              {progress ? null : (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                {step === 0 ? (
                  <Button asChild variant="ghost">
                    <Link href="/cases">Cancel</Link>
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => setStep(step - 1)}>
                    <ArrowLeft /> Back
                  </Button>
                )}
                {missing.length ? (
                  <p className="ml-auto text-xs text-subtle" aria-live="polite">
                    Still needed: {missing.join(", ")}
                  </p>
                ) : null}
                {step < 2 ? (
                  <Button variant="primary" disabled={step === 0 ? !patientValid : !serviceValid} onClick={() => setStep(step + 1)}>
                    Continue <ArrowRight />
                  </Button>
                ) : (
                  <Button variant="primary" onClick={submit} loading={submitting}>
                    Create case
                    {service.map((s) => (
                      <CodeChip key={s} code={s} className="h-4 bg-white/15 text-[10px] text-current ring-0" />
                    ))}
                  </Button>
                )}
              </div>
              )}
            </CardBody>
          </Card>
        </div>
        <AssistPanel matches={matches} loading={matching} ready={ready} />
      </div>
      <p className="mt-6 flex items-center gap-1.5 text-xs text-subtle">
        <BookOpen className="size-3.5" /> Medicare FFS cases resolve against LCDs/NCDs from the CMS Medicare Coverage Database, refreshed weekly.
      </p>
    </AppPage>
  );
}
