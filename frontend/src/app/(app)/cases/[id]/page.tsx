"use client";

import {
  BadgeCheck,
  ChevronDown,
  CircleAlert,
  Eye,
  FileText,
  Files,
  Gavel,
  History,
  ListChecks,
  LockKeyhole,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Play,
  ScrollText,
  Send,
  Split,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api/client";
import { useCase, useCreateConversation, useEvaluation, useMembers, useRecordOutcome, useUpdateCase } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import type { NextAction } from "@/lib/api/types";
import { fmtDate, PAYER_LABEL } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { CriteriaPanel } from "@/components/cases/criteria-panel";
import { DenialsPanel } from "@/components/cases/denials-panel";
import { DocumentsPanel } from "@/components/cases/documents-panel";
import { EvidencePanel } from "@/components/cases/evidence-panel";
import { LETTER_KINDS, LettersPanel } from "@/components/cases/letters-panel";
import { CaseAuditPanel, GapsPanel, NextActions, TimelinePanel } from "@/components/cases/side-panels";
import { useCaseStream } from "@/components/cases/use-case-stream";
import { ChatThread, Composer, AssistantIntro } from "@/components/assistant/chat";
import { useChat } from "@/components/assistant/use-chat";
import { CodeChip, PayerChip, PriorityChip, ReadinessRing, SlaTimer, StatusChip } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { Select, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/controls";
import { Avatar, Badge, Breadcrumb, Card, CardBody, CardHeader, DataList, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Field, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger, Sheet, SheetContent } from "@/components/ui/overlays";

function AskDrawer({ caseId, caseNumber, open, onOpenChange }: { caseId: string; caseNumber: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [convId, setConvId] = useState<string | null>(null);
  const create = useCreateConversation();
  const chat = useChat(convId);
  const busy = !!chat.pending && chat.pending.stage !== "done" && chat.pending.stage !== "error";
  const ensure = async () => {
    if (convId) return convId;
    const c = await create.mutateAsync(`Case ${caseNumber}`);
    setConvId(c.id);
    return c.id;
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title={`Ask about ${caseNumber}`} description="Answers are grounded in the matched policy and this case's de-identified chart." className="max-w-[min(100vw,34rem)]">
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <ChatThread compact messages={chat.messages} pending={chat.pending} pendingUser={chat.pendingUser} empty={<AssistantIntro title="Ask about this case" />} />
          </div>
          <div className="border-t border-border p-3">
            <Composer
              context={`case:${caseId}`}
              showSuggestions={!chat.messages.length && !chat.pending}
              busy={busy}
              onStop={chat.stop}
              placeholder="e.g. What would close the conservative-care gap?"
              onSend={async (t) => {
                const id = await ensure();
                void chat.send(t, { caseId, conversationId: id });
              }}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function OutcomeDialog({ caseId, open, onOpenChange }: { caseId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [outcome, setOutcome] = useState("approved");
  const [note, setNote] = useState("");
  const rec = useRecordOutcome(caseId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Record payer outcome" description="Outcomes feed analytics and the evaluation set — Necessa's verdicts are never the decision." size="sm">
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
  const { can } = useSession();
  const c = useCase(id);
  const evaluation = useEvaluation(id, c.data?.latestEvaluationId);
  const members = useMembers();
  const update = useUpdateCase(id);
  const { live, evaluate, draft, draftLetter } = useCaseStream(id);
  const [tab, setTab] = useState(params.get("tab") ?? "criteria");
  const [criterion, setCriterion] = useState<string | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [patient, setPatient] = useState<{ fullName: string; dob: string; memberId: string; mrn: string } | null>(null);
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
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="mt-4 h-96 rounded-xl" />
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
  const revealPatient = async () => {
    try {
      const r = await api.get<{ patientRevealed: typeof patient }>(`/cases/${id}`, { reveal: true });
      setPatient(r.patientRevealed);
      toast.message("Access logged", { description: "PHI reveal recorded in the audit trail." });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Cases", href: "/cases" }, { label: k.number }]} />} wide>
      {/* Header */}
      <div className="flex flex-col gap-4 pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <ReadinessRing size={58} stroke={5} readiness={live.running && !live.aggregate ? "unknown" : readiness} score={score} />
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
            <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.02em] text-fg">{k.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
              <span className="flex items-center gap-1.5">
                <UserRound className="size-3.5" /> {k.patient.displayName} · {k.patient.sex}, {new Date().getFullYear() - k.patient.birthYear}
              </span>
              <PayerChip payerType={k.payerType} payerName={`${k.payerName} · ${k.state}`} />
              <span>DOS {fmtDate(k.dateOfService)}</span>
              {!["approved", "closed", "denied"].includes(k.status) ? <SlaTimer dueAt={k.dueAt} /> : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => setAskOpen(true)}>
            <Sparkles className="text-ai-2" /> Ask about this case
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
                  <DropdownLabel>Generate from verified evidence</DropdownLabel>
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
              <Button variant="ai" onClick={runEvaluate} loading={live.running}>
                {!live.running ? <Play /> : null}
                {live.running ? "Evaluating…" : ev ? "Re-evaluate" : "Evaluate"}
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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Tabs value={tab} onValueChange={switchTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="criteria">
              <ListChecks /> Criteria
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
            <CriteriaPanel
              caseId={id}
              evaluation={live.running ? undefined : ev}
              live={live}
              onEvaluate={runEvaluate}
              canEvaluate={canWrite}
              onJump={(cid) => {
                setCriterion(cid);
                switchTab("evidence");
              }}
            />
          </TabsContent>
          <TabsContent value="evidence">
            <EvidencePanel caseId={id} evaluation={ev} criterionId={criterion} onCriterion={setCriterion} />
          </TabsContent>
          <TabsContent value="gaps">
            <GapsPanel caseId={id} evaluation={ev} onReEvaluate={runEvaluate} canWrite={canWrite} />
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

        <aside className="grid content-start gap-4">
          <Card>
            <CardHeader
              title="Case details"
              icon={<PanelRight />}
              actions={
                patient ? (
                  <Badge tone="insufficient" size="xs">
                    <Eye /> PHI visible
                  </Badge>
                ) : (
                  <Button size="xs" variant="ghost" onClick={revealPatient}>
                    <LockKeyhole /> Reveal
                  </Button>
                )
              }
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
                <p className="text-[13px] text-muted">Resolved on first evaluation.</p>
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
              {ev?.tokenUsage ? (
                <p className="mt-3 text-xs text-subtle">
                  Last evaluation: {(ev.tokenUsage.promptTokens + ev.tokenUsage.completionTokens).toLocaleString()} tokens · {ev.modelInfo?.judge}
                </p>
              ) : null}
            </CardBody>
          </Card>
        </aside>
      </div>

      <AskDrawer caseId={id} caseNumber={k.number} open={askOpen} onOpenChange={setAskOpen} />
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
