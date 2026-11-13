import type { CoverageGraph } from "@/lib/api/types";

type GNode = CoverageGraph["nodes"][number];

export interface CoveragePolicy {
  key: string;
  title: string;
  kind: "lcd" | "ncd" | "payer" | "article";
  version?: number;
  contractors: string[];
  states: string[];
  /** False for policies the code points to that haven't been loaded into the library yet. */
  inLibrary: boolean;
}

export interface CoverageGroup {
  id: string;
  name: string;
  detail?: string;
  policies: CoveragePolicy[];
}

const POLICY_KINDS = new Set(["lcd", "ncd", "payer"]);

function adjacency(g: CoverageGraph) {
  const adj = new Map<string, Set<string>>();
  for (const e of g.edges) {
    (adj.get(e.source) ?? adj.set(e.source, new Set()).get(e.source)!).add(e.target);
    (adj.get(e.target) ?? adj.set(e.target, new Set()).get(e.target)!).add(e.source);
  }
  return adj;
}

/** Every coverage policy touching the code, with who issues it and where it applies. */
export function listPolicies(g: CoverageGraph): CoveragePolicy[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n] as const));
  const adj = adjacency(g);
  const withPolicies = g.nodes.some((n) => POLICY_KINDS.has(n.type));
  const out: CoveragePolicy[] = [];
  for (const n of g.nodes) {
    const isPolicy = POLICY_KINDS.has(n.type) || (!withPolicies && n.type === "article");
    if (!isPolicy) continue;
    const near = [...(adj.get(n.id) ?? [])].map((id) => byId.get(id)).filter((x): x is GNode => !!x);
    const contractors = near.filter((x) => x.type === "contractor");
    let states = near.filter((x) => x.type === "state").map((x) => x.label);
    if (!states.length) states = contractors.flatMap((c) => [...(adj.get(c.id) ?? [])].map((id) => byId.get(id)).filter((x) => x?.type === "state").map((x) => x!.label));
    out.push({
      key: n.label,
      title: (n.meta?.title as string) ?? n.label,
      kind: n.type as CoveragePolicy["kind"],
      version: typeof n.meta?.version === "number" ? n.meta.version : undefined,
      contractors: contractors.map((c) => c.label),
      states: [...new Set(states)].sort(),
      inLibrary: n.meta?.indexed !== false,
    });
  }
  return out;
}

/** National policies first, then one group per issuing Medicare contractor (largest first). */
export function groupPolicies(policies: CoveragePolicy[]): CoverageGroup[] {
  const national = policies.filter((p) => p.kind === "ncd");
  const payer = policies.filter((p) => p.kind === "payer");
  const rest = policies.filter((p) => p.kind === "lcd" || p.kind === "article");
  const by = new Map<string, CoveragePolicy[]>();
  for (const p of rest) {
    const k = p.contractors[0] ?? "Other Medicare contractors";
    by.set(k, [...(by.get(k) ?? []), p]);
  }
  const groups: CoverageGroup[] = [];
  if (national.length) groups.push({ id: "national", name: "National policies", detail: "Apply in every state", policies: national });
  if (payer.length) groups.push({ id: "payer", name: "Health plan policies", policies: payer });
  [...by.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([name, list]) => groups.push({ id: name, name, policies: list.sort((a, b) => a.key.localeCompare(b.key)) }));
  return groups;
}

/** A small, readable graph for the map view: the code, up to `cap` policies, their contractors and states. */
export function reduceForMap(g: CoverageGraph, shown: CoveragePolicy[], cap = 8, stateCap = 10): { graph: CoverageGraph; hidden: number } {
  const code = g.nodes.find((n) => n.type === "code");
  const picked = shown.slice(0, cap);
  const nodes: CoverageGraph["nodes"] = code ? [code] : [];
  const edges: CoverageGraph["edges"] = [];
  const byLabel = new Map(g.nodes.map((n) => [n.label, n] as const));
  const contractorIds = new Set<string>();
  const stateLabels = new Set<string>();
  for (const p of picked) {
    const pn = byLabel.get(p.key);
    if (!pn) continue;
    nodes.push(pn);
    if (code) edges.push({ source: code.id, target: pn.id, type: "covers" });
    for (const c of p.contractors) {
      const cn = byLabel.get(c);
      if (!cn) continue;
      if (!contractorIds.has(cn.id)) nodes.push(cn);
      contractorIds.add(cn.id);
      edges.push({ source: pn.id, target: cn.id, type: "issued by" });
    }
    p.states.forEach((s) => stateLabels.add(s));
  }
  const states = [...stateLabels].sort();
  for (const s of states.slice(0, stateCap)) {
    const sn = byLabel.get(s);
    if (!sn) continue;
    nodes.push(sn);
    for (const p of picked) if (p.states.includes(s)) edges.push({ source: byLabel.get(p.key)!.id, target: sn.id, type: "applies in" });
  }
  if (states.length > stateCap) nodes.push({ id: "state:more", type: "state", label: `+${states.length - stateCap} more`, meta: {} });
  return { graph: { nodes, edges }, hidden: Math.max(0, shown.length - cap) };
}
