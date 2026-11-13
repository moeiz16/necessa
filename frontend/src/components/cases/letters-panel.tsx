"use client";

import { BadgeCheck, Download, Eye, FileJson, FilePen, FileText, Pencil, Printer, Sparkles, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api/client";
import { useLetters, useUpdateLetter } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import type { Letter, LetterKind } from "@/lib/api/types";
import { fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Avatar, Badge, Card, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Textarea } from "@/components/ui/input";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownTrigger } from "@/components/ui/overlays";

export const LETTER_KINDS: { kind: LetterKind; label: string; description: string }[] = [
  { kind: "lmn", label: "Letter of medical necessity", description: "Clinician-signed narrative citing chart evidence" },
  { kind: "pa_cover", label: "PA cover letter", description: "Short submission summary with criteria checklist" },
  { kind: "appeal", label: "Redetermination / appeal", description: "Addresses the denial reason criterion by criterion" },
  { kind: "peer_to_peer_prep", label: "Peer-to-peer brief", description: "Talking points for the reviewer call" },
];

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function printLetter(letter: Letter, html: string) {
  const w = window.open("", "_blank", "width=820,height=1000");
  if (!w) return toast.error("Allow pop-ups to export PDF");
  w.opener = null;
  w.document.write(`<!doctype html><html><head><title>${esc(letter.title)}</title><style>body{font:14px/1.6 Georgia,serif;color:#111;max-width:680px;margin:48px auto;padding:0 24px}h1,h2,h3{font-family:system-ui,sans-serif}blockquote{border-left:3px solid #ccc;margin:0;padding-left:12px;color:#555}ol{font-size:12px;color:#444}.foot{margin-top:32px;border-top:1px solid #ddd;padding-top:12px}</style></head><body>${html}<div class="foot"><ol>${letter.citations.map((c) => `<li><b>${esc(c.label)}</b> — “${esc(c.quote)}”</li>`).join("")}</ol></div></body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

export function LettersPanel({ caseId, draft, onDraft }: { caseId: string; draft: { letterId: string; text: string; running: boolean } | null; onDraft: (k: LetterKind) => void }) {
  const { can } = useSession();
  const letters = useLetters(caseId);
  const update = useUpdateLetter(caseId);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [text, setText] = useState("");
  const list = letters.data ?? [];
  const active = list.find((l) => l.id === (activeId ?? draft?.letterId)) ?? list[0];
  const streaming = draft?.running && draft.letterId === active?.id;

  useEffect(() => {
    if (draft?.letterId) setActiveId(draft.letterId);
  }, [draft?.letterId]);
  useEffect(() => {
    if (active && !streaming) setText(active.contentMd);
  }, [active, streaming]);

  const body = streaming ? draft!.text : text;
  const dirty = !!active && !streaming && text !== active.contentMd;

  if (letters.isPending) return <Skeleton className="h-96 rounded-xl" />;

  if (!list.length && !draft) {
    return (
      <Card>
        <EmptyState
          art="documents"
          title="No letters yet"
          description="Drafts are written only from verified chart evidence and footnoted to the policy and the chart. A clinician approves every letter."
          action={
            can("cases:write") ? (
              <div className="flex flex-wrap justify-center gap-2">
                {LETTER_KINDS.slice(0, 3).map((k) => (
                  <Button key={k.kind} variant={k.kind === "lmn" ? "ai" : "secondary"} size="sm" onClick={() => onDraft(k.kind)}>
                    {k.kind === "lmn" ? <Sparkles /> : <FilePen />} {k.label}
                  </Button>
                ))}
              </div>
            ) : null
          }
        />
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="grid content-start gap-2">
        {can("cases:write") ? (
          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant="ai" size="sm">
                <Sparkles /> Draft a new letter
              </Button>
            </DropdownTrigger>
            <DropdownContent align="start" className="w-72">
              <DropdownLabel>Letter type</DropdownLabel>
              {LETTER_KINDS.map((k) => (
                <DropdownItem key={k.kind} onSelect={() => onDraft(k.kind)} className="items-start">
                  <FilePen className="mt-0.5" />
                  <span className="grid">
                    <span>{k.label}</span>
                    <span className="text-xs text-muted">{k.description}</span>
                  </span>
                </DropdownItem>
              ))}
            </DropdownContent>
          </Dropdown>
        ) : null}
        {list.map((l) => (
          <button key={l.id} onClick={() => setActiveId(l.id)} className={cn("grid gap-1 rounded-lg border p-3 text-left transition-colors", l.id === active?.id ? "border-brand bg-brand-soft/30" : "border-border bg-surface hover:border-border-strong")}>
            <span className="line-clamp-2 text-[13px] font-medium text-fg">{l.title}</span>
            <span className="flex items-center gap-1.5">
              <Badge tone={l.status === "approved" ? "met" : l.status === "in_review" ? "brand" : "neutral"} size="xs">
                {l.status.replace("_", " ")}
              </Badge>
              <span className="text-xs text-subtle">
                v{l.version} · {fmtRelative(l.updatedAt)}
              </span>
            </span>
          </button>
        ))}
      </div>

      {active ? (
        <Card className="flex min-h-[560px] flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{active.title}</p>
            {streaming ? (
              <Badge tone="ai" size="sm">
                <Sparkles className="text-ai-2" /> Drafting…
              </Badge>
            ) : (
              <Segmented
                size="xs"
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: "preview", label: "Preview", icon: <Eye /> },
                  { value: "edit", label: "Edit", icon: <Pencil /> },
                ]}
              />
            )}
            <Dropdown>
              <DropdownTrigger asChild>
                <Button size="xs" variant="secondary" disabled={streaming}>
                  <Download /> Export
                </Button>
              </DropdownTrigger>
              <DropdownContent>
                <DropdownItem onSelect={() => printLetter(active, document.getElementById(`letter-${active.id}`)?.innerHTML ?? "")}>
                  <Printer /> PDF (print)
                </DropdownItem>
                <DropdownItem onSelect={() => download(`${active.title}.md`, body, "text/markdown")}>
                  <FileText /> Markdown
                </DropdownItem>
                <DropdownItem
                  onSelect={async () => {
                    try {
                      const fhir = await api.get(`/cases/${caseId}/export/fhir`);
                      download(`questionnaire-response-${caseId}.json`, JSON.stringify(fhir, null, 2), "application/fhir+json");
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  <FileJson /> FHIR QuestionnaireResponse
                </DropdownItem>
              </DropdownContent>
            </Dropdown>
          </div>
          <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_260px]">
            <div className="min-h-0 overflow-y-auto px-6 py-5 scrollbar-thin">
              {mode === "edit" && !streaming ? (
                <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-[440px] font-mono text-[12.5px] leading-relaxed" aria-label="Letter markdown" />
              ) : (
                <article id={`letter-${active.id}`} className="prose-letter max-w-none font-serif text-[14.5px] leading-[1.75] text-fg [&_blockquote]:my-3 [&_blockquote]:rounded-md [&_blockquote]:border-l-2 [&_blockquote]:border-insufficient [&_blockquote]:bg-insufficient-soft/50 [&_blockquote]:px-3 [&_blockquote]:py-2 [&_blockquote]:font-sans [&_blockquote]:text-[13px] [&_p]:my-3 [&_strong]:font-semibold">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{body || "…"}</ReactMarkdown>
                  {streaming ? <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-brand align-middle" /> : null}
                </article>
              )}
            </div>
            <aside className="border-t border-border bg-surface-2/40 px-4 py-4 lg:border-l lg:border-t-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Citations</p>
              <ol className="mt-2 grid gap-2.5">
                {active.citations.length === 0 ? <li className="text-xs text-muted">{streaming ? "Collecting…" : "No citations."}</li> : null}
                {active.citations.map((c) => (
                  <li key={c.n} className="grid gap-0.5 text-xs">
                    <span className="font-medium text-fg">
                      [{c.n}] {c.label}
                    </span>
                    <span className="text-muted">“{c.quote}”</span>
                  </li>
                ))}
              </ol>
              <div className="mt-5 grid gap-1 border-t border-border pt-4 text-xs text-subtle">
                <span>Drafted by {active.modelInfo?.drafter ?? "—"}</span>
                {active.modelInfo?.verifier ? <span>Verified by {active.modelInfo.verifier}</span> : null}
                <span>PHI tokens are re-inserted locally on export.</span>
              </div>
            </aside>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-2/40 px-4 py-2.5">
            {active.approvedBy ? (
              <span className="flex items-center gap-2 text-xs text-met-fg">
                <Avatar name={active.approvedBy.fullName} color={active.approvedBy.avatarColor} size={18} /> Approved by {active.approvedBy.fullName} · {fmtRelative(active.approvedAt)}
              </span>
            ) : (
              <span className="text-xs text-muted">Requires clinician approval before export to the payer.</span>
            )}
            <div className="flex gap-2">
              {dirty ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setText(active.contentMd)}>
                    <Undo2 /> Discard
                  </Button>
                  <Button size="sm" variant="secondary" loading={update.isPending} onClick={() => update.mutate({ letterId: active.id, contentMd: text }, { onSuccess: () => toast.success("Draft saved") })}>
                    Save draft
                  </Button>
                </>
              ) : null}
              {active.status === "draft" && can("cases:write") && !streaming ? (
                <Button size="sm" variant="secondary" onClick={() => update.mutate({ letterId: active.id, status: "in_review" }, { onSuccess: () => toast.success("Sent for clinician review") })}>
                  Send for review
                </Button>
              ) : null}
              {active.status !== "approved" && can("letters:approve") && !streaming ? (
                <Button size="sm" variant="primary" loading={update.isPending} onClick={() => update.mutate({ letterId: active.id, status: "approved", contentMd: dirty ? text : undefined }, { onSuccess: () => toast.success("Letter approved") })}>
                  <BadgeCheck /> Approve
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
