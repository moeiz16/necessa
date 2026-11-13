"use client";

import { ArrowUp, Bot, ChevronDown, Code2, Copy, Database, ShieldAlert, Sparkles, Square, ThumbsDown, ThumbsUp, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { useMessageFeedback, useSuggestions } from "@/lib/api/hooks";
import type { Citation, Message, SqlResult } from "@/lib/api/types";
import { fmtMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SqlChart } from "@/components/charts/charts";
import { CitationChip } from "@/components/domain/verdict";
import { LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Badge, CodeBlock, Skeleton } from "@/components/ui/display";
import { Tooltip } from "@/components/ui/overlays";
import type { PendingMessage } from "./use-chat";

function withCitationLinks(md: string) {
  return md.replace(/\[(\d{1,2})\](?!\()/g, "[$1](#cite-$1)");
}

export function Answer({ content, citations }: { content: string; citations: Citation[] }) {
  return (
    <div className="text-[14px] leading-[1.7] text-fg [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_strong]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&>*:first-child]:mt-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const m = href?.match(/^#cite-(\d+)$/);
            if (m) {
              const c = citations.find((x) => x.n === Number(m[1]));
              return c ? <CitationChip citation={c} /> : <span className="text-subtle">[{children}]</span>;
            }
            return (
              <a href={href} className="text-brand underline-offset-2 hover:underline" target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {withCitationLinks(content)}
      </ReactMarkdown>
    </div>
  );
}

export function SqlAnswer({ sql }: { sql: SqlResult }) {
  const [showSql, setShowSql] = useState(false);
  return (
    <div className="mt-3 grid gap-3 rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Database className="size-3.5" /> {sql.rows.length} row{sql.rows.length === 1 ? "" : "s"} · read-only · tenant-scoped views
        <button onClick={() => setShowSql(!showSql)} className="ml-auto inline-flex items-center gap-1 text-brand hover:underline">
          <Code2 className="size-3.5" /> {showSql ? "Hide" : "Show"} SQL
          <ChevronDown className={cn("size-3 transition-transform", showSql && "rotate-180")} />
        </button>
      </div>
      {showSql ? <CodeBlock code={sql.sql} language="sql" /> : null}
      <SqlChart result={sql} height={200} />
      <div className="overflow-x-auto rounded-lg border border-border scrollbar-thin">
        <table className="w-full text-[12.5px]">
          <thead className="bg-surface-2">
            <tr>
              {sql.columns.map((c) => (
                <th key={c} className="px-3 py-1.5 text-left font-mono text-[11px] font-medium text-muted">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sql.rows.map((r, i) => (
              <tr key={i} className="border-t border-border/70">
                {r.map((v, j) => (
                  <td key={j} className={cn("px-3 py-1.5", typeof v === "number" && "tabular text-right")}>
                    {v ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sql.warnings?.length ? <p className="text-[11px] text-subtle">{sql.warnings.join(" ")}</p> : null}
    </div>
  );
}

function Guardrails({ items }: { items: { kind: string; message: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="mb-2 grid gap-1.5">
      {items.map((g, i) => (
        <p key={i} className={cn("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs", g.kind === "injection" ? "bg-notmet-soft text-notmet-fg" : g.kind === "abstain" ? "bg-insufficient-soft text-insufficient-fg" : "bg-surface-2 text-muted")}>
          <ShieldAlert className="size-3.5 shrink-0" />
          <span className="font-medium capitalize">{g.kind}</span> · {g.message}
        </p>
      ))}
    </div>
  );
}

function AssistantBubble({ m, selected, onSelect }: { m: Message; selected: boolean; onSelect: () => void }) {
  const feedback = useMessageFeedback();
  const [rated, setRated] = useState<1 | -1 | null>(m.feedback ?? null);
  return (
    <div className="group flex gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-soft">
        <LogoMark size={16} variant="glyph" className="text-brand" strokeWidth={3.6} />
      </span>
      <div className="min-w-0 flex-1">
        <Guardrails items={m.guardrails ?? []} />
        <Answer content={m.content} citations={m.citations} />
        {m.sql ? <SqlAnswer sql={m.sql} /> : null}
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-subtle">
          {m.route ? (
            <button onClick={onSelect} className={cn("inline-flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-surface-2 hover:text-fg", selected && "bg-brand-soft text-brand-fg")}>
              <Sparkles className="size-3" /> {m.route.strategy}
            </button>
          ) : null}
          {m.usage ? (
            <span className="px-1">
              {m.usage.provider}/{m.usage.model} · {fmtMs(m.usage.latencyMs ?? 0)}
            </span>
          ) : null}
          <span className="ml-auto flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
            <Tooltip content="Copy">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy answer"
                onClick={() => {
                  navigator.clipboard?.writeText(m.content);
                  toast.success("Copied");
                }}
              >
                <Copy />
              </Button>
            </Tooltip>
            <Tooltip content="Helpful">
              <Button variant="ghost" size="icon-sm" aria-label="Helpful" className={cn(rated === 1 && "text-met")} onClick={() => (setRated(1), feedback.mutate({ messageId: m.id, rating: 1 }))}>
                <ThumbsUp />
              </Button>
            </Tooltip>
            <Tooltip content="Not helpful">
              <Button variant="ghost" size="icon-sm" aria-label="Not helpful" className={cn(rated === -1 && "text-notmet")} onClick={() => (setRated(-1), feedback.mutate({ messageId: m.id, rating: -1, reason: "user_flagged" }))}>
                <ThumbsDown />
              </Button>
            </Tooltip>
          </span>
        </div>
      </div>
    </div>
  );
}

function PendingBubble({ p }: { p: PendingMessage }) {
  const stages = { routing: "Understanding the question…", retrieving: `Routing → ${p.route?.strategy ?? "…"}`, generating: "Writing a grounded answer…", done: "", error: "" };
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-soft">
        <LogoMark size={16} variant="glyph" className="animate-[pulse-dot_1.4s_ease-in-out_infinite] text-brand" strokeWidth={3.6} />
      </span>
      <div className="min-w-0 flex-1">
        <Guardrails items={p.guardrails} />
        {p.tools.map((t, i) => (
          <p key={i} className="mb-2 flex items-center gap-1.5 font-mono text-[11px] text-muted">
            <Wrench className="size-3" /> {t.name}({Object.entries(t.args).filter(([, v]) => v != null && !Array.isArray(v)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")})
          </p>
        ))}
        {p.content ? (
          <Answer content={p.content} citations={p.citations} />
        ) : p.stage === "error" ? (
          <p className="text-[13px] text-notmet-fg">{p.error}</p>
        ) : (
          <div className="grid gap-2">
            <p className="text-[13px] text-muted">{stages[p.stage]}</p>
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        )}
        {p.sql ? <SqlAnswer sql={p.sql} /> : null}
      </div>
    </div>
  );
}

export function ChatThread({
  messages,
  pending,
  pendingUser,
  selectedId,
  onSelect,
  compact,
  empty,
}: {
  messages: Message[];
  pending: PendingMessage | null;
  pendingUser: string | null;
  selectedId?: string | null;
  onSelect?: (m: Message) => void;
  compact?: boolean;
  empty?: React.ReactNode;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending?.content, pending?.stage]);
  if (!messages.length && !pending) return <>{empty}</>;
  const last = messages[messages.length - 1];
  const showPendingUser = !!pendingUser && !(last?.role === "user" && last.content === pendingUser);
  return (
    <div className={cn("grid gap-6", compact ? "px-4 py-4" : "px-1 py-6")}>
      {messages.map((m) =>
        m.role === "user" ? (
          <div key={m.id} className="flex justify-end">
            <p className="max-w-[85%] rounded-2xl rounded-br-md bg-fg px-3.5 py-2 text-[14px] text-bg">{m.content}</p>
          </div>
        ) : (
          <AssistantBubble key={m.id} m={m} selected={selectedId === m.id} onSelect={() => onSelect?.(m)} />
        ),
      )}
      {showPendingUser ? (
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-md bg-fg px-3.5 py-2 text-[14px] text-bg">{pendingUser}</p>
        </div>
      ) : null}
      {pending ? <PendingBubble p={pending} /> : null}
      <div ref={end} />
    </div>
  );
}

export function Composer({
  onSend,
  onStop,
  busy,
  placeholder = "Ask about coverage criteria, codes, a policy — or your own data…",
  context = "dashboard",
  showSuggestions,
  footer,
  autoFocus,
  initial,
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  busy?: boolean;
  placeholder?: string;
  context?: string;
  showSuggestions?: boolean;
  footer?: React.ReactNode;
  autoFocus?: boolean;
  initial?: string;
}) {
  const [text, setText] = useState(initial ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const sugg = useSuggestions(context);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  }, [text]);
  const submit = () => {
    if (!text.trim() || busy) return;
    onSend(text.trim());
    setText("");
  };
  return (
    <div className="grid gap-2">
      {showSuggestions && sugg.data?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {sugg.data.map((s) => (
            <button key={s.label} onClick={() => onSend(s.prompt)} disabled={busy} className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted shadow-e1 transition-colors hover:border-border-strong hover:text-fg disabled:opacity-50">
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rounded-2xl border border-border bg-surface p-2 shadow-e2 focus-within:border-brand/50 focus-within:ring-3 focus-within:ring-brand/10">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          aria-label="Message Necessa"
          className="block max-h-[180px] w-full resize-none bg-transparent px-2 py-1.5 text-[14px] text-fg outline-none placeholder:text-subtle"
        />
        <div className="flex items-center gap-2 px-1 pt-1">
          <div className="min-w-0 flex-1">{footer}</div>
          {busy ? (
            <Button size="icon" variant="secondary" onClick={onStop} aria-label="Stop generating">
              <Square className="size-3 fill-current" />
            </Button>
          ) : (
            <Button size="icon" variant="primary" onClick={submit} disabled={!text.trim()} aria-label="Send">
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function AssistantIntro({ title = "Ask Necessa", children }: { title?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-14 text-center">
      <span className="ai-gradient flex size-12 items-center justify-center rounded-2xl text-white shadow-e2">
        <Bot className="size-5" />
      </span>
      <h2 className="mt-5 font-display text-3xl tracking-tight text-fg">{title}</h2>
      <p className="mt-2 max-w-md text-[13px] text-muted">
        Grounded answers from LCDs, NCDs and billing articles — every claim cited, abstains when unsure. Ask about your own cases and it writes guarded, read-only SQL.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-1.5">
        <Badge tone="outline">Hybrid retrieval</Badge>
        <Badge tone="outline">Cross-encoder rerank</Badge>
        <Badge tone="outline">Text-to-SQL</Badge>
        <Badge tone="outline">Coverage graph</Badge>
      </div>
      {children}
    </div>
  );
}
