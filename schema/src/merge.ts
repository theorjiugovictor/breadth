import { edgeId } from "./ids.js";
import {
  SCHEMA_VERSION,
  type Execution,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type Port,
} from "./types.js";

export const MAX_SAMPLES_PER_EDGE = 20;

/**
 * Merge flowgraphs into one. Pure and deterministic:
 * - nodes are unified when their ids or aliases collide; the first node seen keeps its id
 * - scalar fields: the earlier graph wins, empty values are filled from later graphs
 * - ports are unioned by name, tags/aliases are unioned, metadata is shallow-merged
 * - edges are re-pointed to canonical ids and deduped (counts summed, samples concatenated)
 * - executions are deduped by id
 */
export function mergeGraphs(...graphs: FlowGraph[]): FlowGraph {
  // 1. Group nodes whose identity keys (id + aliases) overlap, with union-find.
  const allNodes = graphs.flatMap((g) => g.nodes);
  const uf = new UnionFind();
  for (const n of allNodes) {
    uf.add(n.id);
    for (const a of n.aliases ?? []) uf.union(n.id, a);
  }

  // Canonical id per group: the id of the first node seen in that group.
  const canonicalByRoot = new Map<string, string>();
  for (const n of allNodes) {
    const root = uf.find(n.id);
    if (!canonicalByRoot.has(root)) canonicalByRoot.set(root, n.id);
  }
  const canon = (key: string): string => {
    if (!uf.has(key)) return key;
    return canonicalByRoot.get(uf.find(key)) ?? key;
  };

  // 2. Merge nodes in group order.
  const nodes = new Map<string, FlowNode>();
  for (const n of allNodes) {
    const id = canon(n.id);
    const existing = nodes.get(id);
    nodes.set(id, existing ? mergeNode(existing, n) : { ...n, id });
  }
  for (const n of nodes.values()) {
    const aliases = new Set(n.aliases ?? []);
    if (n.parent !== undefined) {
      const p = canon(n.parent);
      if (p === n.id) delete n.parent;
      else n.parent = p;
    }
    aliases.delete(n.id);
    if (aliases.size) n.aliases = [...aliases].sort();
    else delete n.aliases;
  }

  // 3. Edges.
  const edges = new Map<string, FlowEdge>();
  for (const g of graphs) {
    for (const e of g.edges) {
      const from = { ...e.from, node: canon(e.from.node) };
      const to = { ...e.to, node: canon(e.to.node) };
      const moved = from.node !== e.from.node || to.node !== e.to.node;
      const id = moved ? edgeId(e.kind, from, to) : e.id;
      const next: FlowEdge = { ...e, id, from, to };
      const existing = edges.get(id);
      edges.set(id, existing ? mergeEdge(existing, next) : next);
    }
  }

  // 4. Executions.
  const executions = new Map<string, Execution>();
  for (const g of graphs) {
    for (const x of g.executions ?? []) {
      if (executions.has(x.id)) continue;
      executions.set(x.id, { ...x, steps: x.steps.map((s) => ({ ...s, node: canon(s.node) })) });
    }
  }

  const out: FlowGraph = {
    version: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
  const sources = graphs.flatMap((g) => g.sources ?? []);
  if (sources.length) out.sources = sources;
  if (executions.size) out.executions = [...executions.values()];
  return out;
}

function mergeNode(a: FlowNode, b: FlowNode): FlowNode {
  const out: FlowNode = { ...a };
  out.description ||= b.description;
  if (out.parent === undefined && b.parent !== undefined) out.parent = b.parent;
  out.aliases = union(a.aliases, [...(b.aliases ?? []), b.id]);
  out.inputs = mergePorts(a.inputs, b.inputs);
  out.outputs = mergePorts(a.outputs, b.outputs);
  if (b.source) out.source = { ...b.source, ...stripUndefined(a.source ?? {}) };
  out.tags = union(a.tags, b.tags);
  if (b.metadata) out.metadata = { ...b.metadata, ...(a.metadata ?? {}) };
  return clean(out);
}

function mergeEdge(a: FlowEdge, b: FlowEdge): FlowEdge {
  const out: FlowEdge = { ...a };
  out.protocol ??= b.protocol;
  out.label ??= b.label;
  if (b.loop) out.loop = true;
  if (b.conditional) out.conditional = true;
  if (a.count !== undefined || b.count !== undefined) out.count = (a.count ?? 0) + (b.count ?? 0);
  const samples = [...(a.samples ?? []), ...(b.samples ?? [])].slice(0, MAX_SAMPLES_PER_EDGE);
  if (samples.length) out.samples = samples;
  if (b.metadata) out.metadata = { ...b.metadata, ...(a.metadata ?? {}) };
  return clean(out);
}

function mergePorts(a: Port[] | undefined, b: Port[] | undefined): Port[] | undefined {
  if (!a?.length) return b?.length ? [...b] : undefined;
  if (!b?.length) return [...a];
  const byName = new Map(a.map((p) => [p.name, { ...p }]));
  for (const p of b) {
    const cur = byName.get(p.name);
    byName.set(p.name, cur ? { ...p, ...stripUndefined(cur) } : { ...p });
  }
  return [...byName.values()];
}

function union(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  const s = new Set([...(a ?? []), ...(b ?? [])]);
  return s.size ? [...s] : undefined;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

class UnionFind {
  private parent = new Map<string, string>();
  has(x: string) {
    return this.parent.has(x);
  }
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    this.add(x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = x;
    while (c !== r) {
      const next = this.parent.get(c)!;
      this.parent.set(c, r);
      c = next;
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}
