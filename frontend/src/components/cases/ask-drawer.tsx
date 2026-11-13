"use client";

import { useState } from "react";
import { useCreateConversation } from "@/lib/api/hooks";
import { AssistantIntro, ChatThread, Composer } from "@/components/assistant/chat";
import { useChat } from "@/components/assistant/use-chat";
import { Sheet, SheetContent } from "@/components/ui/overlays";

export function AskDrawer({ caseId, caseNumber, open, onOpenChange }: { caseId: string; caseNumber: string; open: boolean; onOpenChange: (v: boolean) => void }) {
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
