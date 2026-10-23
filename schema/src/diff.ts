import type { FlowGraph, FlowNode, Insight } from "./types.js";

export interface GraphDiff {
  added: string[];
  removed: string[];
  /** Nodes whose signature (ports, structure, description, parent) changed. */
  changed: string[];
  edgesAdded: string[];
  edgesRemoved: string[];
  insightsAdded: Insight[];
  insightsResolved: Insight[];
}

/** What identifies a node's meaning, ignoring line numbers (edits above a function move it). */
function signature(n: FlowNode): string {
  const m = n.metadata;
  return JSON.stringify([n.name, n.kind, n.role, m?.verdict, m?.stale, n.parent, n.inputs, n.outputs, n.description, m?.shape, m?.size, m?.decorators, m?.public, m?.encrypted, m?.iam_broad, m?.settings, m?.plan_action]);
}

/** Differences between two versions of a graph (used by live mode). */
export function diffGraphs(before: FlowGraph, after: FlowGraph): GraphDiff {
  const a = new Map(before.nodes.map((n) => [n.id, n]));
  const b = new Map(after.nodes.map((n) => [n.id, n]));
  const added = [...b.keys()].filter((id) => !a.has(id));
  const removed = [...a.keys()].filter((id) => !b.has(id));
  const changed = [...b.keys()].filter((id) => a.has(id) && signature(a.get(id)!) !== signature(b.get(id)!));
  const ea = new Set(before.edges.map((e) => e.id));
  const eb = new Set(after.edges.map((e) => e.id));
  const ia = new Map((before.insights ?? []).map((i) => [i.id, i]));
  const ib = new Map((after.insights ?? []).map((i) => [i.id, i]));
  return {
    added,
    removed,
    changed,
    edgesAdded: [...eb].filter((id) => !ea.has(id)),
    edgesRemoved: [...ea].filter((id) => !eb.has(id)),
    insightsAdded: [...ib.values()].filter((i) => !ia.has(i.id)),
    insightsResolved: [...ia.values()].filter((i) => !ib.has(i.id)),
  };
}

export function isEmptyDiff(d: GraphDiff): boolean {
  return !d.added.length && !d.removed.length && !d.changed.length && !d.edgesAdded.length && !d.edgesRemoved.length && !d.insightsAdded.length && !d.insightsResolved.length;
}
