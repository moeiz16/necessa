"use client";

import { Bell, BellRing, CheckCheck, FileWarning, Gavel, Keyboard, LogOut, Menu, Moon, Search, Settings, ShieldAlert, Sparkles, Sun, TestTube2, Timer, UserRound, Workflow, BookOpen } from "lucide-react";
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
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger, Popover, PopoverContent, PopoverTrigger, Tooltip } from "@/components/ui/overlays";
import { useUi } from "./ui-state";

const NOTIF_ICON: Record<string, typeof Bell> = { sla: Timer, evaluation: Workflow, security: ShieldAlert, policy: BookOpen, criteria: FileWarning, denial: Gavel };

function Notifications() {
  const { data = [] } = useNotifications();
  const mark = useMarkNotifications();
  const router = useRouter();
  const unread = data.filter((n) => !n.readAt).length;
  return (
    <Popover>
      <Tooltip content="Notifications">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`} className="relative">
            {unread ? <BellRing /> : <Bell />}
            {unread ? <span className="tabular absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-notmet px-1 text-[9px] font-semibold text-white">{unread}</span> : null}
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="w-[min(380px,calc(100vw-1.5rem))] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <p className="text-[13px] font-semibold">Notifications</p>
          <Button variant="ghost" size="xs" onClick={() => mark.mutate(undefined)} disabled={!unread}>
            <CheckCheck />
            Mark all read
          </Button>
        </div>
        <div className="max-h-[420px] overflow-y-auto scrollbar-thin">
          {data.length === 0 ? (
            <EmptyState compact art="inbox" title="You're all caught up" description="SLA alerts, evaluation results and policy changes appear here." />
          ) : (
            data.map((n) => {
              const Icon = NOTIF_ICON[n.type] ?? Bell;
              return (
                <button
                  key={n.id}
                  onClick={() => {
                    if (!n.readAt) mark.mutate(n.id);
                    if (n.link) router.push(n.link);
                  }}
                  className={cn("flex w-full gap-3 border-b border-border/60 px-3 py-3 text-left transition-colors last:border-0 hover:bg-surface-2", !n.readAt && "bg-brand-soft/25")}
                >
                  <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted", n.type === "security" && "bg-notmet-soft text-notmet", n.type === "sla" && "bg-insufficient-soft text-insufficient")}>
                    <Icon className="size-3.5" />
                  </span>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-fg">{n.title}</span>
                      {!n.readAt ? <span className="size-1.5 shrink-0 rounded-full bg-brand" /> : null}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted">{n.body}</span>
                    <span className="text-[11px] text-subtle">{fmtRelative(n.createdAt)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
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
      <Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
        <Sun className="hidden dark:block" />
        <Moon className="dark:hidden" />
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
          <TestTube2 className="size-3" />
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
