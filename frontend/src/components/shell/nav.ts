import {
  Activity,
  BookOpen,
  ChartColumn,
  Cpu,
  FlaskConical,
  FolderKanban,
  Gavel,
  LayoutDashboard,
  Network,
  ScrollText,
  Settings,
  Sparkles,
  Database,
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

export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Workspace",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, shortcut: "G D" },
      { href: "/cases", label: "Cases", icon: FolderKanban, shortcut: "G C", badge: "cases" },
      { href: "/denials", label: "Denials & appeals", icon: Gavel, shortcut: "G E" },
      { href: "/assistant", label: "Ask Necessa", icon: Sparkles, shortcut: "G A" },
    ],
  },
  {
    section: "Knowledge",
    items: [
      { href: "/policies", label: "Policy library", icon: BookOpen, shortcut: "G P" },
      { href: "/codes", label: "Code explorer", icon: Network },
    ],
  },
  {
    section: "Insights",
    items: [{ href: "/analytics", label: "Analytics", icon: ChartColumn, perm: "analytics:read", shortcut: "G R" }],
  },
  {
    section: "Administration",
    items: [
      { href: "/knowledge", label: "Knowledge ops", icon: Database, perm: "knowledge:admin", badge: "review" },
      { href: "/admin/models", label: "Models & providers", icon: Cpu, perm: "knowledge:admin" },
      { href: "/admin/evals", label: "Evaluations", icon: FlaskConical, perm: "evals:read" },
      { href: "/admin/audit", label: "Audit log", icon: ScrollText, perm: "audit:read" },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((s) => s.items);
export { Activity };
