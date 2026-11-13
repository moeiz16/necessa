"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, stream } from "@/lib/api/client";
import { qk, useConversation } from "@/lib/api/hooks";
import type { Citation, Message, RetrievalChunk, RouteTrace, SqlResult } from "@/lib/api/types";

export interface PendingMessage {
  id: string;
  content: string;
  route?: RouteTrace;
  retrieval?: { chunks: RetrievalChunk[]; timings: Record<string, number> };
  citations: Citation[];
  sql?: SqlResult;
  tools: { name: string; args: Record<string, unknown>; result?: Record<string, unknown> }[];
  guardrails: { kind: string; message: string }[];
  stage: "routing" | "retrieving" | "generating" | "done" | "error";
  error?: string;
}

export function useChat(conversationId: string | null) {
  const qc = useQueryClient();
  const conv = useConversation(conversationId);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const pendingConv = useRef<string | null>(null);

  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => {
    // Only drop in-flight state when the user navigates to a *different* conversation.
    if (pendingConv.current && pendingConv.current !== conversationId) {
      ctrl.current?.abort();
      pendingConv.current = null;
      setPending(null);
      setPendingUser(null);
    }
  }, [conversationId]);

  const send = useCallback(
    async (content: string, opts: { asOf?: string; mode?: string; caseId?: string; conversationId?: string } = {}) => {
      const id = opts.conversationId ?? conversationId;
      if (!id || !content.trim()) return;
      ctrl.current?.abort();
      const ac = new AbortController();
      ctrl.current = ac;
      pendingConv.current = id;
      setPendingUser(content);
      setPending({ id: `pending-${Date.now()}`, content: "", citations: [], tools: [], guardrails: [], stage: "routing" });
      try {
        await stream(`/assistant/conversations/${id}/messages`, {
          method: "POST",
          body: { content, asOf: opts.asOf, mode: opts.mode ?? "auto", caseId: opts.caseId },
          signal: ac.signal,
          onEvent: ({ event, data }) => {
            setPending((p) => {
              if (!p) return p;
              switch (event) {
                case "route":
                  return { ...p, route: data as unknown as RouteTrace, stage: "retrieving" };
                case "retrieval":
                  return { ...p, retrieval: data as unknown as PendingMessage["retrieval"], stage: "generating" };
                case "tool":
                  return { ...p, tools: [...p.tools, data as unknown as PendingMessage["tools"][number]] };
                case "sql":
                  return { ...p, sql: data as unknown as SqlResult, stage: "generating" };
                case "token":
                  return { ...p, content: p.content + String(data.text ?? ""), stage: "generating" };
                case "citations":
                  return { ...p, citations: (data.items as Citation[]) ?? [] };
                case "guardrail":
                  return { ...p, guardrails: [...p.guardrails, data as unknown as { kind: string; message: string }] };
                case "error":
                  return { ...p, stage: "error", error: String(data.message) };
                case "done":
                  return { ...p, stage: "done" };
                default:
                  return p;
              }
            });
          },
        });
        await qc.invalidateQueries({ queryKey: qk.conversation(id) });
        await qc.invalidateQueries({ queryKey: qk.conversations });
        pendingConv.current = null;
        setPending(null);
        setPendingUser(null);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setPending((p) => (p ? { ...p, stage: "error", error: errorMessage(e) } : p));
      }
    },
    [conversationId, qc],
  );

  const stop = useCallback(() => {
    ctrl.current?.abort();
    setPending((p) => (p ? { ...p, stage: "done" } : p));
  }, []);

  const messages: Message[] = conv.data?.messages ?? [];
  return { conversation: conv.data, loading: conv.isPending && !!conversationId, messages, pending, pendingUser, send, stop };
}
