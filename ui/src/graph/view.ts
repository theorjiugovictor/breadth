import type { EdgeKind, FlowEdge, FlowNode, Layer } from "@noodles/schema";
import { ancestors, childrenOf, ROOT, type GraphIndex } from "./model";

export const MAX_NODES = 150;
const MAX_GHOSTS = 30;
export const MORE_ID = "__more__";

export interface Filters {
  layers: Set<Layer>;
  edgeKinds: Set<EdgeKind>;
}

export interface ViewNode {
  id: string;
  node: FlowNode;
  /** Outside the current focus, shown for context. */
  ghost: boolean;
  childCount: number;
  /** For the overflow node: how many nodes it stands for. */
  more?: number;
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Sum of underlying edge counts (call sites, spans). */
  count: number;
  /** Number of underlying edges folded into this one. */
  folded: number;
  label?: string;
  protocols: string[];
  loop: boolean;
  conditional: boolean;
  sourcePort?: string;
  targetPort?: string;
  edgeIds: string[];
  hasSamples: boolean;
}

export interface View {
  focus: string;
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** Map any graph node to the node that represents it in this view (undefined = hidden). */
  repOf: (id: string) => string | undefined;
  hidden: number;
}

/**
 * @param pinned nodes to show as themselves (not folded into an ancestor) when they are outside
 *               the focus, e.g. the nodes of the selected insight.
 */
export function computeView(index: GraphIndex, focus: string, filters: Filters, maxNodes = MAX_NODES, pinned?: Set<string>): View {
  const focusChain = focus === ROOT ? [ROOT] : [ROOT, ...ancestors(index, focus), focus];

  // A node is shown if its layer is on, or if something inside it is.
  const layerMemo = new Map<string, boolean>();
  const layerVisible = (id: string): boolean => {
    if (layerMemo.has(id)) return layerMemo.get(id)!;
    layerMemo.set(id, false);
    const n = index.nodes.get(id);
    const v = !!n && (filters.layers.has(n.layer) || (index.children.get(id) ?? []).some(layerVisible));
    layerMemo.set(id, v);
    return v;
  };

  const inside = childrenOf(index, focus).filter(layerVisible);
  const insideSet = new Set(inside);

  // rep: the node standing for `id` at this level. Inside the focus: the focus child containing it.
  // Outside: the first ancestor that diverges from the focus chain (a "ghost" for context).
  const repMemo = new Map<string, string | undefined>();
  const rawRep = (id: string): string | undefined => {
    if (repMemo.has(id)) return repMemo.get(id);
    let rep: string | undefined;
    if (index.nodes.has(id)) {
      const chain = [ROOT, ...ancestors(index, id), id];
      const k = chain.indexOf(focus);
      if (focus !== ROOT && id === focus) rep = focus;
      else if (k >= 0 && k < chain.length - 1) rep = chain[k + 1];
      else if (pinned?.has(id) && !focusChain.includes(id)) rep = id;
      else if (pinned && k < 0 && chain.some((c) => pinned.has(c) && !focusChain.includes(c))) rep = chain.find((c) => pinned.has(c) && !focusChain.includes(c));
      else {
        let i = 0;
        while (i < chain.length && i < focusChain.length && chain[i] === focusChain[i]) i++;
        rep = chain[i];
      }
      if (rep !== undefined && !layerVisible(rep)) rep = undefined;
    }
    repMemo.set(id, rep);
    return rep;
  };

  const kindOn = (e: FlowEdge) => filters.edgeKinds.has(e.kind);

  const aggregate = (map: (rep: string) => string) => {
    const agg = new Map<string, ViewEdge>();
    for (const e of index.graph.edges) {
      if (!kindOn(e)) continue;
      const ra = rawRep(e.from.node);
      const rb = rawRep(e.to.node);
      if (ra === undefined || rb === undefined) continue;
      const a = map(ra);
      const b = map(rb);
      const aInside = insideSet.has(ra) || a === MORE_ID;
      const bInside = insideSet.has(rb) || b === MORE_ID;
      if (!aInside && !bInside) continue;
      if (a === b && !(e.from.node === e.to.node && ra === e.from.node)) continue;
      const direct = ra === e.from.node && rb === e.to.node && a === ra && b === rb;
      const sp = direct ? e.from.port : undefined;
      const tp = direct ? e.to.port : undefined;
      const key = `${a}|${sp ?? ""}|${b}|${tp ?? ""}|${e.kind}`;
      let v = agg.get(key);
      if (!v) {
        v = {
          id: key,
          source: a,
          target: b,
          kind: e.kind,
          count: 0,
          folded: 0,
          protocols: [],
          loop: false,
          conditional: true,
          sourcePort: sp,
          targetPort: tp,
          edgeIds: [],
          hasSamples: false,
        };
        agg.set(key, v);
      }
      v.count += e.count ?? 1;
      v.folded += 1;
      v.edgeIds.push(e.id);
      if (e.protocol && !v.protocols.includes(e.protocol)) v.protocols.push(e.protocol);
      if (e.loop) v.loop = true;
      if (!e.conditional) v.conditional = false;
      if (e.samples?.length) v.hasSamples = true;
      if (e.label) {
        const labels = v.label ? v.label.split(" · ") : [];
        if (!labels.includes(e.label) && labels.length < 2) v.label = [...labels, e.label].join(" · ");
      }
    }
    return [...agg.values()];
  };

  let edges = aggregate((r) => r);

  // Ghost nodes: keep the most connected ones.
  const ghostDegree = new Map<string, number>();
  for (const e of edges) {
    for (const r of [e.source, e.target]) if (!insideSet.has(r)) ghostDegree.set(r, (ghostDegree.get(r) ?? 0) + e.count);
  }
  // Pinned ghosts are always kept, even without edges at this level.
  for (const id of pinned ?? []) {
    const r = rawRep(id);
    if (r && !insideSet.has(r) && !ghostDegree.has(r)) ghostDegree.set(r, Number.MAX_SAFE_INTEGER);
  }
  const ghosts = [...ghostDegree.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_GHOSTS).map(([id]) => id);
  const ghostSet = new Set(ghosts);

  // Cap the number of rendered nodes; the least connected overflow into one node.
  const insideCap = Math.max(10, maxNodes - ghosts.length);
  let overflow = new Set<string>();
  if (inside.length > insideCap) {
    const degree = new Map<string, number>();
    for (const e of edges) for (const r of [e.source, e.target]) degree.set(r, (degree.get(r) ?? 0) + e.count);
    const ranked = [...inside].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (index.descendants.get(b) ?? 0) - (index.descendants.get(a) ?? 0));
    overflow = new Set(ranked.slice(insideCap - 1));
    edges = aggregate((r) => (overflow.has(r) ? MORE_ID : r));
  }
  edges = edges.filter((e) => (insideSet.has(e.source) || ghostSet.has(e.source) || e.source === MORE_ID) && (insideSet.has(e.target) || ghostSet.has(e.target) || e.target === MORE_ID));

  const nodes: ViewNode[] = [];
  for (const id of inside) {
    if (overflow.has(id)) continue;
    nodes.push({ id, node: index.nodes.get(id)!, ghost: false, childCount: index.children.get(id)?.length ?? 0 });
  }
  if (overflow.size) {
    nodes.push({
      id: MORE_ID,
      node: { id: MORE_ID, name: `${overflow.size} more`, kind: "module", layer: "code", description: "Less connected nodes, grouped to keep the canvas readable. Search or drill in to see them." },
      ghost: false,
      childCount: 0,
      more: overflow.size,
    });
  }
  for (const id of ghosts) {
    const n = index.nodes.get(id);
    if (n) nodes.push({ id, node: n, ghost: true, childCount: index.children.get(id)?.length ?? 0 });
  }

  const repOf = (id: string) => {
    const r = rawRep(id);
    if (r === undefined) return undefined;
    if (overflow.has(r)) return MORE_ID;
    return insideSet.has(r) || ghostSet.has(r) ? r : undefined;
  };

  return { focus, nodes, edges, repOf, hidden: overflow.size };
}
