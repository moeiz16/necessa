"use client";

import { ArrowRight, FilePlus2, FolderKanban, Keyboard, LogOut, Monitor, Moon, Sparkles, Sun, TestTube2, BookOpen, Hash } from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { Dialog as D } from "radix-ui";
import { useDeferredValue, useState } from "react";
import { useCases, useCodeSearch, usePolicies } from "@/lib/api/hooks";
import { useDemoMode, useSession } from "@/lib/api/session";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Kbd } from "@/components/ui/display";
import { DocTypeBadge, StatusChip } from "@/components/domain/verdict";
import { ALL_NAV } from "./nav";
import { useUi } from "./ui-state";

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, setShortcutsOpen } = useUi();
  const router = useRouter();
  const { setTheme } = useTheme();
  const { can, logout } = useSession();
  const demo = useDemoMode();
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q.trim());
  const cases = useCases(dq.length >= 2 ? { q: dq, limit: 5 } : { limit: 5, sort: "-updatedAt" });
  const policies = usePolicies(dq.length >= 2 ? { q: dq, limit: 5 } : { limit: 0 });
  const codes = useCodeSearch(dq.length >= 2 ? dq : "", undefined);

  const go = (href: string) => {
    setPaletteOpen(false);
    setQ("");
    router.push(href);
  };

  return (
    <D.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-[rgb(10_11_13/0.38)] backdrop-blur-[2px] data-[state=open]:animate-[fade-in_140ms]" />
        <D.Content
          className="fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-2rem)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-e3 outline-none data-[state=open]:animate-[rise_180ms_var(--ease-out-quart)]"
          aria-describedby={undefined}
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <Command shouldFilter={dq.length < 2} loop>
            <CommandInput placeholder="Search cases, policies, codes — or ask Necessa anything…" value={q} onValueChange={setQ} autoFocus />
            <CommandList>
              <CommandEmpty>No matches. Press Enter to ask Necessa.</CommandEmpty>
              {q.trim().length > 2 ? (
                <CommandGroup heading="Ask Necessa">
                  <CommandItem value={`ask ${q}`} onSelect={() => go(`/assistant?q=${encodeURIComponent(q.trim())}`)}>
                    <Sparkles className="!text-ai-2" />
                    <span className="min-w-0 flex-1 truncate">
                      Ask: <span className="text-fg">“{q.trim()}”</span>
                    </span>
                    <span className="text-[11px] text-subtle">hybrid RAG · cited</span>
                  </CommandItem>
                </CommandGroup>
              ) : null}

              {cases.data?.items.length ? (
                <CommandGroup heading={dq.length >= 2 ? "Cases" : "Recent cases"}>
                  {cases.data.items.slice(0, 5).map((c) => (
                    <CommandItem key={c.id} value={`case ${c.number} ${c.title} ${c.patient.displayName}`} onSelect={() => go(`/cases/${c.id}`)}>
                      <FolderKanban />
                      <span className="font-mono text-xs text-muted">{c.number}</span>
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      <StatusChip status={c.status} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {dq.length >= 2 && policies.data?.items.length ? (
                <CommandGroup heading="Policies">
                  {policies.data.items.slice(0, 5).map((p) => (
                    <CommandItem key={p.id} value={`policy ${p.sourceKey} ${p.title}`} onSelect={() => go(`/policies/${p.id}`)}>
                      <BookOpen />
                      <span className="font-mono text-xs text-muted">{p.sourceKey}</span>
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      <DocTypeBadge docType={p.docType} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {dq.length >= 2 && codes.data?.length ? (
                <CommandGroup heading="Codes">
                  {codes.data.slice(0, 4).map((c) => (
                    <CommandItem key={c.code} value={`code ${c.code} ${c.shortDesc}`} onSelect={() => go(`/codes?code=${c.code}&system=${c.system}`)}>
                      <Hash />
                      <span className="font-mono text-xs text-fg">{c.code}</span>
                      <span className="min-w-0 flex-1 truncate text-muted">{c.shortDesc}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              <CommandGroup heading="Actions">
                {can("cases:write") ? (
                  <CommandItem value="new case create prior authorization" onSelect={() => go("/cases/new")}>
                    <FilePlus2 />
                    New case
                    <Kbd className="ml-auto">C</Kbd>
                  </CommandItem>
                ) : null}
                <CommandItem value="ask necessa assistant chat" onSelect={() => go("/assistant")}>
                  <Sparkles />
                  Open Ask Necessa
                </CommandItem>
                <CommandItem value="keyboard shortcuts help" onSelect={() => { setPaletteOpen(false); setShortcutsOpen(true); }}>
                  <Keyboard />
                  Keyboard shortcuts
                  <Kbd className="ml-auto">?</Kbd>
                </CommandItem>
              </CommandGroup>

              <CommandGroup heading="Navigate">
                {ALL_NAV.filter((n) => !n.perm || can(n.perm)).map((n) => (
                  <CommandItem key={n.href} value={`go ${n.label}`} onSelect={() => go(n.href)}>
                    <n.icon />
                    {n.label}
                    {n.shortcut ? <span className="ml-auto flex gap-1">{n.shortcut.split(" ").map((k) => <Kbd key={k}>{k}</Kbd>)}</span> : <ArrowRight className="ml-auto" />}
                  </CommandItem>
                ))}
              </CommandGroup>

              <CommandSeparator />
              <CommandGroup heading="Preferences">
                <CommandItem value="theme light" onSelect={() => { setTheme("light"); setPaletteOpen(false); }}>
                  <Sun /> Light theme
                </CommandItem>
                <CommandItem value="theme dark" onSelect={() => { setTheme("dark"); setPaletteOpen(false); }}>
                  <Moon /> Dark theme
                </CommandItem>
                <CommandItem value="theme system" onSelect={() => { setTheme("system"); setPaletteOpen(false); }}>
                  <Monitor /> System theme
                </CommandItem>
                {!process.env.NEXT_PUBLIC_DEMO_MODE ? (
                  <CommandItem value="toggle demo data mode" onSelect={() => { demo.toggle(!demo.on); setPaletteOpen(false); router.refresh(); }}>
                    <TestTube2 /> {demo.on ? "Use live API" : "Use demo data"}
                  </CommandItem>
                ) : null}
                <CommandItem value="sign out logout" onSelect={async () => { setPaletteOpen(false); await logout(); router.push("/login"); }}>
                  <LogOut /> Sign out
                </CommandItem>
              </CommandGroup>
            </CommandList>
            <div className="flex items-center justify-between border-t border-border bg-surface-2/50 px-3 py-2 text-[11px] text-subtle">
              <span className="flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate <Kbd>↵</Kbd> open
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>esc</Kbd> close
              </span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
