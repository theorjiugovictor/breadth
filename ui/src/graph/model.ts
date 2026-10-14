import type { Execution, FlowEdge, FlowGraph, FlowNode, Step } from "@noodles/schema";

/** Read-only indexes over a flowgraph. Built once per loaded graph. */
export interface GraphIndex {
  graph: FlowGraph;
  nodes: Map<string, FlowNode>;
  /** parent id ('' for roots) -> child ids */
  children: Map<string, string[]>;
  /** Total descendants per node. */
  descendants: Map<string, number>;
  edgesByNode: Map<string, FlowEdge[]>;
  executions: Execution[];
  /** node id -> steps touching it, per execution id */
  stepsByNode: Map<string, Map<string, Step[]>>;
}

export const ROOT = "";

export function buildIndex(graph: FlowGraph): GraphIndex {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const p = n.parent && nodes.has(n.parent) ? n.parent : ROOT;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(n.id);
  }
  const descendants = new Map<string, number>();
  const count = (id: string): number => {
    if (descendants.has(id)) return descendants.get(id)!;
    descendants.set(id, 0); // guards against cycles
    const kids = children.get(id) ?? [];
    const total = kids.reduce((s, k) => s + 1 + count(k), 0);
    descendants.set(id, total);
    return total;
  };
  for (const n of graph.nodes) count(n.id);

  const edgesByNode = new Map<string, FlowEdge[]>();
  for (const e of graph.edges) {
    for (const id of new Set([e.from.node, e.to.node])) {
      if (!edgesByNode.has(id)) edgesByNode.set(id, []);
      edgesByNode.get(id)!.push(e);
    }
  }

  const executions = graph.executions ?? [];
  const stepsByNode = new Map<string, Map<string, Step[]>>();
  for (const x of executions) {
    for (const s of x.steps) {
      if (!stepsByNode.has(s.node)) stepsByNode.set(s.node, new Map());
      const m = stepsByNode.get(s.node)!;
      if (!m.has(x.id)) m.set(x.id, []);
      m.get(x.id)!.push(s);
    }
  }
  return { graph, nodes, children, descendants, edgesByNode, executions, stepsByNode };
}

/** Ancestors from the root down to (not including) the node. */
export function ancestors(index: GraphIndex, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = index.nodes.get(id)?.parent;
  while (cur && index.nodes.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.unshift(cur);
    cur = index.nodes.get(cur)?.parent;
  }
  return out;
}

export function childrenOf(index: GraphIndex, focus: string): string[] {
  return index.children.get(focus) ?? [];
}

/**
 * The highest useful level to start at: descend while the current level has a single
 * node that has children (e.g. one repo/system wrapping everything).
 */
export function defaultFocus(index: GraphIndex): string {
  let focus = ROOT;
  for (let i = 0; i < 10; i++) {
    const kids = childrenOf(index, focus);
    // Descend when exactly one node here has children; leaf siblings (external APIs,
    // datastores) still appear as context nodes one level down.
    const containers = kids.filter((k) => index.children.get(k)?.length);
    if (containers.length !== 1 || kids.length > 8) break;
    focus = containers[0];
  }
  return focus;
}

/** Lowest common ancestor of several nodes ('' = root). */
export function commonAncestor(index: GraphIndex, ids: string[]): string {
  if (!ids.length) return ROOT;
  let common = [ROOT, ...ancestors(index, ids[0])];
  for (const id of ids.slice(1)) {
    const chain = [ROOT, ...ancestors(index, id)];
    let i = 0;
    while (i < common.length && i < chain.length && common[i] === chain[i]) i++;
    common = common.slice(0, i);
  }
  return common[common.length - 1] ?? ROOT;
}
