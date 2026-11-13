"use client";

import { CalendarDays, MessageSquarePlus, PanelRightClose, PanelRightOpen, Pin, PinOff, Search, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useConversations, useCreateConversation, useDeleteConversation, useUpdateConversation } from "@/lib/api/hooks";
import type { Message } from "@/lib/api/types";
import { fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { AssistantIntro, ChatThread, Composer } from "@/components/assistant/chat";
import { RetrievalInspector } from "@/components/assistant/inspector";
import { useChat } from "@/components/assistant/use-chat";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/controls";
import { Breadcrumb, Skeleton } from "@/components/ui/display";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/overlays";

type Mode = "auto" | "policy" | "analytics" | "codes";

function AssistantInner() {
  const params = useSearchParams();
  const router = useRouter();
  const convs = useConversations();
  const create = useCreateConversation();
  const updateConv = useUpdateConversation();
  const del = useDeleteConversation();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("auto");
  const [asOf, setAsOf] = useState("");
  const [filter, setFilter] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [selected, setSelected] = useState<Message | null>(null);
  const chat = useChat(activeId);
  const busy = !!chat.pending && chat.pending.stage !== "done" && chat.pending.stage !== "error";
  const handledQ = useRef(false);

  const list = useMemo(() => (convs.data?.items ?? []).filter((c) => c.title.toLowerCase().includes(filter.toLowerCase())), [convs.data, filter]);

  useEffect(() => {
    if (!activeId && list[0] && !params.get("q")) setActiveId(list[0].id);
  }, [list, activeId, params]);

  const startNew = async (firstMessage?: string) => {
    const c = await create.mutateAsync("New conversation");
    setActiveId(c.id);
    setSelected(null);
    if (firstMessage) void chat.send(firstMessage, { conversationId: c.id, mode, asOf: asOf || undefined });
    return c.id;
  };

  useEffect(() => {
    const q = params.get("q");
    if (q && !handledQ.current) {
      handledQ.current = true;
      router.replace("/assistant");
      void startNew(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === "assistant");
  const inspected = chat.pending?.route ? { route: chat.pending.route, chunks: chat.pending.retrieval?.chunks, timings: chat.pending.retrieval?.timings } : (selected ?? lastAssistant) ? { route: (selected ?? lastAssistant)!.route, chunks: (selected ?? lastAssistant)!.retrieval?.chunks, timings: (selected ?? lastAssistant)!.retrieval?.timings } : null;

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Ask Necessa" }]} />} flush>
      <div className="grid h-[calc(100dvh-56px)] min-h-0 lg:grid-cols-[260px_minmax(0,1fr)_auto]">
        <aside className="hidden min-h-0 flex-col border-r border-border lg:flex">
          <div className="grid gap-2 p-3">
            <Button variant="primary" onClick={() => startNew()} loading={create.isPending}>
              <MessageSquarePlus /> New conversation
            </Button>
            <Input leading={<Search />} placeholder="Search conversations" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8" />
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin" aria-label="Conversations">
            {convs.isPending ? <Skeleton className="mx-1 h-40" /> : null}
            {list.map((c) => (
              <div key={c.id} className={cn("group flex items-center gap-1 rounded-md pr-1 transition-colors", c.id === activeId ? "bg-surface shadow-e1" : "hover:bg-surface-2")}>
                <button
                  onClick={() => {
                    setActiveId(c.id);
                    setSelected(null);
                  }}
                  className="grid min-w-0 flex-1 px-2.5 py-2 text-left"
                >
                  <span className="flex items-center gap-1.5 truncate text-[13px] font-medium text-fg">
                    {c.pinned ? <Pin className="size-3 shrink-0 text-brand" /> : null}
                    <span className="truncate">{c.title}</span>
                  </span>
                  <span className="text-[11px] text-subtle">{fmtRelative(c.updatedAt)}</span>
                </button>
                <span className="flex opacity-0 transition-opacity group-hover:opacity-100">
                  <Tooltip content={c.pinned ? "Unpin" : "Pin"}>
                    <Button variant="ghost" size="icon-sm" aria-label="Pin conversation" onClick={() => updateConv.mutate({ id: c.id, pinned: !c.pinned })}>
                      {c.pinned ? <PinOff /> : <Pin />}
                    </Button>
                  </Tooltip>
                  <Tooltip content="Delete">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Delete conversation"
                      onClick={() =>
                        del.mutate(c.id, {
                          onSuccess: () => {
                            if (activeId === c.id) setActiveId(null);
                          },
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </Tooltip>
                </span>
              </div>
            ))}
          </nav>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{chat.conversation?.title ?? "Ask Necessa"}</p>
            <Segmented
              size="xs"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "auto", label: "Auto" },
                { value: "policy", label: "Policy" },
                { value: "analytics", label: "Analytics" },
                { value: "codes", label: "Codes" },
              ]}
            />
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <CalendarDays className="size-3.5" />
              <span className="hidden sm:inline">As of</span>
              <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs text-fg outline-none focus:border-brand" aria-label="Policy as-of date" />
            </label>
            <Tooltip content={inspectorOpen ? "Hide retrieval inspector" : "Show retrieval inspector"}>
              <Button variant="ghost" size="icon-sm" className="hidden lg:inline-flex" onClick={() => setInspectorOpen(!inspectorOpen)} aria-label="Toggle inspector">
                {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </Button>
            </Tooltip>
            <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => startNew()} aria-label="New conversation">
              <MessageSquarePlus />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
            <div className="mx-auto max-w-3xl px-4">
              {chat.loading ? (
                <div className="grid gap-4 py-8">
                  <Skeleton className="ml-auto h-9 w-2/3 rounded-2xl" />
                  <Skeleton className="h-24" />
                </div>
              ) : (
                <ChatThread
                  messages={chat.messages}
                  pending={chat.pending}
                  pendingUser={chat.pendingUser}
                  selectedId={selected?.id ?? lastAssistant?.id}
                  onSelect={(m) => {
                    setSelected(m);
                    setInspectorOpen(true);
                  }}
                  empty={<AssistantIntro />}
                />
              )}
            </div>
          </div>
          <div className="border-t border-border bg-bg/80 px-4 py-3 backdrop-blur">
            <div className="mx-auto max-w-3xl">
              <Composer
                autoFocus
                busy={busy}
                onStop={chat.stop}
                showSuggestions={!chat.messages.length && !chat.pending}
                onSend={async (t) => {
                  const id = activeId ?? (await startNew());
                  if (activeId) void chat.send(t, { mode, asOf: asOf || undefined, conversationId: id });
                  else void chat.send(t, { mode, asOf: asOf || undefined, conversationId: id });
                }}
                footer={<span className="text-[11px] text-subtle">Enter to send · Shift+Enter for a new line · cites every claim</span>}
              />
            </div>
          </div>
        </section>

        {inspectorOpen ? (
          <aside className="hidden min-h-0 w-[340px] flex-col border-l border-border bg-surface-2/30 lg:flex">
            <div className="border-b border-border px-4 py-3">
              <p className="text-[13px] font-semibold">Retrieval inspector</p>
              <p className="text-xs text-muted">How the selected answer was routed, retrieved and ranked</p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
              <RetrievalInspector route={inspected?.route} chunks={inspected?.chunks} timings={inspected?.timings} />
            </div>
          </aside>
        ) : null}
      </div>
    </AppPage>
  );
}

export default function AssistantPage() {
  return (
    <Suspense>
      <AssistantInner />
    </Suspense>
  );
}
