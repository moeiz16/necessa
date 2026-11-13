"use client";

import "@xyflow/react/dist/style.css";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { CoverageGraph } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { NODE_META, policyHref, type GraphKind as Kind } from "./graph-meta";

// A small, top-to-bottom map: code, policies, issuing contractors, states.
const LAYER: Record<Kind, number> = { code: 0, article: 1, lcd: 1, ncd: 1, payer: 1, contractor: 2, state: 3 };
// Each layer wraps into rows so the whole map stays near 1:1 zoom instead of one very wide strip.
const PER_ROW: Record<number, number> = { 0: 1, 1: 4, 2: 4, 3: 8 };
const GAP_X = (layer: number) => (layer === 3 ? 100 : 216);
const ROW_H = (layer: number) => (layer === 3 ? 48 : 100);
const LAYER_GAP = 46;

type NodeData = { label: string; kind: Kind; title?: string; dim?: boolean; focus?: boolean };

function MapNode({ data }: NodeProps<Node<NodeData>>) {
  const m = NODE_META[data.kind] ?? NODE_META.article;
  const Icon = m.icon;
  if (data.kind === "state")
    return (
      <div className={cn("w-[84px] rounded-md border bg-surface px-2 py-1.5 text-center text-[12px] font-medium text-fg transition-opacity", data.focus ? "border-brand ring-2 ring-brand/20" : "border-border", data.dim && "opacity-35")}>
        <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-border-strong" />
        {data.label}
        <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-border-strong" />
      </div>
    );
  return (
    <div
      className={cn(
        "w-[196px] rounded-lg border bg-surface px-2.5 py-2 transition-opacity duration-150",
        data.kind === "code" ? "border-fg" : "border-border",
        data.focus && "border-brand ring-2 ring-brand/20",
        data.dim && "opacity-35",
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-border-strong" />
      <div className="flex items-center gap-1.5 text-[11px] text-subtle">
        <Icon className="size-3" />
        {m.label}
      </div>
      <p className="mt-1 truncate text-[12.5px] font-medium text-fg">{data.label}</p>
      {data.title ? <p className="line-clamp-2 text-[11px] leading-snug text-muted">{data.title}</p> : null}
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-border-strong" />
    </div>
  );
}

const nodeTypes = { n: MapNode };

/** Everything connected to the selected node, so its full path can be highlighted. */
function connected(graph: CoverageGraph, id: string) {
  const out = new Set<string>([id]);
  const walk = (start: string, down: boolean) => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of graph.edges) {
        const next = down ? (e.source === cur ? e.target : null) : e.target === cur ? e.source : null;
        if (next && !out.has(next)) {
          out.add(next);
          stack.push(next);
        }
      }
    }
  };
  walk(id, true);
  walk(id, false);
  return out;
}

export function CoverageGraphView({ graph, height = 460 }: { graph: CoverageGraph; height?: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const path = useMemo(() => (selected ? connected(graph, selected) : null), [graph, selected]);

  const { nodes, edges } = useMemo(() => {
    const layers = new Map<number, CoverageGraph["nodes"]>();
    graph.nodes.forEach((n) => layers.set(LAYER[n.type] ?? 1, [...(layers.get(LAYER[n.type] ?? 1) ?? []), n]));
    const nodes: Node[] = [];
    let y = 0;
    [...layers.keys()].sort().forEach((layer) => {
      const list = layers.get(layer)!;
      const per = PER_ROW[layer] ?? 4;
      const rows = Math.ceil(list.length / per);
      list.forEach((n, i) => {
        const row = Math.floor(i / per);
        const inRow = Math.min(per, list.length - row * per);
        const col = i % per;
        nodes.push({
          id: n.id,
          type: "n",
          position: { x: (col - (inRow - 1) / 2) * GAP_X(layer), y: y + row * ROW_H(layer) },
          data: { label: n.label, kind: n.type, title: n.meta?.title as string | undefined, dim: !!path && !path.has(n.id), focus: selected === n.id },
        });
      });
      y += rows * ROW_H(layer) + LAYER_GAP;
    });
    const edges: Edge[] = graph.edges.map((e, i) => {
      const on = !path || (path.has(e.source) && path.has(e.target));
      return {
        id: `e${i}`,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        style: { stroke: on && path ? "var(--fg-muted)" : "var(--border-strong)", strokeWidth: 1.2, opacity: on ? 1 : 0.25 },
      };
    });
    return { nodes, edges };
  }, [graph, path, selected]);

  const sel = graph.nodes.find((n) => n.id === selected) ?? null;
  const policyLike = sel && (sel.type === "lcd" || sel.type === "ncd" || sel.type === "payer" || sel.type === "article");

  return (
    <div style={{ height }} className="relative overflow-hidden rounded-lg border border-border bg-surface-2/30">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.14, maxZoom: 1 }}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => setSelected((cur) => (cur === n.id ? null : n.id))}
        onPaneClick={() => setSelected(null)}
        minZoom={0.3}
        maxZoom={1.6}
      >
        <Background gap={24} size={1} color="var(--border)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      <p className="pointer-events-none absolute right-3 top-3 rounded-md bg-surface/90 px-2 py-1 text-[11px] text-subtle">
        {sel ? <span className="font-medium text-fg">{sel.label}</span> : "Select an item to trace its connections"}
      </p>
      {policyLike ? (
        <Link href={policyHref(sel.label)} className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-md bg-surface px-2.5 py-1.5 text-xs font-medium text-brand shadow-e1 hover:underline">
          Open {sel.label} <ArrowUpRight className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}
