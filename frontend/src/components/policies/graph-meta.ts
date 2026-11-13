import { Building2, FileText, Hash, MapPin, ScrollText } from "lucide-react";
import type { CoverageGraph } from "@/lib/api/types";

/** Shared, dependency-light metadata so pages can render legends without loading React Flow. */
export type GraphKind = CoverageGraph["nodes"][number]["type"];

export const NODE_META: Record<GraphKind, { icon: typeof Hash; tone: string; label: string; stroke: string }> = {
  code: { icon: Hash, tone: "bg-fg text-bg", label: "Code", stroke: "var(--fg)" },
  article: { icon: FileText, tone: "bg-surface-2 text-muted", label: "Article", stroke: "var(--border-strong)" },
  lcd: { icon: ScrollText, tone: "bg-brand-soft text-brand-fg", label: "LCD", stroke: "var(--brand)" },
  ncd: { icon: ScrollText, tone: "bg-info-soft text-info", label: "NCD", stroke: "var(--info)" },
  contractor: { icon: Building2, tone: "bg-surface-2 text-muted", label: "MAC", stroke: "var(--border-strong)" },
  state: { icon: MapPin, tone: "bg-met-soft text-met-fg", label: "State", stroke: "var(--met)" },
};

/** Policy detail accepts either the UUID or the CMS source key (e.g. L33718). */
export function policyHref(sourceKey: string) {
  return `/policies/${encodeURIComponent(sourceKey)}`;
}
