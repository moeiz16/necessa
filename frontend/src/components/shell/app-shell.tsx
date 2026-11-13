"use client";

import { WifiOff, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { Dialog as D } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { onBackendUnreachable } from "@/lib/api/client";
import { useDemoMode, useSession } from "@/lib/api/session";
import { lsGet, lsSet } from "@/lib/utils";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/display";
import { DialogContent, Dialog } from "@/components/ui/overlays";
import { CommandPalette } from "./command-palette";
import { OrgSwitcher, Sidebar, SidebarNav, TrustCard } from "./sidebar";
import { Topbar } from "./topbar";
import { UiStateProvider, useUi } from "./ui-state";

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["⌘", "K"], label: "Search" },
  { keys: ["/"], label: "Search" },
  { keys: ["C"], label: "New case" },
  { keys: ["G", "D"], label: "Go to home" },
  { keys: ["G", "C"], label: "Go to cases" },
  { keys: ["G", "E"], label: "Go to denials & appeals" },
  { keys: ["G", "A"], label: "Go to Ask Necessa" },
  { keys: ["G", "P"], label: "Go to policy library" },
  { keys: ["G", "R"], label: "Go to insights" },
  { keys: ["["], label: "Toggle sidebar" },
  { keys: ["?"], label: "Show this dialog" },
];

function ShortcutsDialog() {
  const { shortcutsOpen, setShortcutsOpen } = useUi();
  return (
    <Dialog open={shortcutsOpen} onOpenChange={setShortcutsOpen}>
      <DialogContent title="Keyboard shortcuts" description="Move around Necessa without the mouse." size="sm">
        <ul className="grid gap-2">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between text-[13px]">
              <span className="text-muted">{s.label}</span>
              <span className="flex gap-1">
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function useGlobalShortcuts(toggleSidebar: () => void) {
  const router = useRouter();
  const { setPaletteOpen, setShortcutsOpen } = useUi();
  const leader = useRef<number | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (leader.current && Date.now() - leader.current < 1200) {
        leader.current = null;
        const map: Record<string, string> = { d: "/dashboard", c: "/cases", e: "/denials", a: "/assistant", p: "/policies", r: "/analytics" };
        if (map[k]) {
          e.preventDefault();
          router.push(map[k]!);
        }
        return;
      }
      if (k === "g") leader.current = Date.now();
      else if (k === "/") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (k === "c") router.push("/cases/new");
      else if (e.key === "?") setShortcutsOpen(true);
      else if (k === "[") toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, setPaletteOpen, setShortcutsOpen, toggleSidebar]);
}

function MobileNav() {
  const { mobileNavOpen, setMobileNavOpen } = useUi();
  return (
    <D.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-[rgb(10_10_10/0.36)] data-[state=open]:animate-[fade-in_150ms] data-[state=closed]:animate-[fade-out_150ms] md:hidden" />
        <D.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(86vw,300px)] flex-col border-r border-border bg-bg shadow-e3 outline-none data-[state=open]:animate-[sheet-in-left_200ms_var(--ease-out)] data-[state=closed]:animate-[sheet-out-left_160ms_var(--ease-in-out)] md:hidden" aria-describedby={undefined}>
          <D.Title className="sr-only">Navigation</D.Title>
          <div className="flex h-14 items-center justify-between px-4">
            <Logo />
            <D.Close className="rounded-md p-1.5 text-subtle hover:bg-surface-2 hover:text-fg" aria-label="Close navigation">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="px-2 pb-3">
            <OrgSwitcher />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
            <SidebarNav layoutGroup="mobile" onNavigate={() => setMobileNavOpen(false)} />
          </div>
          <div className="border-t border-border p-3">
            <TrustCard />
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function BackendWatch() {
  const demo = useDemoMode();
  useEffect(() => {
    let shown = false;
    return onBackendUnreachable(() => {
      if (shown || demo.on) return;
      shown = true;
      toast.error("We can’t reach Necessa right now", {
        description: "Check your connection, or explore with sample data in the meantime.",
        icon: <WifiOff className="size-4" />,
        duration: 12_000,
        action: {
          label: "Use sample data",
          onClick: () => {
            demo.toggle(true);
            location.href = "/login?demo=1";
          },
        },
      });
    });
  }, [demo]);
  return null;
}

function Splash() {
  const reduce = useReducedMotion();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg" aria-busy="true" aria-label="Loading Necessa">
      <svg width="44" height="44" viewBox="0 0 32 32" fill="none" aria-hidden>
        <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="var(--brand)" />
        <motion.path
          d="M9 23V9.5l7.6 9.8L24 8.5"
          stroke="var(--brand-contrast)"
          strokeWidth="3.1"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <span className="text-xs text-subtle">Loading your workspace</span>
    </div>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const { status, me } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => setCollapsed(lsGet("necessa.sidebar.collapsed", false)), []);
  const toggle = () =>
    setCollapsed((c) => {
      lsSet("necessa.sidebar.collapsed", !c);
      return !c;
    });
  useGlobalShortcuts(toggle);

  useEffect(() => {
    if (status === "unauthenticated") router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (status === "authenticated" && (!me?.activeOrg || !me.activeOrg.onboardingCompletedAt)) router.replace("/onboarding");
  }, [status, me, router, pathname]);

  if (status === "error") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
        <WifiOff className="size-6 text-subtle" />
        <div>
          <p className="text-sm font-medium">We can’t reach Necessa right now</p>
          <p className="mt-1 text-[13px] text-muted">Please check your connection and try again.</p>
        </div>
        <Button variant="primary" onClick={() => (location.href = "/login?demo=1")}>
          Explore with sample data
        </Button>
      </div>
    );
  }
  if (status !== "authenticated" || !me?.activeOrg?.onboardingCompletedAt) return <Splash />;

  return (
    <div className="flex min-h-dvh bg-bg">
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <MobileNav />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <CommandPalette />
      <ShortcutsDialog />
      <BackendWatch />
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <UiStateProvider>
      <ShellInner>{children}</ShellInner>
    </UiStateProvider>
  );
}

/** Standard page frame: topbar (with optional breadcrumb) + padded main. */
export function AppPage({ children, crumbs, wide, flush, className }: { children: ReactNode; crumbs?: ReactNode; wide?: boolean; flush?: boolean; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <>
      <Topbar>{crumbs}</Topbar>
      <motion.main
        id="main"
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className={flush ? `min-h-0 flex-1 ${className ?? ""}` : `mx-auto w-full flex-1 px-4 py-6 sm:px-6 lg:px-8 ${wide ? "max-w-[1600px]" : "max-w-[1320px]"} ${className ?? ""}`}
      >
        {children}
      </motion.main>
    </>
  );
}
