"use client";

import {
  Activity,
  ArrowRight,
  BadgeCheck,
  CircleAlert,
  ClipboardPaste,
  FilePlus2,
  FileText,
  Gavel,
  MessageSquare,
  Pencil,
  Play,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { useAddTextDocument, useAudit, useComment, useNextActions, useTimeline } from "@/lib/api/hooks";
import type { Evaluation, Gap, NextAction } from "@/lib/api/types";
import { fmtDateTime, fmtRelative, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Avatar, Badge, Card, CardBody, CardHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/overlays";
import { Timeline } from "@/components/ui/widgets";
import { VerdictBadge } from "@/components/domain/verdict";

/* ── Add-note dialog (used by gaps & documents) ─────────────────────────── */
export function AddNoteDialog({ caseId, open, onOpenChange, prefill }: { caseId: string; open: boolean; onOpenChange: (v: boolean) => void; prefill?: string }) {
  const [text, setText] = useState(prefill ?? "");
  const [kind, setKind] = useState("clinical_note");
  const [noteDate, setNoteDate] = useState(new Date().toISOString().slice(0, 10));
  const add = useAddTextDocument(caseId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add documentation" description="Paste the note or attestation. It's de-identified and screened before it can be used as evidence." size="lg">
        <div className="grid gap-4">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-48 font-mono text-[12.5px]" placeholder="e.g. PRE-PROCEDURE ATTESTATION — No active systemic or local infection. Anticoagulants: none." autoFocus />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Document type">
              <Select
                value={kind}
                onValueChange={setKind}
                options={[
                  { value: "clinical_note", label: "Clinical note / attestation" },
                  { value: "therapy_note", label: "Therapy note" },
                  { value: "imaging_report", label: "Imaging report" },
                  { value: "other", label: "Other" },
                ]}
              />
            </Field>
            <Field label="Note date">
              <Input type="date" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} disabled={text.trim().length < 10} onClick={() => add.mutate({ kind, text, noteDate, title: titleCase(kind) }, { onSuccess: () => onOpenChange(false) })}>
            <FilePlus2 /> Add to chart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Next best actions strip ────────────────────────────────────────────── */
const ACTION_ICON: Record<NextAction["type"], typeof Play> = {
  upload_document: FilePlus2,
  evaluate: Play,
  review: BadgeCheck,
  draft_letter: Pencil,
  submit: Send,
  appeal: Gavel,
  fix_gap: CircleAlert,
};

export function NextActions({ caseId, onAction }: { caseId: string; onAction: (a: NextAction) => void }) {
  const { data, isPending } = useNextActions(caseId);
  if (isPending) return <Skeleton className="h-16 rounded-xl" />;
  if (!data?.length) return null;
  return (
    <div className="ai-border rounded-xl p-3">
      <p className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted">
        <Sparkles className="size-3.5 text-ai-2" /> Suggested next steps
      </p>
      <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {data.slice(0, 3).map((a, i) => {
          const Icon = ACTION_ICON[a.type];
          return (
            <button key={i} onClick={() => onAction(a)} className="group flex items-start gap-2.5 rounded-lg bg-surface px-3 py-2.5 text-left shadow-e1 transition-shadow hover:shadow-e2">
              <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md", a.priority === "high" ? "bg-notmet-soft text-notmet" : "bg-brand-soft text-brand")}>
                <Icon className="size-3.5" />
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="text-[13px] font-medium text-fg">{a.title}</span>
                <span className="line-clamp-2 text-xs text-muted">{a.detail}</span>
              </span>
              <ArrowRight className="ml-auto mt-1 size-3.5 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Gaps ───────────────────────────────────────────────────────────────── */
export function GapsPanel({ caseId, evaluation, onReEvaluate, canWrite }: { caseId: string; evaluation?: Evaluation; onReEvaluate: () => void; canWrite: boolean }) {
  const [addFor, setAddFor] = useState<Gap | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  if (!evaluation) return <Card><EmptyState art="search" title="No gaps yet" description="Run an evaluation to see what documentation is missing." /></Card>;
  if (!evaluation.gaps.length)
    return (
      <Card>
        <EmptyState art="shield" title="No documentation gaps" description="Every criterion is supported by verified chart evidence. Draft the letter and send it for clinician sign-off." />
      </Card>
    );
  const criterion = (id: string) => evaluation.criteria.find((c) => c.criterionId === id);
  return (
    <div className="grid gap-3">
      {evaluation.gaps.map((g) => {
        const c = criterion(g.criterionId);
        const done = resolved.has(g.criterionId);
        return (
          <Card key={g.criterionId} className={cn("overflow-hidden", done && "opacity-60")}>
            <div className={cn("h-0.5", g.severity === "blocker" ? "bg-notmet" : g.severity === "major" ? "bg-insufficient" : "bg-subtle")} />
            <div className="grid gap-4 p-4 md:grid-cols-[1fr_auto]">
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={g.severity === "blocker" ? "notmet" : g.severity === "major" ? "insufficient" : "neutral"} size="xs">
                    {g.severity}
                  </Badge>
                  <span className="font-mono text-xs text-subtle">{g.criterionId}</span>
                  {c ? <VerdictBadge verdict={c.effectiveVerdict} size="xs" short /> : null}
                </div>
                <h3 className="text-[14px] font-semibold tracking-tight text-fg">{g.title}</h3>
                <p className="text-[13px] text-muted">{g.detail}</p>
                <div className="rounded-lg bg-met-soft/50 p-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-met-fg">
                    <Sparkles className="size-3" /> Suggested fix
                  </p>
                  <p className="mt-1 text-[13px] text-fg">{g.suggestedFix}</p>
                </div>
                <p className="text-xs text-subtle">
                  Policy: <span className="italic">“{g.policyQuote}”</span>
                </p>
              </div>
              {canWrite ? (
                <div className="flex gap-2 md:flex-col">
                  <Button size="sm" variant="primary" onClick={() => setAddFor(g)}>
                    <ClipboardPaste /> Add documentation
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setResolved((s) => new Set(s).add(g.criterionId))} disabled={done}>
                    <BadgeCheck /> {done ? "Marked resolved" : "Mark resolved"}
                  </Button>
                </div>
              ) : null}
            </div>
          </Card>
        );
      })}
      {canWrite ? (
        <div className="flex items-center justify-between rounded-xl border border-dashed border-border-strong px-4 py-3 text-[13px] text-muted">
          Added documentation? Re-run the check to update verdicts.
          <Button size="sm" variant="secondary" onClick={onReEvaluate}>
            <RotateCcw /> Re-run evaluation
          </Button>
        </div>
      ) : null}
      {addFor ? (
        <AddNoteDialog
          caseId={caseId}
          open={!!addFor}
          onOpenChange={(v) => !v && setAddFor(null)}
          prefill={addFor.criterionId === "C7" ? "PRE-PROCEDURE ATTESTATION\nNo active systemic or local infection at the planned injection site. Anticoagulants: none. Bleeding history: none.\nSigned: " : ""}
        />
      ) : null}
    </div>
  );
}

/* ── Timeline ───────────────────────────────────────────────────────────── */
const EVENT_META: Record<string, { icon: typeof Activity; label: (p: Record<string, unknown>) => string; tone?: "brand" | "met" | "notmet" | "insufficient" }> = {
  created: { icon: FilePlus2, label: () => "opened the case" },
  document_added: { icon: FileText, label: (p) => `added ${p.filename ?? "a document"}${p.quarantined ? " (quarantined)" : ""}` },
  document_removed: { icon: FileText, label: () => "removed a document" },
  policy_resolved: { icon: ShieldCheck, label: (p) => `matched ${p.sourceKey} v${p.version}`, tone: "brand" },
  evaluation_started: { icon: Play, label: () => "started a medical-necessity check", tone: "brand" },
  evaluation_completed: { icon: Workflow, label: (p) => `finished evaluating — readiness ${Math.round(Number(p.score ?? 0) * 100)}%${p.gaps ? `, ${p.gaps} gaps` : ""}`, tone: "met" },
  verdict_overridden: { icon: Pencil, label: (p) => `overrode ${p.criterionId} to ${String(p.to).replace("_", " ").toLowerCase()}`, tone: "insufficient" },
  review_completed: { icon: BadgeCheck, label: () => "completed clinical review", tone: "met" },
  letter_drafted: { icon: Pencil, label: (p) => `drafted a ${String(p.kind ?? "letter").replace(/_/g, " ")}` },
  letter_approved: { icon: BadgeCheck, label: () => "approved a letter", tone: "met" },
  denial_recorded: { icon: Gavel, label: (p) => `recorded a denial (CARC ${(p.carc as string[] | string) ?? "—"})`, tone: "notmet" },
  status_changed: { icon: Activity, label: (p) => `moved the case to ${String(p.to).replace(/_/g, " ")}` },
  outcome_recorded: { icon: BadgeCheck, label: (p) => `recorded payer outcome: ${p.outcome}` },
  assigned: { icon: Activity, label: (p) => `assigned the case to ${p.to}` },
  comment: { icon: MessageSquare, label: () => "commented" },
};

export function TimelinePanel({ caseId }: { caseId: string }) {
  const { data, isPending } = useTimeline(caseId);
  const comment = useComment(caseId);
  const [body, setBody] = useState("");
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardBody className="pt-4">
          {isPending ? (
            <Skeleton className="h-60" />
          ) : (
            <Timeline
              items={(data ?? []).map((e) => {
                const meta = EVENT_META[e.type] ?? { icon: Activity, label: () => e.type.replace(/_/g, " ") };
                const Icon = meta.icon;
                return {
                  id: e.id,
                  icon: <Icon />,
                  tone: meta.tone,
                  title: (
                    <>
                      <span className="font-medium">{e.actor?.fullName ?? "Necessa"}</span> <span className="text-muted">{meta.label(e.payload)}</span>
                    </>
                  ),
                  meta: <span title={fmtDateTime(e.createdAt)}>{fmtRelative(e.createdAt)}</span>,
                  body: e.type === "comment" ? <p className="rounded-lg bg-surface-2 px-3 py-2 text-fg">{String(e.payload.body)}</p> : e.type === "verdict_overridden" && e.payload.reason ? <p className="italic">“{String(e.payload.reason)}”</p> : undefined,
                };
              })}
            />
          )}
        </CardBody>
      </Card>
      <Card className="h-fit">
        <CardHeader title="Add a comment" description="Visible to everyone on this case. Avoid PHI beyond what's needed." />
        <CardBody className="grid gap-2">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="@Dr. Raman — can you add the attestation before Friday?" />
          <Button variant="primary" size="sm" className="justify-self-end" disabled={!body.trim()} loading={comment.isPending} onClick={() => comment.mutate(body, { onSuccess: () => setBody("") })}>
            <Send /> Comment
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

/* ── Case audit ─────────────────────────────────────────────────────────── */
export function CaseAuditPanel({ caseId }: { caseId: string }) {
  const { data, isPending } = useAudit({ resourceId: caseId });
  const rows = data?.items ?? [];
  return (
    <Card>
      <CardHeader title="Audit trail" description="Every access and AI-assisted action on this case — hash-chained and tamper-evident." icon={<ShieldCheck />} />
      <CardBody className="px-0">
        {isPending ? (
          <Skeleton className="mx-4 h-40" />
        ) : rows.length === 0 ? (
          <EmptyState compact art="shield" title="No audit events for this case yet" />
        ) : (
          <table className="w-full text-[13px]">
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-t border-border/70">
                  <td className="px-4 py-2 font-mono text-xs text-subtle">#{a.id}</td>
                  <td className="py-2">
                    <span className="flex items-center gap-2">
                      <Avatar name={a.actor?.fullName ?? "System"} color={a.actor?.avatarColor ?? "var(--degraded)"} size={20} />
                      {a.actor?.fullName ?? "System"}
                    </span>
                  </td>
                  <td className="py-2 font-mono text-xs text-fg">{a.action}</td>
                  <td className="hidden py-2 text-xs text-muted md:table-cell">{Object.entries(a.metadata).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")}</td>
                  <td className="px-4 py-2 text-right text-xs text-subtle">{fmtRelative(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardBody>
    </Card>
  );
}
