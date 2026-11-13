"use client";

import "@xyflow/react/dist/style.css";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { CoverageGraph } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { NODE_META, policyHref, type GraphKind as Kind } from "./graph-meta";

const COL: Record<Kind, number> = { code: 0, article: 1, lcd: 2, ncd: 2, contractor: 3, state: 4 };
const COLUMNS = ["Code", "Billing & Coding articles", "Coverage determinations", "Contractors (MACs)", "States"];
// Top-to-bottom layers fit a wide, short panel far better than left-to-right columns.
const NODE_GAP = 224;
const LAYER_H = 118;

type NodeData = { label: string; kind: Kind; title?: string; dim?: boolean; focus?: boolean };

function GraphNode({ data }: NodeProps<Node<NodeData>>) {
  const m = NODE_META[data.kind] ?? NODE_META.article;
  const Icon = m.icon;
  return (
    <div
      className={cn(
        "w-[200px] rounded-[10px] border bg-surface px-2.5 py-2 shadow-e1 transition-[opacity,box-shadow,border-color] duration-200",
        data.kind === "code" ? "border-fg" : "border-border",
        data.focus && "border-brand shadow-e3 ring-2 ring-brand/25",
        data.dim && "opacity-35",
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-border-strong" />
      <div className="flex items-center gap-1.5">
        <span className={cn("flex size-5 items-center justify-center rounded-md", m.tone)}>
          <Icon className="size-3" />
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-subtle">{m.label}</span>
      </div>
      <p className="mt-1 truncate font-mono text-xs font-semibold text-fg">{data.label}</p>
      {data.title ? <p className="line-clamp-2 text-[10.5px] leading-snug text-muted">{data.title}</p> : null}
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-border-strong" />
    </div>
  );
}

function ColumnLabel({ data }: NodeProps<Node<{ label: string; count: number }>>) {
  return (
    <div className="w-[200px] select-none text-right text-[10.5px] font-medium uppercase tracking-wider text-subtle">
      {data.label} <span className="tabular text-fg/60">· {data.count}</span>
    </div>
  );
}

const nodeTypes = { n: GraphNode, col: ColumnLabel };

function neighbors(graph: CoverageGraph, id: string) {
  // Everything upstream and downstream of the selected node (its full coverage path).
  const out = new Set<string>([id]);
  const walk = (start: string, dir: "down" | "up") => {
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of graph.edges) {
        const next = dir === "down" ? (e.source === cur ? e.target : null) : e.target === cur ? e.source : null;
        if (next && !out.has(next)) {
          out.add(next);
          stack.push(next);
        }
      }
    }
  };
  walk(id, "down");
  walk(id, "up");
  return out;
}

/** Collapse a contractor's long state list into one node so the graph stays legible at 1:1 zoom. */
function compact(graph: CoverageGraph): CoverageGraph {
  const stateIds = new Set(graph.nodes.filter((n) => n.type === "state").map((n) => n.id));
  const byContractor = new Map<string, string[]>();
  for (const e of graph.edges) if (stateIds.has(e.target)) byContractor.set(e.source, [...(byContractor.get(e.source) ?? []), e.target]);
  const grouped = new Set<string>();
  const nodes = graph.nodes.filter((n) => n.type !== "state");
  const edges = graph.edges.filter((e) => !stateIds.has(e.target));
  const shown = new Set<string>();
  byContractor.forEach((states, contractor) => {
    if (states.length > 3) {
      const id = `states:${contractor}`;
      const labels = states.map((s) => s.replace("state:", ""));
      nodes.push({ id, type: "state", label: `${labels.length} states`, meta: { title: labels.join(" · ") } });
      edges.push({ source: contractor, target: id, type: "serves" });
      states.forEach((s) => grouped.add(s));
    } else {
      for (const s of states) {
        if (!shown.has(s)) nodes.push(graph.nodes.find((n) => n.id === s)!);
        shown.add(s);
        edges.push({ source: contractor, target: s, type: "serves" });
      }
    }
  });
  return { nodes, edges };
}

export function CoverageGraphView({ graph: raw, height = 540 }: { graph: CoverageGraph; height?: number }) {
  const graph = useMemo(() => compact(raw), [raw]);
  const [selected, setSelected] = useState<string | null>(null);
  const path = useMemo(() => (selected ? neighbors(graph, selected) : null), [graph, selected]);

  const { nodes, edges } = useMemo(() => {
    const byCol = new Map<number, CoverageGraph["nodes"]>();
    graph.nodes.forEach((n) => {
      const c = COL[n.type] ?? 1;
      byCol.set(c, [...(byCol.get(c) ?? []), n]);
    });
    const widest = Math.max(1, ...[...byCol.values()].map((l) => l.length));
    const left = -((widest - 1) * NODE_GAP) / 2;
    const nodes: Node[] = [];
    byCol.forEach((list, layer) => {
      nodes.push({ id: `col-${layer}`, type: "col", position: { x: left - NODE_GAP - 10, y: layer * LAYER_H + 26 }, data: { label: COLUMNS[layer], count: list.length }, draggable: false, selectable: false, focusable: false });
      list.forEach((n, i) => {
        nodes.push({
          id: n.id,
          type: "n",
          position: { x: i * NODE_GAP - ((list.length - 1) * NODE_GAP) / 2, y: layer * LAYER_H },
          data: {
            label: n.label,
            kind: n.type,
            title: (n.meta?.title as string) ?? (n.meta?.desc as string) ?? (n.meta?.name as string),
            dim: !!path && !path.has(n.id),
            focus: selected === n.id,
          },
        });
      });
    });
    const edges: Edge[] = graph.edges.map((e, i) => {
      const on = !path || (path.has(e.source) && path.has(e.target));
      const target = graph.nodes.find((n) => n.id === e.target);
      const stroke = on && path ? NODE_META[target?.type ?? "article"].stroke : "var(--border-strong)";
      return {
        id: `e${i}`,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        animated: e.type === "listed_in" && on,
        style: { stroke, strokeWidth: on && path ? 1.8 : 1.2, opacity: on ? 1 : 0.25 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: stroke },
        label: path && on ? e.type.replace(/_/g, " ") : undefined,
        labelStyle: { fontSize: 9, fill: "var(--fg-subtle)" },
        labelBgStyle: { fill: "var(--surface)" },
      };
    });
    return { nodes, edges };
  }, [graph, path, selected]);

  const sel = graph.nodes.find((n) => n.id === selected) ?? null;
  const selMeta = sel ? NODE_META[sel.type] : null;
  const policyLike = sel && (sel.type === "lcd" || sel.type === "ncd" || sel.type === "article");
  const outgoing = sel ? graph.edges.filter((e) => e.source === sel.id).length : 0;
  const incoming = sel ? graph.edges.filter((e) => e.target === sel.id).length : 0;

  return (
    <div style={{ height }} className="relative overflow-hidden rounded-xl border border-border bg-surface-2/30">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
        nodesDraggable
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => {
          if (n.type === "col") return;
          setSelected((cur) => (cur === n.id ? null : n.id));
        }}
        onPaneClick={() => setSelected(null)}
        minZoom={0.25}
        maxZoom={1.75}
      >
        <Background gap={24} size={1} color="var(--grid-line)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>

      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[60%] flex-wrap gap-1.5">
        {(["code", "article", "lcd", "ncd", "contractor", "state"] as Kind[]).map((k) => {
          const m = NODE_META[k];
          return (
            <span key={k} className="flex items-center gap-1 rounded-md bg-surface/90 px-1.5 py-1 text-[10.5px] text-muted shadow-e1 backdrop-blur">
              <span className={cn("flex size-3.5 items-center justify-center rounded", m.tone)}>
                <m.icon className="size-2.5" />
              </span>
              {m.label}
            </span>
          );
        })}
      </div>

      {sel && selMeta ? (
        <aside className="absolute bottom-3 right-3 w-[280px] rounded-xl border border-border bg-surface p-3.5 shadow-e3" aria-live="polite">
          <div className="flex items-start gap-2">
            <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", selMeta.tone)}>
              <selMeta.icon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[10.5px] font-medium uppercase tracking-wider text-subtle">{selMeta.label}</p>
              <p className="truncate font-mono text-[13px] font-semibold text-fg">{sel.label}</p>
            </div>
            <button onClick={() => setSelected(null)} className="rounded p-1 text-subtle hover:bg-surface-2 hover:text-fg" aria-label="Close details">
              <X className="size-3.5" />
            </button>
          </div>
          {(sel.meta?.title as string) || (sel.meta?.name as string) || (sel.meta?.desc as string) ? (
            <p className="mt-2 text-[12.5px] leading-snug text-fg">{(sel.meta?.title as string) ?? (sel.meta?.name as string) ?? (sel.meta?.desc as string)}</p>
          ) : null}
          <p className="mt-2 text-xs text-muted">
            {incoming} incoming · {outgoing} outgoing {sel.meta?.version ? `· version ${String(sel.meta.version)}` : ""}
          </p>
          <p className="mt-1 text-[11px] text-subtle">Highlighted: the full coverage path through this node.</p>
          {policyLike ? (
            <Link href={policyHref(sel.label)} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
              Open {sel.label} <ArrowUpRight className="size-3.5" />
            </Link>
          ) : null}
        </aside>
      ) : (
        <p className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-surface/90 px-2 py-1 text-[11px] text-subtle shadow-e1 backdrop-blur">Click a node to trace its coverage path</p>
      )}
    </div>
  );
}
