import ELK from "elkjs/lib/elk.bundled.js";
import type { Port } from "@breadth/schema";
import type { View, ViewNode } from "./view";

export const CARD_WIDTH = 248;
export const MAX_PORTS = 6;
const HEAD = 58;
const ROW = 22;
const GHOST_HEIGHT = 58;

/** Ports actually drawn on a card (others are summarised as "+N more"). */
export function visiblePorts(ports: Port[] | undefined): { shown: Port[]; more: number } {
  const list = ports ?? [];
  return { shown: list.slice(0, MAX_PORTS), more: Math.max(0, list.length - MAX_PORTS) };
}

export function cardHeight(v: ViewNode): number {
  if (v.ghost || v.more) return GHOST_HEIGHT;
  const ins = visiblePorts(v.node.inputs);
  const outs = visiblePorts(v.node.outputs);
  const rows = Math.max(ins.shown.length + (ins.more ? 1 : 0), outs.shown.length + (outs.more ? 1 : 0));
  return rows ? HEAD + 1 + 12 + rows * ROW : HEAD;
}

/** Handle id for an edge end: a named port when it is drawn, else the card's main handle. */
export function handleId(v: ViewNode | undefined, side: "in" | "out", port?: string): string {
  if (!v || !port || v.ghost) return side;
  const list = side === "in" ? v.node.inputs : v.node.outputs;
  return visiblePorts(list).shown.some((p) => p.name === port) ? `${side}:${port}` : side;
}

const elk = new ELK();

export interface Positioned {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Left-to-right layered layout. */
export async function layoutView(view: View): Promise<Map<string, Positioned>> {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const children = view.nodes.map((n) => ({
    id: n.id,
    width: CARD_WIDTH,
    height: cardHeight(n),
  }));
  // Flow edges (calls, events, data) decide the left-to-right order; structural edges and
  // edges to context nodes may be reversed first when ELK has to break cycles.
  const priority = (e: View["edges"][number]) => {
    const ghost = byId.get(e.source)?.ghost || byId.get(e.target)?.ghost;
    const flow = e.kind === "call" || e.kind === "event" || e.kind === "data" || e.kind === "write";
    return (flow ? 10 : e.kind === "network" ? 4 : 1) - (ghost ? 1 : 0) + (e.protocols.includes("http") ? 5 : 0);
  };
  // Break cycles ourselves: add edges from most to least important and reverse (for layout only)
  // any edge that would close a cycle. ELK then lays out a DAG where flow edges point right.
  const succ = new Map<string, Set<string>>();
  const reaches = (from: string, to: string): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const n = stack.pop()!;
      if (n === to) return true;
      if (seen.has(n)) continue;
      seen.add(n);
      for (const m of succ.get(n) ?? []) stack.push(m);
    }
    return false;
  };
  const link = (a: string, b: string) => {
    if (!succ.has(a)) succ.set(a, new Set());
    succ.get(a)!.add(b);
  };
  const edges = view.edges
    .filter((e) => e.source !== e.target && byId.has(e.source) && byId.has(e.target))
    .map((e, i) => ({ e, i, p: priority(e) }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map(({ e }) => {
      const reverse = reaches(e.target, e.source);
      if (reverse) link(e.target, e.source);
      else link(e.source, e.target);
      return { id: e.id, sources: [reverse ? e.target : e.source], targets: [reverse ? e.source : e.target] };
    });

  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "34",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.layered.spacing.edgeNodeBetweenLayers": "30",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "70",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.aspectRatio": "1.6",
    },
    children,
    edges,
  });

  const out = new Map<string, Positioned>();
  for (const c of res.children ?? []) {
    out.set(c.id, { id: c.id, x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? CARD_WIDTH, height: c.height ?? HEAD });
  }
  return out;
}
