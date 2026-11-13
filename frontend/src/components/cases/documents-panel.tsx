"use client";

import { Eye, EyeOff, FileJson, FileText, FileUp, ImageIcon, LockKeyhole, ScanText, ShieldAlert, ShieldCheck, Stethoscope, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useCaseDocument, useCaseDocuments, useDeleteDocument, useUploadDocument } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import type { CaseDocument } from "@/lib/api/types";
import { fmtBytes, fmtDate, fmtRelative, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge, Card, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Field, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, Tooltip } from "@/components/ui/overlays";
import { Dropzone } from "@/components/ui/widgets";
import { DeidText } from "@/components/domain/verdict";
import { AddNoteDialog } from "./side-panels";

const KIND_ICON: Record<CaseDocument["kind"], typeof FileText> = {
  clinical_note: Stethoscope,
  fhir_bundle: FileJson,
  pdf: FileText,
  imaging_report: ImageIcon,
  therapy_note: FileText,
  denial_letter: FileText,
  other: FileText,
};

function RevealDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (v: boolean) => void; onConfirm: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Reveal protected health information?" description="Identifiers are decrypted for this view only. The access, your reason and the time are written to the audit log." size="sm">
        <Field label="Reason for access" hint="Minimum-necessary standard (HIPAA §164.502(b))">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Verify member ID before submission" autoFocus className="min-h-20" />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={reason.trim().length < 5}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            <LockKeyhole /> Reveal and log access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DocumentsPanel({ caseId, initialDocId }: { caseId: string; initialDocId?: string | null }) {
  const { can } = useSession();
  const docs = useCaseDocuments(caseId);
  const upload = useUploadDocument(caseId);
  const del = useDeleteDocument(caseId);
  const [active, setActive] = useState<string | null>(initialDocId ?? null);
  const [reveal, setReveal] = useState(false);
  const [askReveal, setAskReveal] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const list = useMemo(() => docs.data ?? [], [docs.data]);
  useEffect(() => {
    if (!active && list[0]) setActive(list[0].id);
  }, [list, active]);
  const doc = useCaseDocument(caseId, active, reveal);
  const meta = list.find((d) => d.id === active);
  const canWrite = can("cases:write");

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      <div className="grid content-start gap-3">
        {canWrite ? (
          <>
            <Dropzone onFiles={(files) => files.forEach((file) => upload.mutate({ file, kind: /mri|ct|imaging/i.test(file.name) ? "imaging_report" : file.name.endsWith(".json") ? "fhir_bundle" : "clinical_note" }))} className="py-6" />
            <Button variant="secondary" size="sm" onClick={() => setNoteOpen(true)}>
              <FileUp /> Paste a note or attestation
            </Button>
          </>
        ) : null}
        <Card className="overflow-hidden">
          {docs.isPending ? (
            <Skeleton className="m-3 h-40" />
          ) : list.length === 0 ? (
            <EmptyState compact art="documents" title="No documents yet" description="Upload progress notes, imaging and therapy records." />
          ) : (
            <ul>
              {list.map((d) => {
                const Icon = KIND_ICON[d.kind];
                return (
                  <li key={d.id}>
                    <button
                      onClick={() => {
                        setActive(d.id);
                        setReveal(false);
                      }}
                      className={cn("flex w-full items-start gap-3 border-b border-border/70 px-3 py-2.5 text-left transition-colors last:border-0", d.id === active ? "bg-brand-soft/40" : "hover:bg-surface-2/60")}
                    >
                      <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md", d.quarantined ? "bg-notmet-soft text-notmet" : "bg-surface-2 text-muted")}>
                        {d.quarantined ? <ShieldAlert className="size-3.5" /> : <Icon className="size-3.5" />}
                      </span>
                      <span className="grid min-w-0 gap-0.5">
                        <span className="truncate text-[13px] font-medium text-fg">{d.filename}</span>
                        <span className="text-xs text-muted">
                          {titleCase(d.kind)} · {d.noteDate ? fmtDate(d.noteDate) : "undated"} · {fmtBytes(d.sizeBytes)}
                        </span>
                        <span className="flex flex-wrap gap-1 pt-0.5">
                          {d.quarantined ? <Badge tone="notmet" size="xs">Quarantined</Badge> : <Badge tone="met" size="xs">Clean</Badge>}
                          {d.redactions ? <Badge size="xs">{d.redactions} redactions</Badge> : null}
                          {d.ocrUsed ? (
                            <Badge size="xs">
                              <ScanText /> OCR
                            </Badge>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card className="flex min-h-[520px] flex-col overflow-hidden">
        {meta ? (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
              <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{meta.filename}</p>
              <span className="text-xs text-subtle">
                Uploaded by {meta.uploadedBy?.fullName ?? "—"} · {fmtRelative(meta.createdAt)}
              </span>
              {reveal ? (
                <Button size="xs" variant="ghost" onClick={() => setReveal(false)}>
                  <EyeOff /> Hide PHI
                </Button>
              ) : (
                <Tooltip content="Decrypts identifiers for this view and writes an audit event">
                  <Button size="xs" variant="secondary" onClick={() => setAskReveal(true)}>
                    <Eye /> Reveal PHI
                  </Button>
                </Tooltip>
              )}
              {canWrite ? (
                <Button size="icon-sm" variant="ghost" aria-label="Delete document" onClick={() => del.mutate(meta.id, { onSuccess: () => setActive(null) })}>
                  <Trash2 />
                </Button>
              ) : null}
            </div>
            {meta.quarantined ? (
              <div className="flex gap-3 border-b border-notmet/20 bg-notmet-soft/60 px-4 py-3 text-[13px] text-notmet-fg">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <p>
                  <span className="font-medium">Quarantined — excluded from evidence.</span> The prompt-injection screen scored this document {Math.round(meta.injectionScore * 100)}% for instruction-like content (e.g. “ignore all previous instructions”). It will not be sent to any model. Upload a clean copy from the source system.
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-2 border-b border-border bg-met-soft/30 px-4 py-2 text-xs text-met-fg">
                <ShieldCheck className="size-3.5" />
                {reveal ? "Identifiers revealed — this access was logged." : "De-identified view. Identifiers are shown as tokens; models only ever see this version."}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
              {doc.isPending ? <Skeleton className="h-64" /> : <DeidText text={doc.data?.text ?? ""} />}
            </div>
          </>
        ) : (
          <EmptyState art="documents" title="Select a document" />
        )}
      </Card>
      <RevealDialog open={askReveal} onOpenChange={setAskReveal} onConfirm={() => setReveal(true)} />
      {noteOpen ? <AddNoteDialog caseId={caseId} open={noteOpen} onOpenChange={setNoteOpen} /> : null}
    </div>
  );
}
