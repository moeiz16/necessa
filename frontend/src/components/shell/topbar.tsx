"use client";

import { Bell, BellRing, CheckCheck, FileWarning, FlaskConical, Gavel, Keyboard, LogOut, Menu, Moon, Search, Settings, ShieldAlert, Sparkles, Sun, TestTube2, Timer, UserRound, Workflow, BookOpen } from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMarkNotifications, useNotifications } from "@/lib/api/hooks";
import { useDemoMode, useSession } from "@/lib/api/session";
import { fmtRelative, ROLE_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, Badge, Kbd } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger, Sheet, SheetContent, SheetTrigger, Tooltip } from "@/components/ui/overlays";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useUi } from "./ui-state";

const NOTIF_ICON: Record<string, typeof Bell> = { sla: Timer, evaluation: Workflow, security: ShieldAlert, policy: BookOpen, criteria: FileWarning, denial: Gavel };

function dayBucket(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (d.getTime() >= start) return "Today";
  if (d.getTime() >= start - 86_400_000) return "Yesterday";
  return "Earlier";
}

function Notifications() {
  const { data = [] } = useNotifications();
  const mark = useMarkNotifications();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const unread = data.filter((n) => !n.readAt).length;
  const list = filter === "unread" ? data.filter((n) => !n.readAt) : data;
  const groups = ["Today", "Yesterday", "Earlier"].map((g) => ({ g, items: list.filter((n) => dayBucket(n.createdAt) === g) })).filter((x) => x.items.length);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip content="Notifications">
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className="relative">
            {unread ? <BellRing /> : <Bell />}
            <AnimatePresence>
              {unread ? (
                <motion.span
                  key={unread}
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.4, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 520, damping: 26 }}
                  className="tabular absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-notmet px-1 text-[9px] font-semibold text-white ring-2 ring-bg"
                >
                  {unread > 9 ? "9+" : unread}
                </motion.span>
              ) : null}
            </AnimatePresence>
          </Button>
        </SheetTrigger>
      </Tooltip>
      <SheetContent title="Notifications" description="SLA alerts, evaluation results, policy changes and security events." className="max-w-[min(100vw,26rem)]">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-surface/95 px-4 py-2.5 backdrop-blur">
          <div className="flex rounded-md bg-surface-2 p-0.5 text-xs font-medium" role="tablist" aria-label="Filter notifications">
            {(["all", "unread"] as const).map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cn("rounded-[5px] px-2.5 py-1 capitalize transition-colors", filter === f ? "bg-surface text-fg shadow-e1" : "text-muted hover:text-fg")}
              >
                {f}
                {f === "unread" && unread ? <span className="tabular ml-1 text-brand-fg">{unread}</span> : null}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="xs" onClick={() => mark.mutate(undefined)} disabled={!unread}>
            <CheckCheck />
            Mark all read
          </Button>
        </div>
        {list.length === 0 ? (
          <EmptyState art="inbox" title={filter === "unread" ? "No unread notifications" : "You're all caught up"} description="SLA alerts, evaluation results and policy changes appear here." />
        ) : (
          <div className="pb-4">
            {groups.map(({ g, items }) => (
              <section key={g} aria-label={g}>
                <p className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-subtle">{g}</p>
                <ul>
                  {items.map((n) => {
                    const Icon = NOTIF_ICON[n.type] ?? Bell;
                    return (
                      <li key={n.id}>
                        <button
                          onClick={() => {
                            if (!n.readAt) mark.mutate(n.id);
                            if (n.link) {
                              setOpen(false);
                              router.push(n.link);
                            }
                          }}
                          className={cn("relative flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2", !n.readAt && "bg-brand-soft/20")}
                        >
                          {!n.readAt ? <span className="absolute left-1.5 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-brand" aria-label="Unread" /> : null}
                          <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted", n.type === "security" && "bg-notmet-soft text-notmet", n.type === "sla" && "bg-insufficient-soft text-insufficient", n.type === "evaluation" && "bg-brand-soft text-brand")}>
                            <Icon className="size-4" />
                          </span>
                          <span className="grid min-w-0 gap-0.5">
                            <span className={cn("truncate text-[13px] text-fg", !n.readAt && "font-medium")}>{n.title}</span>
                            <span className="line-clamp-2 text-xs leading-relaxed text-muted">{n.body}</span>
                            <span className="text-[11px] text-subtle">{fmtRelative(n.createdAt)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function UserMenu() {
  const { me, logout } = useSession();
  const router = useRouter();
  const { setShortcutsOpen } = useUi();
  if (!me) return null;
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand/40" aria-label="Account menu">
          <Avatar name={me.user.fullName} color={me.user.avatarColor} size={28} />
        </button>
      </DropdownTrigger>
      <DropdownContent className="w-64">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <Avatar name={me.user.fullName} color={me.user.avatarColor} size={32} />
          <div className="grid min-w-0 leading-tight">
            <span className="truncate text-[13px] font-medium">{me.user.fullName}</span>
            <span className="truncate text-xs text-muted">{me.user.email}</span>
          </div>
        </div>
        {me.membership ? (
          <div className="px-2 pb-2">
            <Badge tone="brand" size="xs">
              {ROLE_LABEL[me.membership.role]}
            </Badge>
          </div>
        ) : null}
        <DropdownSeparator />
        <DropdownItem onSelect={() => router.push("/settings")}>
          <UserRound /> Profile & security
        </DropdownItem>
        <DropdownItem onSelect={() => router.push("/settings/organization")}>
          <Settings /> Organization settings
        </DropdownItem>
        <DropdownItem onSelect={() => setShortcutsOpen(true)}>
          <Keyboard /> Keyboard shortcuts
          <Kbd className="ml-auto">?</Kbd>
        </DropdownItem>
        <DropdownSeparator />
        <DropdownItem
          onSelect={async () => {
            await logout();
            router.push("/login");
          }}
        >
          <LogOut /> Sign out
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Tooltip content="Toggle theme">
      <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} className="overflow-hidden">
        <Sun className="hidden transition-transform duration-300 ease-out hover:rotate-45 dark:block" />
        <Moon className="transition-transform duration-300 ease-out hover:-rotate-12 dark:hidden" />
      </Button>
    </Tooltip>
  );
}

export function DemoPill() {
  const demo = useDemoMode();
  if (!demo.on) return null;
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button className="inline-flex h-6 items-center gap-1.5 rounded-full border border-dashed border-insufficient/50 bg-insufficient-soft/60 px-2 text-[11px] font-medium text-insufficient-fg outline-none">
          <FlaskConical className="size-3" />
          Demo data
        </button>
      </DropdownTrigger>
      <DropdownContent className="w-72">
        <DropdownLabel>Demo mode</DropdownLabel>
        <p className="px-2 pb-2 text-xs text-muted">
          You&apos;re exploring an in-browser simulation with synthetic patients and real CMS policy identifiers. Nothing leaves this browser.
        </p>
        <DropdownSeparator />
        <DropdownItem
          onSelect={async () => {
            const { resetDB } = await import("@/lib/demo/store");
            const fresh = resetDB();
            fresh.session = { userId: "u-maya", orgId: "org-riverbend" };
            location.reload();
          }}
        >
          <Workflow /> Reset demo data
        </DropdownItem>
        {!process.env.NEXT_PUBLIC_DEMO_MODE ? (
          <DropdownItem
            onSelect={() => {
              demo.toggle(false);
              location.href = "/login";
            }}
          >
            <TestTube2 /> Switch to live API
          </DropdownItem>
        ) : null}
      </DropdownContent>
    </Dropdown>
  );
}

export function Topbar({ children }: { children?: React.ReactNode }) {
  const { setPaletteOpen, setMobileNavOpen } = useUi();
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-bg/85 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-bg/70 sm:px-5">
      <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}>
        <Menu />
      </Button>
      <div className="min-w-0 flex-1">{children}</div>
      <button
        onClick={() => setPaletteOpen(true)}
        className="hidden h-8 w-[min(34vw,320px)] items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[13px] text-subtle shadow-e1 outline-none transition-colors hover:border-border-strong hover:text-muted focus-visible:ring-2 focus-visible:ring-brand/30 sm:flex"
      >
        <Search className="size-4" />
        <span className="flex-1 truncate text-left">Search or ask anything…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <Button variant="ghost" size="icon" className="sm:hidden" aria-label="Search" onClick={() => setPaletteOpen(true)}>
        <Search />
      </Button>
      <DemoPill />
      <Tooltip content="Ask Necessa">
        <Button asChild variant="ghost" size="icon" aria-label="Ask Necessa">
          <Link href="/assistant">
            <Sparkles className="text-ai-2" />
          </Link>
        </Button>
      </Tooltip>
      <Notifications />
      <ThemeToggle />
      <UserMenu />
    </header>
  );
}
