"use client";

import { Check, ChevronsUpDown, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api/client";
import { qk, useCaseStats, useCriteriaSets } from "@/lib/api/hooks";
import { useSession } from "@/lib/api/session";
import { ROLE_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Logo, LogoMark } from "@/components/brand/logo";
import { Avatar } from "@/components/ui/display";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator, DropdownTrigger, Tooltip } from "@/components/ui/overlays";
import { NAV, type NavItem } from "./nav";

export function OrgSwitcher({ collapsed }: { collapsed?: boolean }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  const org = me?.activeOrg;
  if (!org) return null;
  const switchTo = async (orgId: string) => {
    try {
      await api.post("/auth/switch-org", { orgId });
      qc.clear();
      router.push("/dashboard");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Dropdown>
      <DropdownTrigger asChild>
        <button
          className={cn(
            "flex w-full items-center gap-2 rounded-md text-left outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/30",
            collapsed ? "justify-center p-1" : "px-2 py-1.5",
          )}
          aria-label="Switch organization"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-fg text-[11px] font-semibold text-bg">{org.name.slice(0, 1)}</span>
          {!collapsed ? (
            <>
              <span className="grid min-w-0 flex-1 leading-tight">
                <span className="truncate text-[13px] font-medium text-fg">{org.name}</span>
                <span className="truncate text-[11px] text-subtle">{ROLE_LABEL[me.membership?.role ?? "coordinator"]}</span>
              </span>
              <ChevronsUpDown className="size-3.5 text-subtle" />
            </>
          ) : null}
        </button>
      </DropdownTrigger>
      <DropdownContent align="start" className="w-64">
        <DropdownLabel>Organizations</DropdownLabel>
        {me.orgs.map((o) => (
          <DropdownItem key={o.id} onSelect={() => o.id !== org.id && switchTo(o.id)}>
            <span className="flex size-5 items-center justify-center rounded bg-surface-3 text-[10px] font-semibold">{o.name.slice(0, 1)}</span>
            <span className="min-w-0 flex-1 truncate">{o.name}</span>
            {o.id === org.id ? <Check className="!text-brand" /> : null}
          </DropdownItem>
        ))}
        <DropdownSeparator />
        <DropdownItem onSelect={() => router.push("/onboarding?new=1")}>
          <Plus />
          New organization
        </DropdownItem>
      </DropdownContent>
    </Dropdown>
  );
}

function NavLink({ item, collapsed, count }: { item: NavItem; collapsed: boolean; count?: number }) {
  const pathname = usePathname();
  const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`)) || pathname === item.href;
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-8 items-center gap-2.5 rounded-md text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/30",
        collapsed ? "w-8 justify-center" : "px-2",
        active ? "bg-surface text-fg shadow-e1" : "text-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      <Icon className={cn("size-4 shrink-0", active ? "text-brand" : "text-subtle group-hover:text-muted")} />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
      {!collapsed && count ? <span className="tabular ml-auto rounded-full bg-surface-3 px-1.5 text-[11px] leading-[18px] text-muted">{count}</span> : null}
      {collapsed && count ? <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-brand" /> : null}
    </Link>
  );
  return collapsed ? (
    <Tooltip content={item.label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

export function SidebarNav({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { can } = useSession();
  const stats = useCaseStats();
  const review = useCriteriaSets("needs_review");
  const open = stats.data ? Object.entries(stats.data.byStatus).filter(([k]) => !["approved", "closed"].includes(k)).reduce((a, [, v]) => a + v, 0) : undefined;
  const counts: Record<string, number | undefined> = { cases: open, review: can("knowledge:admin") ? review.data?.total ?? undefined : undefined };
  return (
    <nav className="grid gap-5" aria-label="Main" onClick={onNavigate}>
      {NAV.map((section) => {
        const items = section.items.filter((i) => !i.perm || can(i.perm));
        if (!items.length) return null;
        return (
          <div key={section.section} className="grid gap-0.5">
            {!collapsed ? <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-subtle">{section.section}</p> : <span className="mx-auto mb-1 h-px w-5 bg-border" />}
            {items.map((item) => (
              <NavLink key={item.href} item={item} collapsed={collapsed} count={item.badge ? counts[item.badge] : undefined} />
            ))}
          </div>
        );
      })}
    </nav>
  );
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { me } = useSession();
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-bg transition-[width] duration-200 ease-out md:flex",
        collapsed ? "w-[60px] items-center" : "w-[244px]",
      )}
    >
      <div className={cn("flex h-14 items-center", collapsed ? "justify-center" : "justify-between px-3")}>
        <Link href="/dashboard" aria-label="Necessa home" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
          {collapsed ? <LogoMark size={26} className="text-brand" /> : <Logo />}
        </Link>
        {!collapsed ? (
          <Tooltip content="Collapse sidebar  [" side="right">
            <button onClick={onToggle} className="rounded-md p-1 text-subtle hover:bg-surface-2 hover:text-fg" aria-label="Collapse sidebar">
              <PanelLeftClose className="size-4" />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <div className={cn("pb-3", collapsed ? "px-0" : "px-2")}>
        <OrgSwitcher collapsed={collapsed} />
      </div>
      <div className={cn("min-h-0 flex-1 overflow-y-auto pb-4 scrollbar-thin", collapsed ? "px-0" : "px-2")}>
        <SidebarNav collapsed={collapsed} />
      </div>
      <div className={cn("border-t border-border py-3", collapsed ? "grid justify-items-center gap-2" : "px-3")}>
        {collapsed ? (
          <>
            <button onClick={onToggle} className="rounded-md p-1.5 text-subtle hover:bg-surface-2 hover:text-fg" aria-label="Expand sidebar">
              <PanelLeftOpen className="size-4" />
            </button>
            <Avatar name={me?.user.fullName} color={me?.user.avatarColor} size={26} />
          </>
        ) : (
          <div className="flex items-center gap-2.5 rounded-lg bg-surface p-2.5 shadow-e1">
            <span className="flex size-7 items-center justify-center rounded-md bg-met-soft text-met">
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden>
                <path d="M8 1.5l5 2v4c0 3.3-2.2 5.7-5 7-2.8-1.3-5-3.7-5-7v-4z" stroke="currentColor" strokeWidth="1.4" />
                <path d="M5.6 8l1.7 1.7L10.6 6.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="grid min-w-0 leading-tight">
              <span className="text-xs font-medium text-fg">PHI zone isolated</span>
              <span className="truncate text-[11px] text-subtle">De-identified before every model call</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

export { qk };
