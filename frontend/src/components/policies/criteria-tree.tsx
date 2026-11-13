import { Layers, Quote } from "lucide-react";
import type { CriteriaNode } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/display";

const KIND: Record<string, string> = {
  positive: "Clinical",
  negative_attestation: "Attestation",
  documentation: "Documentation",
  temporal: "Duration",
  numeric: "Measure",
};

export function CriteriaTreeView({ node, depth = 0, onEdit }: { node: CriteriaNode; depth?: number; onEdit?: (n: CriteriaNode) => void }) {
  if (node.children?.length) {
    return (
      <div className={cn("grid gap-2", depth > 0 && "rounded-lg border border-dashed border-border-strong bg-surface-2/30 p-2.5")}>
        <p className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted">
          <Layers className="size-3.5 text-subtle" />
          {node.op === "OR" ? "Any one of" : node.op === "N_OF_M" ? `At least ${node.n} of` : "All of the following"}
        </p>
        {node.children.map((c, i) => (
          <CriteriaTreeView key={c.id ?? i} node={c} depth={depth + 1} onEdit={onEdit} />
        ))}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-subtle">{node.id}</span>
        <span className="min-w-0 flex-1 text-[13px] font-medium text-fg">{node.text}</span>
        {node.kind ? (
          <Badge tone={node.kind === "negative_attestation" ? "insufficient" : "outline"} size="xs">
            {KIND[node.kind]}
          </Badge>
        ) : null}
        {node.lookbackDays ? <Badge size="xs">lookback {node.lookbackDays} d</Badge> : null}
        {onEdit ? (
          <button onClick={() => onEdit(node)} className="text-xs text-brand hover:underline">
            Edit
          </button>
        ) : null}
      </div>
      {node.sourceSpan ? (
        <p className="mt-2 flex gap-2 text-xs leading-relaxed text-muted">
          <Quote className="mt-0.5 size-3 shrink-0" />
          <span>
            <mark className="mark-policy">{node.sourceSpan.quote}</mark> <span className="text-subtle">· {node.sourceSpan.section.replace(/_/g, " ")}</span>
          </span>
        </p>
      ) : null}
    </div>
  );
}
