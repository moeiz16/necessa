import {
  Activity,
  BookOpen,
  ChartColumn,
  FolderKanban,
  Gavel,
  Home,
  Search,
  ShieldCheck,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/api/types";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  perm?: Permission;
  shortcut?: string;
  badge?: "cases" | "review";
}

/**
 * Customer-facing navigation. The operator consoles (/knowledge, /admin/models, /admin/evals) are
 * deliberately not linked from the product UI; they stay reachable by URL for operators.
 */
export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Workspace",
    items: [
      { href: "/dashboard", label: "Home", icon: Home, shortcut: "G D" },
      { href: "/cases", label: "Cases", icon: FolderKanban, shortcut: "G C", badge: "cases" },
      { href: "/denials", label: "Denials & appeals", icon: Gavel, shortcut: "G E" },
      { href: "/assistant", label: "Ask Necessa", icon: Sparkles, shortcut: "G A" },
    ],
  },
  {
    section: "Reference",
    items: [
      { href: "/policies", label: "Policy library", icon: BookOpen, shortcut: "G P" },
      { href: "/codes", label: "Coverage lookup", icon: Search },
    ],
  },
  {
    section: "Reporting",
    items: [
      { href: "/analytics", label: "Insights", icon: ChartColumn, perm: "analytics:read", shortcut: "G R" },
      { href: "/admin/audit", label: "Compliance", icon: ShieldCheck, perm: "audit:read" },
    ],
  },
  {
    section: "Account",
    items: [{ href: "/settings", label: "Team & settings", icon: Settings }],
  },
];

export const ALL_NAV = NAV.flatMap((s) => s.items);
export { Activity };
