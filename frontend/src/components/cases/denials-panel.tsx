"use client";

import { CalendarClock, FilePen, Gavel, Link2, Target } from "lucide-react";
import { useState } from "react";
import { useCaseDenials, useRecordDenial, useUpdateDenial } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import type { Denial, LetterKind } from "@/lib/api/types";
import { fmtDate, titleCase } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Badge, Card, CardBody, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/overlays";

export const DENIAL_STATUS_TONE: Record<Denial["status"], "neutral" | "brand" | "insufficient" | "met" | "notmet" | "info"> = {
  new: "notmet",
  analyzing: "brand",
  appeal_drafted: "insufficient",
  appealed: "info",
  overturned: "met",
  upheld: "neutral",
};

export function daysLeft(date: string) {
  return Math.ceil((new Date(`${date}T23:59:59`).getTime() - Date.now()) / 86400_000);
}

function RecordDenialDialog({ caseId, open, onOpenChange }: { caseId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [text, setText] = useState("");
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().slice(0, 10));
  const [carc, setCarc] = useState("");
  const rec = useRecordDenial(caseId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Record a denial" description="Paste the denial reason from the notice or remittance. Necessa reads the reason codes and matches the reason to the policy requirement it cites." size="lg">
        <div className="grid gap-4">
          <Field label="Denial reason text">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-32" placeholder="The documentation submitted does not establish that the beneficiary failed at least 4 weeks of conservative care… Group code CO, CARC 50, RARC N115." autoFocus />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Received on">
              <Input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
            </Field>
            <Field label="CARC codes" optional hint="Comma-separated; detected from text if empty">
              <Input value={carc} onChange={(e) => setCarc(e.target.value)} placeholder="50" className="font-mono" />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={rec.isPending}
            disabled={text.trim().length < 15}
            onClick={() => rec.mutate({ text, receivedAt, carcCodes: carc.split(",").map((c) => c.trim()).filter(Boolean) }, { onSuccess: () => onOpenChange(false) })}
          >
            Analyze denial
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DenialsPanel({ caseId, onDraft, canWrite }: { caseId: string; onDraft: (k: LetterKind) => void; canWrite: boolean }) {
  const { can } = useSession();
  const denials = useCaseDenials(caseId);
  const update = useUpdateDenial(caseId);
  const [open, setOpen] = useState(false);
  if (denials.isPending) return <Skeleton className="h-60 rounded-xl" />;
  const list = denials.data ?? [];
  return (
    <div className="grid gap-4">
      {list.length === 0 ? (
        <Card>
          <EmptyState
            art="inbox"
            title="No denials on this case"
            description="If the payer denies, record the notice here. Necessa matches the reason to the policy requirement it cites and drafts the appeal."
            action={
              canWrite ? (
                <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
                  <Gavel /> Record a denial
                </Button>
              ) : null
            }
          />
        </Card>
      ) : (
        <>
          {canWrite ? (
            <Button variant="secondary" size="sm" className="w-fit" onClick={() => setOpen(true)}>
              <Gavel /> Record another denial
            </Button>
          ) : null}
          {list.map((d) => {
            const left = daysLeft(d.appealDeadline);
            return (
              <Card key={d.id}>
                <CardBody className="grid gap-4 pt-4 lg:grid-cols-[1.3fr_1fr]">
                  <div className="grid content-start gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={DENIAL_STATUS_TONE[d.status]} dot>
                        {titleCase(d.status)}
                      </Badge>
                      <Badge size="xs">{titleCase(d.category)}</Badge>
                      {d.carcCodes.map((c) => (
                        <Badge key={c} tone="outline" size="xs" className="font-mono">
                          CARC {c}
                        </Badge>
                      ))}
                      {d.rarcCodes.map((c) => (
                        <Badge key={c} tone="outline" size="xs" className="font-mono">
                          RARC {c}
                        </Badge>
                      ))}
                      <span className="text-xs text-subtle">received {fmtDate(d.receivedAt)}</span>
                    </div>
                    <blockquote className="rounded-lg border-l-2 border-notmet bg-notmet-soft/40 px-3 py-2.5 text-[13px] text-fg">{d.reasonText}</blockquote>
                    {d.analysis?.summary ? (
                      <p className="text-[13px] text-muted">{d.analysis.summary}</p>
                    ) : null}
                    {d.analysis?.strategy?.length ? (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Suggested approach</p>
                        <ol className="mt-1.5 grid gap-1 text-[13px] text-fg">
                          {d.analysis.strategy.map((s, i) => (
                            <li key={s} className="flex gap-2">
                              <span className="tabular w-4 shrink-0 text-xs text-subtle">{i + 1}.</span>
                              {s}
                            </li>
                          ))}
                        </ol>
                      </div>
                    ) : null}
                  </div>
                  <div className="grid content-start gap-3">
                    <div className="rounded-lg bg-surface-2/60 p-3">
                      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">
                        <Target className="size-3" /> Requirements this relates to
                      </p>
                      {d.mappedCriteria.length ? (
                        <ul className="mt-2 grid gap-1.5">
                          {d.mappedCriteria.map((m) => (
                            <li key={m.criterionId} className="flex items-start gap-2 text-[13px]">
                              <span className="font-mono text-xs text-subtle">{m.criterionId}</span>
                              <span className="min-w-0 flex-1 text-fg">{m.text}</span>
                              <span className="tabular text-xs text-muted">{Math.round(m.confidence * 100)}%</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-[13px] text-muted">No clear match. Please review manually.</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[13px]">
                      <CalendarClock className={left < 30 ? "size-4 text-notmet" : "size-4 text-subtle"} />
                      <span className="text-muted">Redetermination deadline</span>
                      <span className="ml-auto font-medium text-fg">{fmtDate(d.appealDeadline)}</span>
                      <Badge tone={left < 0 ? "neutral" : left < 30 ? "notmet" : "neutral"} size="xs">
                        {left < 0 ? "passed" : `${left} days`}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {d.appealLetterId ? (
                        <Badge tone="brand">
                          <Link2 /> Appeal drafted
                        </Badge>
                      ) : canWrite ? (
                        <Button size="sm" variant="primary" onClick={() => onDraft("appeal")}>
                          <FilePen /> Draft appeal
                        </Button>
                      ) : null}
                      {can("cases:write") ? (
                        <Select
                          size="sm"
                          className="w-44"
                          value={d.status}
                          onValueChange={(v) => update.mutate({ denialId: d.id, status: v })}
                          aria-label="Denial status"
                          options={(["new", "analyzing", "appeal_drafted", "appealed", "overturned", "upheld"] as Denial["status"][]).map((s) => ({ value: s, label: titleCase(s) }))}
                        />
                      ) : null}
                    </div>
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </>
      )}
      {open ? <RecordDenialDialog caseId={caseId} open={open} onOpenChange={setOpen} /> : null}
    </div>
  );
}
