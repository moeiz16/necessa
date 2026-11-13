"use client";

import { Eye, EyeOff, FileJson, FileText, FileUp, ImageIcon, ScanText, ShieldAlert, ShieldCheck, Stethoscope, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useCaseDocument, useCaseDocuments, useDeleteDocument, useUploadDocument } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import type { CaseDocument } from "@/lib/api/types";
import { fmtBytes, fmtDate, fmtRelative, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge, Card, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Dialog, DialogContent, DialogFooter, Tooltip } from "@/components/ui/overlays";
import { Dropzone } from "@/components/ui/widgets";
import { DeidText } from "@/components/domain/verdict";
import { REVEAL_SECONDS, RevealDialog } from "./case-chrome";
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

export function DocumentsPanel({ caseId, initialDocId }: { caseId: string; initialDocId?: string | null }) {
  const { can } = useSession();
  const docs = useCaseDocuments(caseId);
  const upload = useUploadDocument(caseId);
  const del = useDeleteDocument(caseId);
  const [active, setActive] = useState<string | null>(initialDocId ?? null);
  const [revealUntil, setRevealUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [askReveal, setAskReveal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reveal = !!revealUntil;
  useEffect(() => {
    if (!revealUntil) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= revealUntil) setRevealUntil(null);
    }, 1000);
    return () => clearInterval(t);
  }, [revealUntil]);
  const setReveal = (v: boolean) => setRevealUntil(v ? Date.now() + REVEAL_SECONDS * 1000 : null);
  const remaining = revealUntil ? Math.max(0, Math.round((revealUntil - now) / 1000)) : 0;
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
                          {d.quarantined ? <Badge tone="notmet" size="xs">Held back</Badge> : <Badge tone="met" size="xs">Cleared</Badge>}
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
            <div className="flex items-start gap-3 border-b border-border px-4 py-2.5">
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="truncate text-[13px] font-medium text-fg" title={meta.filename}>
                  {meta.filename}
                </p>
                <span className="truncate text-xs text-subtle">
                  {titleCase(meta.kind)} · uploaded by {meta.uploadedBy?.fullName ?? "—"} · {fmtRelative(meta.createdAt)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {reveal ? (
                  <>
                    <span className="tabular inline-flex items-center gap-1 rounded-md bg-insufficient-soft px-1.5 py-0.5 text-[11px] font-medium text-insufficient-fg" title="Identifiers re-mask automatically">
                      <Eye className="size-3" /> {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
                    </span>
                    <Button size="xs" variant="ghost" onClick={() => setReveal(false)}>
                      <EyeOff /> Mask
                    </Button>
                  </>
                ) : (
                  <Tooltip content="Decrypts identifiers for this view and writes an audit event">
                    <Button size="xs" variant="secondary" onClick={() => setAskReveal(true)}>
                      <Eye /> Reveal PHI
                    </Button>
                  </Tooltip>
                )}
                {canWrite ? (
                  <Tooltip content="Delete document">
                    <Button size="icon-sm" variant="ghost" aria-label="Delete document" onClick={() => setConfirmDelete(true)}>
                      <Trash2 />
                    </Button>
                  </Tooltip>
                ) : null}
              </div>
            </div>
            {meta.quarantined ? (
              <div className="flex gap-3 border-b border-notmet/20 bg-notmet-soft/60 px-4 py-3 text-[13px] text-notmet-fg">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                <p>
                  <span className="font-medium">Held back — not used as evidence.</span> This document contains text that looks like instructions to software rather than clinical notes, so Necessa did not read it. Upload a clean copy from the source system.
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-2 border-b border-border bg-met-soft/30 px-4 py-2 text-xs text-met-fg">
                <ShieldCheck className="size-3.5" />
                {reveal ? "Patient details are showing. This access was recorded in the audit trail." : "Protected view. Patient details are hidden, and only this version is used for checking."}
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
      {askReveal ? (
        <RevealDialog
          open={askReveal}
          onOpenChange={setAskReveal}
          onConfirm={async () => {
            setReveal(true);
            return true;
          }}
        />
      ) : null}
      {confirmDelete && meta ? (
        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogContent title="Delete this document?" description={`${meta.filename} will be removed from the chart and won't be used in future checks. The deletion is recorded in the audit trail.`} size="sm">
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={del.isPending}
                onClick={() =>
                  del.mutate(meta.id, {
                    onSuccess: () => {
                      setActive(null);
                      setConfirmDelete(false);
                    },
                  })
                }
              >
                <Trash2 /> Delete document
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {noteOpen ? <AddNoteDialog caseId={caseId} open={noteOpen} onOpenChange={setNoteOpen} /> : null}
    </div>
  );
}
