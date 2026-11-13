"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, UserRound } from "lucide-react";
import { Can } from "@/lib/api/session";
import { cn } from "@/lib/utils";

export function SettingsNav() {
  const p = usePathname();
  const item = (href: string, label: string, Icon: typeof UserRound) => (
    <Link
      href={href}
      className={cn("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors", p === href ? "bg-surface text-fg shadow-e1" : "text-muted hover:text-fg")}
    >
      <Icon className="size-4" /> {label}
    </Link>
  );
  return (
    <nav className="flex gap-1 lg:grid lg:content-start" aria-label="Settings">
      {item("/settings", "Personal", UserRound)}
      <Can perm="org:admin">{item("/settings/organization", "Organization", Building2)}</Can>
    </nav>
  );
}
