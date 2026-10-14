import ELK from "elkjs/lib/elk.bundled.js";
import type { Port } from "@noodles/schema";
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
  const edges = view.edges
    .filter((e) => e.source !== e.target && byId.has(e.source) && byId.has(e.target))
    .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }));

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
