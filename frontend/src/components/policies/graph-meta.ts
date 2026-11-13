import { Building2, FileText, Hash, MapPin, ScrollText } from "lucide-react";
import type { CoverageGraph } from "@/lib/api/types";

/** Shared, dependency-light metadata so pages can render legends without loading the map library. */
export type GraphKind = CoverageGraph["nodes"][number]["type"];

export const NODE_META: Record<GraphKind, { icon: typeof Hash; tone: string; label: string; stroke: string }> = {
  code: { icon: Hash, tone: "bg-fg text-bg", label: "Code", stroke: "var(--fg)" },
  article: { icon: FileText, tone: "bg-surface-2 text-muted", label: "Article", stroke: "var(--border-strong)" },
  lcd: { icon: ScrollText, tone: "bg-brand-soft text-brand-fg", label: "Local policy", stroke: "var(--brand)" },
  ncd: { icon: ScrollText, tone: "bg-surface-2 text-fg", label: "National policy", stroke: "var(--fg-muted)" },
  payer: { icon: ScrollText, tone: "bg-surface-2 text-fg", label: "Health plan policy", stroke: "var(--fg-muted)" },
  contractor: { icon: Building2, tone: "bg-surface-2 text-muted", label: "Medicare contractor", stroke: "var(--border-strong)" },
  state: { icon: MapPin, tone: "bg-surface-2 text-muted", label: "State", stroke: "var(--border-strong)" },
};

/** Policy detail accepts either the UUID or the CMS source key (e.g. L33718). */
export function policyHref(sourceKey: string) {
  return `/policies/${encodeURIComponent(sourceKey)}`;
}
