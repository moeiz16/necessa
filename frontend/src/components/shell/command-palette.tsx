"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Clock3, FilePlus2, FolderKanban, Hash, Keyboard, LogOut, Monitor, Moon, Sparkles, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { Dialog as D } from "radix-ui";
import { useDeferredValue, useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { useCases } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import type { CodeResult, Page, PolicySummary } from "@/lib/api/types";
import { lsGet, lsSet } from "@/lib/utils";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Kbd } from "@/components/ui/display";
import { DocTypeBadge, StatusChip } from "@/components/domain/verdict";
import { ALL_NAV } from "./nav";
import { useUi } from "./ui-state";

type Recent = { href: string; label: string; kind: "case" | "policy" | "code" | "page" };
const RECENT_KEY = "necessa.palette.recent";

function rememberRecent(r: Recent) {
  const prev = lsGet<Recent[]>(RECENT_KEY, []).filter((x) => x.href !== r.href);
  lsSet(RECENT_KEY, [r, ...prev].slice(0, 6));
}

const RECENT_ICON = { case: FolderKanban, policy: BookOpen, code: Hash, page: ArrowRight } as const;

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen, setShortcutsOpen } = useUi();
  const router = useRouter();
  const { setTheme } = useTheme();
  const { can, logout } = useSession();
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q.trim());
  const cases = useCases(dq.length >= 2 ? { q: dq, limit: 5 } : { limit: 5, sort: "-updatedAt" });
  // Only searched once there is something to search for (an empty query is rejected by the API).
  const searching = dq.length >= 2;
  const policies = useQuery({
    queryKey: ["palette", "policies", dq],
    queryFn: () => api.get<Page<PolicySummary>>("/policies", { q: dq, limit: 5 }),
    enabled: searching,
    placeholderData: keepPreviousData,
  });
  const codes = useQuery({
    queryKey: ["palette", "codes", dq],
    queryFn: () => api.get<CodeResult[]>("/codes/search", { q: dq }),
    enabled: searching,
    placeholderData: keepPreviousData,
  });

  const [recent, setRecent] = useState<Recent[]>([]);
  useEffect(() => {
    if (paletteOpen) setRecent(lsGet<Recent[]>(RECENT_KEY, []));
  }, [paletteOpen]);

  const go = (href: string, remember?: Omit<Recent, "href">) => {
    if (remember) rememberRecent({ href, ...remember });
    setPaletteOpen(false);
    setQ("");
    router.push(href);
  };

  return (
    <D.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-[rgb(10_10_10/0.32)] data-[state=open]:animate-[fade-in_150ms] data-[state=closed]:animate-[fade-out_120ms]" />
        <D.Content
          className="fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-2rem)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface shadow-e3 outline-none data-[state=open]:animate-[scale-in_160ms_var(--ease-out)] data-[state=closed]:animate-[scale-out_120ms_var(--ease-out)]"
          aria-describedby={undefined}
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <Command shouldFilter={dq.length < 2} loop>
            <CommandInput placeholder="Search cases, policies and codes, or ask a question…" value={q} onValueChange={setQ} autoFocus />
            <CommandList>
              <CommandEmpty>No matches. Try a different search.</CommandEmpty>
              {q.trim().length > 2 ? (
                <CommandGroup heading="Ask Necessa">
                  <CommandItem value={`ask ${q}`} onSelect={() => go(`/assistant?q=${encodeURIComponent(q.trim())}`)}>
                    <Sparkles />
                    <span className="min-w-0 flex-1 truncate">
                      Ask: <span className="text-fg">“{q.trim()}”</span>
                    </span>
                    <span className="text-[11px] text-subtle">answer with sources</span>
                  </CommandItem>
                </CommandGroup>
              ) : null}

              {!dq && recent.length ? (
                <CommandGroup heading="Recently opened">
                  {recent.map((r) => {
                    const Icon = RECENT_ICON[r.kind] ?? Clock3;
                    return (
                      <CommandItem key={r.href} value={`recent ${r.label}`} onSelect={() => go(r.href, { label: r.label, kind: r.kind })}>
                        <Icon />
                        <span className="min-w-0 flex-1 truncate">{r.label}</span>
                        <Clock3 className="ml-auto !size-3.5 !text-subtle" />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null}

              {cases.data?.items.length ? (
                <CommandGroup heading={dq.length >= 2 ? "Cases" : "Recent cases"}>
                  {cases.data.items.slice(0, 5).map((c) => (
                    <CommandItem key={c.id} value={`case ${c.number} ${c.title} ${c.patient.displayName}`} onSelect={() => go(`/cases/${c.id}`, { label: `${c.number} · ${c.title}`, kind: "case" })}>
                      <FolderKanban />
                      <span className="font-mono text-xs text-muted">{c.number}</span>
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      <StatusChip status={c.status} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {searching && policies.data?.items.length ? (
                <CommandGroup heading="Policies">
                  {policies.data.items.slice(0, 5).map((p) => (
                    <CommandItem key={p.id} value={`policy ${p.sourceKey} ${p.title}`} onSelect={() => go(`/policies/${p.id}`, { label: `${p.sourceKey} · ${p.title}`, kind: "policy" })}>
                      <BookOpen />
                      <span className="font-mono text-xs text-muted">{p.sourceKey}</span>
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      <DocTypeBadge docType={p.docType} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {searching && codes.data?.length ? (
                <CommandGroup heading="Codes">
                  {codes.data.slice(0, 4).map((c) => (
                    <CommandItem key={c.code} value={`code ${c.code} ${c.shortDesc}`} onSelect={() => go(`/codes?code=${c.code}&system=${c.system}`, { label: `${c.code} · ${c.shortDesc}`, kind: "code" })}>
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
                <CommandItem value="sign out logout" onSelect={async () => { setPaletteOpen(false); await logout(); router.push("/login"); }}>
                  <LogOut /> Sign out
                </CommandItem>
              </CommandGroup>
            </CommandList>
            <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[11px] text-subtle">
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
