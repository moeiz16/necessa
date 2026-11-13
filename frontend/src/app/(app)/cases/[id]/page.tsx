"use client";

import {
  BadgeCheck,
  ChevronDown,
  CircleAlert,
  FileText,
  Files,
  Gavel,
  History,
  ListChecks,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Play,
  ScrollText,
  Send,
  Split,
  UserRound,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api/client";
import { useCase, useEvaluation, useMembers, useRecordOutcome, useUpdateCase } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import type { NextAction } from "@/lib/api/types";
import { fmtDate, PAYER_LABEL } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { CriteriaPanel } from "@/components/cases/criteria-panel";
import { DocumentsPanel } from "@/components/cases/documents-panel";
import { EvidencePanel } from "@/components/cases/evidence-panel";
import { LETTER_KINDS } from "@/components/cases/letter-kinds";
import { CaseAuditPanel, GapsPanel, NextActions, TimelinePanel } from "@/components/cases/side-panels";
import { CompactCaseBar, RevealDialog, RevealState, usePhiReveal, useScrolledPast } from "@/components/cases/case-chrome";
import { useCaseStream } from "@/components/cases/use-case-stream";
import { CodeChip, PayerChip, PriorityChip, ReadinessRing, SlaTimer, StatusChip } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { Select, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Avatar, Badge, Breadcrumb, Card, CardBody, CardHeader, DataList, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Field, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger } from "@/components/ui/overlays";

/* Heavy, tab-specific panels load on demand (markdown rendering, chat, denial tooling). */
const LettersPanel = dynamic(() => import("@/components/cases/letters-panel").then((m) => m.LettersPanel), { ssr: false, loading: () => <Skeleton className="h-96 rounded-xl" /> });
const DenialsPanel = dynamic(() => import("@/components/cases/denials-panel").then((m) => m.DenialsPanel), { ssr: false, loading: () => <Skeleton className="h-96 rounded-xl" /> });
const AskDrawer = dynamic(() => import("@/components/cases/ask-drawer").then((m) => m.AskDrawer), { ssr: false });

function OutcomeDialog({ caseId, open, onOpenChange }: { caseId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [outcome, setOutcome] = useState("approved");
  const [note, setNote] = useState("");
  const rec = useRecordOutcome(caseId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Record payer outcome" description="Outcomes feed your reports. Necessa never makes the coverage decision." size="sm">
        <div className="grid gap-4">
          <Field label="Outcome">
            <Select
              value={outcome}
              onValueChange={setOutcome}
              options={[
                { value: "approved", label: "Approved" },
                { value: "partial", label: "Partially approved" },
                { value: "denied", label: "Denied" },
                { value: "withdrawn", label: "Withdrawn" },
              ]}
            />
          </Field>
          <Field label="Note" optional>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-20" placeholder="Authorization number, units approved, reviewer name…" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={rec.isPending} onClick={() => rec.mutate({ outcome, note }, { onSuccess: () => onOpenChange(false) })}>
            Save outcome
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CaseInner() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const { can, me } = useSession();
  const c = useCase(id);
  const evaluation = useEvaluation(id, c.data?.latestEvaluationId);
  const members = useMembers();
  const update = useUpdateCase(id);
  const { live, evaluate, draft, draftLetter } = useCaseStream(id);
  const [tab, setTab] = useState(params.get("tab") ?? "criteria");
  const [criterion, setCriterion] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const phi = usePhiReveal<{ fullName: string; dob: string; memberId: string; mrn: string }>(async (reason) => {
    try {
      const r = await api.get<{ patientRevealed: { fullName: string; dob: string; memberId: string; mrn: string } | null }>(`/cases/${id}`, { reveal: true, reason });
      toast.message("Access recorded", { description: `Patient details were opened and logged in the audit trail · ${reason}` });
      return r.patientRevealed;
    } catch (e) {
      toast.error(errorMessage(e));
      return null;
    }
  });
  const patient = phi.value;
  const membership = me?.membership;
  const canReveal = !!membership && ((membership.permissions as string[]).includes("phi:reveal") || ["owner", "admin", "coordinator", "clinician"].includes(membership.role));
  const header = useScrolledPast<HTMLDivElement>();
  const autoEval = useRef(false);

  const canWrite = can("cases:write");
  useEffect(() => {
    if (params.get("evaluate") === "1" && !autoEval.current && c.data && canWrite) {
      autoEval.current = true;
      router.replace(`/cases/${id}`);
      void evaluate();
    }
  }, [params, c.data, canWrite, evaluate, id, router]);

  useEffect(() => {
    const t = params.get("tab");
    if (t) setTab(t);
  }, [params]);

  const switchTab = (t: string) => {
    setTab(t);
    const sp = new URLSearchParams(params.toString());
    sp.set("tab", t);
    sp.delete("evaluate");
    router.replace(`/cases/${id}?${sp.toString()}`, { scroll: false });
  };

  const runEvaluate = () => {
    switchTab("criteria");
    void evaluate();
  };
  const runDraft = (k: Parameters<typeof draftLetter>[0]) => {
    switchTab("letters");
    void draftLetter(k);
  };
  const onAction = (a: NextAction) => {
    if (a.type === "evaluate") runEvaluate();
    else if (a.type === "upload_document") switchTab("documents");
    else if (a.type === "fix_gap") switchTab("gaps");
    else if (a.type === "review") switchTab("criteria");
    else if (a.type === "draft_letter") runDraft("lmn");
    else if (a.type === "appeal") switchTab("denials");
    else if (a.type === "submit") update.mutate({ status: "submitted" }, { onSuccess: () => toast.success("Marked as submitted") });
  };

  if (c.isPending)
    return (
      <AppPage>
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="mt-4 h-96 rounded-lg" />
      </AppPage>
    );
  if (c.isError || !c.data)
    return (
      <AppPage crumbs={<Breadcrumb items={[{ label: "Cases", href: "/cases" }, { label: "Not found" }]} />}>
        <EmptyState art="cases" title="Case not found" description="It may belong to another organization, or it was removed." action={<Button onClick={() => router.push("/cases")}>Back to cases</Button>} />
      </AppPage>
    );

  const k = c.data;
  const ev = evaluation.data;
  const readiness = live.aggregate?.readiness ?? k.readiness;
  const score = live.aggregate?.readinessScore ?? k.readinessScore;
  const gapsCount = (live.running ? live.gaps?.length : ev?.gaps.length) ?? 0;
  const ringReadiness = live.running && !live.aggregate ? "unknown" : readiness;
  const evidenceMode = tab === "evidence" || tab === "letters";
  const evLoading = !!k.latestEvaluationId && evaluation.isPending && !live.running;
  const panelSkeleton = (
    <div className="grid gap-2" aria-busy>
      <Skeleton className="h-16 rounded-xl" />
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-12 rounded-lg" />
      ))}
    </div>
  );

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Cases", href: "/cases" }, { label: k.number }]} />} wide>
      <CompactCaseBar
        show={header.past}
        number={k.number}
        title={k.title}
        status={live.running ? "evaluating" : k.status}
        readiness={ringReadiness}
        score={score}
        dueAt={!["approved", "closed", "denied"].includes(k.status) ? k.dueAt : null}
        running={live.running}
        onEvaluate={runEvaluate}
        canEvaluate={canWrite}
      />
      {/* Header */}
      <div ref={header.ref} className="flex flex-col gap-4 pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <ReadinessRing size={58} stroke={5} readiness={ringReadiness} score={score} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-subtle">{k.number}</span>
              <StatusChip status={live.running ? "evaluating" : k.status} />
              <PriorityChip priority={k.priority} />
              {k.tags.map((t) => (
                <Badge key={t} tone="outline" size="xs">
                  {t}
                </Badge>
              ))}
            </div>
            <h1 className="mt-1 text-xl font-semibold text-fg">{k.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
              <span className="flex items-center gap-1.5">
                <UserRound className="size-3.5" /> {k.patient.displayName} · {k.patient.sex}, {new Date().getFullYear() - k.patient.birthYear}
              </span>
              <PayerChip payerType={k.payerType} payerName={`${k.payerName} · ${k.state}`} />
              <span>DOS {fmtDate(k.dateOfService)}</span>
              {!["approved", "closed", "denied"].includes(k.status) ? <SlaTimer dueAt={k.dueAt} /> : null}
            </div>
            {ev && !live.running ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
                <span className="font-medium text-muted">{ev.status === "completed" ? "Reviewed by your team" : "Suggested by Necessa · awaiting your review"}</span>
                <span aria-hidden>·</span>
                <span>Checked {fmtDate(ev.finishedAt ?? ev.startedAt, "MMM d, h:mm a")}</span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 xl:flex-nowrap">
          <Button variant="secondary" onClick={() => setAskOpen(true)}>
            Ask about this case
          </Button>
          {canWrite ? (
            <>
              <Dropdown>
                <DropdownTrigger asChild>
                  <Button variant="secondary">
                    <Pencil /> Draft <ChevronDown className="size-3.5 opacity-60" />
                  </Button>
                </DropdownTrigger>
                <DropdownContent className="w-72">
                  <DropdownLabel>Draft from documented evidence</DropdownLabel>
                  {LETTER_KINDS.map((l) => (
                    <DropdownItem key={l.kind} onSelect={() => runDraft(l.kind)} className="items-start">
                      <FileText className="mt-0.5" />
                      <span className="grid">
                        <span>{l.label}</span>
                        <span className="text-xs text-muted">{l.description}</span>
                      </span>
                    </DropdownItem>
                  ))}
                </DropdownContent>
              </Dropdown>
              <Button variant="primary" onClick={runEvaluate} loading={live.running}>
                {!live.running ? <Play /> : null}
                {live.running ? "Checking…" : ev ? "Check again" : "Check against policy"}
              </Button>
              <Dropdown>
                <DropdownTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownTrigger>
                <DropdownContent>
                  <DropdownItem onSelect={() => update.mutate({ status: "submitted" }, { onSuccess: () => toast.success("Marked as submitted") })}>
                    <Send /> Mark submitted
                  </DropdownItem>
                  <DropdownItem onSelect={() => update.mutate({ status: "pending_payer" })}>
                    <History /> Mark pending payer
                  </DropdownItem>
                  <DropdownItem onSelect={() => setOutcomeOpen(true)}>
                    <BadgeCheck /> Record outcome…
                  </DropdownItem>
                  <DropdownSeparator />
                  <DropdownItem onSelect={() => switchTab("denials")}>
                    <Gavel /> Record a denial
                  </DropdownItem>
                  <DropdownItem danger onSelect={() => update.mutate({ status: "closed" }, { onSuccess: () => toast.success("Case closed") })}>
                    <CircleAlert /> Close case
                  </DropdownItem>
                </DropdownContent>
              </Dropdown>
            </>
          ) : null}
        </div>
      </div>

      {!live.running ? (
        <div className="mb-5">
          <NextActions caseId={id} onAction={onAction} />
        </div>
      ) : null}

      <div className={evidenceMode ? "grid grid-cols-1 gap-6" : "grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_300px]"}>
        <Tabs value={tab} onValueChange={switchTab} className="min-w-0">
          <TabsList className="mb-4 max-w-full overflow-x-auto scrollbar-thin">
            <TabsTrigger value="criteria">
              <ListChecks /> Requirements
            </TabsTrigger>
            <TabsTrigger value="evidence">
              <Split /> Evidence
            </TabsTrigger>
            <TabsTrigger value="gaps" count={gapsCount || null}>
              <CircleAlert /> Gaps
            </TabsTrigger>
            <TabsTrigger value="documents" count={k.documentsCount}>
              <Files /> Documents
            </TabsTrigger>
            <TabsTrigger value="letters">
              <FileText /> Letters
            </TabsTrigger>
            <TabsTrigger value="denials">
              <Gavel /> Denials
            </TabsTrigger>
            <TabsTrigger value="timeline">
              <History /> Timeline
            </TabsTrigger>
            {can("audit:read") ? (
              <TabsTrigger value="audit">
                <ScrollText /> Audit
              </TabsTrigger>
            ) : null}
          </TabsList>
          <TabsContent value="criteria">
            {evLoading ? panelSkeleton : <CriteriaPanel
              caseId={id}
              evaluation={live.running ? undefined : ev}
              live={live}
              onEvaluate={runEvaluate}
              canEvaluate={canWrite}
              onJump={(cid) => {
                setCriterion(cid);
                switchTab("evidence");
              }}
            />}
          </TabsContent>
          <TabsContent value="evidence">
            {evLoading ? panelSkeleton : <EvidencePanel caseId={id} evaluation={ev} criterionId={criterion} onCriterion={setCriterion} />}
          </TabsContent>
          <TabsContent value="gaps">
            {evLoading ? panelSkeleton : <GapsPanel
              caseId={id}
              evaluation={ev}
              onReEvaluate={runEvaluate}
              canWrite={canWrite}
              onJump={(cid) => {
                setCriterion(cid);
                switchTab("evidence");
              }}
            />}
          </TabsContent>
          <TabsContent value="documents">
            <DocumentsPanel caseId={id} />
          </TabsContent>
          <TabsContent value="letters">
            <LettersPanel caseId={id} draft={draft} onDraft={runDraft} />
          </TabsContent>
          <TabsContent value="denials">
            <DenialsPanel caseId={id} onDraft={runDraft} canWrite={canWrite} />
          </TabsContent>
          <TabsContent value="timeline">
            <TimelinePanel caseId={id} />
          </TabsContent>
          {can("audit:read") ? (
            <TabsContent value="audit">
              <CaseAuditPanel caseId={id} />
            </TabsContent>
          ) : null}
        </Tabs>

        <aside className={evidenceMode ? "hidden" : "grid content-start gap-4"}>
          <Card>
            <CardHeader
              title="Case details"
              icon={<PanelRight />}
              actions={<RevealState visible={!!patient} remaining={phi.remaining} onHide={phi.hide} onReveal={() => phi.setOpen(true)} canReveal={canReveal} />}
            />
            <CardBody>
              <DataList
                items={[
                  { label: "Patient", value: patient ? patient.fullName : k.patient.displayName },
                  { label: "DOB", value: patient ? fmtDate(patient.dob) : `•• / •• / ${k.patient.birthYear}` },
                  { label: "Member ID", value: <span className="font-mono text-xs">{patient ? patient.memberId : "••••••••••"}</span> },
                  { label: "Payer", value: PAYER_LABEL[k.payerType] },
                  { label: "Plan", value: k.payerName },
                  { label: "Jurisdiction", value: k.state },
                  { label: "Place of service", value: k.placeOfService ?? "—" },
                  {
                    label: "Services",
                    value: (
                      <span className="flex flex-wrap gap-1">
                        {k.serviceCodes.map((s) => (
                          <CodeChip key={s} code={s} />
                        ))}
                      </span>
                    ),
                  },
                  {
                    label: "Diagnoses",
                    value: (
                      <span className="flex flex-wrap gap-1">
                        {k.dxCodes.map((s) => (
                          <CodeChip key={s} code={s} />
                        ))}
                      </span>
                    ),
                  },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Applicable policy" icon={<ScrollText />} />
            <CardBody className="grid gap-2">
              {k.policyRefs.length ? (
                k.policyRefs.map((p) => (
                  <button key={p.policyVersionId} onClick={() => router.push(`/policies/${p.policyId}`)} className="rounded-lg border border-border p-2.5 text-left transition-colors hover:border-border-strong">
                    <span className="font-mono text-xs font-medium text-fg">
                      {p.sourceKey} <span className="font-sans font-normal text-subtle">v{p.version}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted">{p.title}</span>
                  </button>
                ))
              ) : (
                <p className="text-[13px] text-muted">Identified when you run the first check.</p>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Assignee" />
            <CardBody>
              {canWrite ? (
                <Select
                  value={k.assignee?.id ?? "none"}
                  onValueChange={(v) => update.mutate({ assigneeId: v === "none" ? null : v })}
                  aria-label="Assignee"
                  options={[{ value: "none", label: "Unassigned" }, ...(members.data ?? []).map((m) => ({ value: m.id, label: m.fullName }))]}
                />
              ) : k.assignee ? (
                <span className="flex items-center gap-2 text-[13px]">
                  <Avatar name={k.assignee.fullName} color={k.assignee.avatarColor} size={22} /> {k.assignee.fullName}
                </span>
              ) : (
                <span className="text-[13px] text-muted">Unassigned</span>
              )}
            </CardBody>
          </Card>
        </aside>
      </div>

      {askOpen ? <AskDrawer caseId={id} caseNumber={k.number} open={askOpen} onOpenChange={setAskOpen} /> : null}
      {phi.open ? <RevealDialog open={phi.open} onOpenChange={phi.setOpen} onConfirm={phi.confirm} /> : null}
      {outcomeOpen ? <OutcomeDialog caseId={id} open={outcomeOpen} onOpenChange={setOutcomeOpen} /> : null}
    </AppPage>
  );
}

export default function CasePage() {
  return (
    <Suspense>
      <CaseInner />
    </Suspense>
  );
}
