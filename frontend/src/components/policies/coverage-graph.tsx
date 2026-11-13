"use client";

import "@xyflow/react/dist/style.css";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { Building2, FileText, Hash, MapPin, ScrollText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import type { CoverageGraph } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const COL: Record<string, number> = { code: 0, article: 1, lcd: 2, ncd: 2, contractor: 3, state: 4 };
const META: Record<string, { icon: typeof Hash; tone: string; label: string }> = {
  code: { icon: Hash, tone: "bg-fg text-bg", label: "Code" },
  article: { icon: FileText, tone: "bg-surface-2 text-muted", label: "Article" },
  lcd: { icon: ScrollText, tone: "bg-brand-soft text-brand-fg", label: "LCD" },
  ncd: { icon: ScrollText, tone: "bg-info-soft text-info", label: "NCD" },
  contractor: { icon: Building2, tone: "bg-surface-2 text-muted", label: "MAC" },
  state: { icon: MapPin, tone: "bg-met-soft text-met-fg", label: "State" },
};

type NodeData = { label: string; kind: string; title?: string };

function GraphNode({ data }: NodeProps<Node<NodeData>>) {
  const m = META[data.kind] ?? META.article!;
  const Icon = m.icon;
  return (
    <div className={cn("min-w-[120px] max-w-[200px] rounded-[10px] border border-border bg-surface px-2.5 py-2 shadow-e1", data.kind === "code" && "border-fg")}>
      <Handle type="target" position={Position.Left} className="!size-1.5 !border-0 !bg-border-strong" />
      <div className="flex items-center gap-1.5">
        <span className={cn("flex size-5 items-center justify-center rounded-md", m.tone)}>
          <Icon className="size-3" />
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-subtle">{m.label}</span>
      </div>
      <p className="mt-1 truncate font-mono text-xs font-semibold text-fg">{data.label}</p>
      {data.title ? <p className="line-clamp-2 text-[10.5px] leading-snug text-muted">{data.title}</p> : null}
      <Handle type="source" position={Position.Right} className="!size-1.5 !border-0 !bg-border-strong" />
    </div>
  );
}

const nodeTypes = { n: GraphNode };

export function CoverageGraphView({ graph, height = 480 }: { graph: CoverageGraph; height?: number }) {
  const router = useRouter();
  const { nodes, edges } = useMemo(() => {
    const byCol = new Map<number, CoverageGraph["nodes"]>();
    graph.nodes.forEach((n) => {
      const c = COL[n.type] ?? 1;
      byCol.set(c, [...(byCol.get(c) ?? []), n]);
    });
    const nodes: Node<NodeData>[] = [];
    byCol.forEach((list, col) => {
      list.forEach((n, i) => {
        nodes.push({
          id: n.id,
          type: "n",
          position: { x: col * 250, y: i * 96 - ((list.length - 1) * 96) / 2 },
          data: { label: n.label, kind: n.type, title: (n.meta?.title as string) ?? (n.meta?.desc as string) ?? (n.meta?.name as string) },
        });
      });
    });
    const edges: Edge[] = graph.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.source,
      target: e.target,
      animated: e.type === "listed_in",
      style: { stroke: "var(--border-strong)", strokeWidth: 1.4 },
      label: e.type.replace(/_/g, " "),
      labelStyle: { fontSize: 9, fill: "var(--fg-subtle)" },
      labelBgStyle: { fill: "var(--surface)" },
    }));
    return { nodes, edges };
  }, [graph]);

  return (
    <div style={{ height }} className="overflow-hidden rounded-xl border border-border bg-surface-2/30">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesDraggable
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => {
          const [type, key] = n.id.split(":");
          if (type === "lcd" || type === "article" || type === "ncd") router.push(`/policies/pol-${key!.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
        }}
        minZoom={0.3}
      >
        <Background gap={24} size={1} color="var(--grid-line)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
