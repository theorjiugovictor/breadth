import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { layoutView, handleId, type Positioned } from "../graph/layout";
import type { View } from "../graph/view";
import type { Severity } from "@noodles/schema";
import { EDGE_HEX, nodeVisual } from "../graph/visual";
import { NodeCard, type CardData } from "./NodeCard";
import { FlowEdge, type EdgeData } from "./FlowEdge";

const nodeTypes = { card: NodeCard };
const edgeTypes = { flow: FlowEdge };

export interface InsightHighlight {
  nodes: Set<string>;
  edges: Set<string>;
  severity: Severity;
}

export interface TraceOverlay {
  activeNode?: string;
  visited: Set<string>;
  runs: Map<string, number>;
  errors: Set<string>;
  traversedEdges: Set<string>;
  currentEdge?: string;
}

interface Props {
  view: View;
  selected?: string;
  trace?: TraceOverlay;
  theme: "light" | "dark";
  centerOn?: string;
  /** The selected insight: its nodes/edges are emphasised, everything else dims. */
  highlight?: InsightHighlight;
  /** Insight counts per graph node (map mode badges). */
  flags?: Map<string, { count: number; severity: Severity }>;
  onSelect: (id: string | undefined) => void;
  onDrill: (id: string) => void;
}

const SEV_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };

export function Canvas({ view, selected, trace, theme, centerOn, highlight, flags, onSelect, onDrill }: Props) {
  const [positions, setPositions] = useState<Map<string, Positioned>>(new Map());
  const [layoutKey, setLayoutKey] = useState(0);
  const rf = useReactFlow();
  const viewRef = useRef(view);

  useEffect(() => {
    viewRef.current = view;
    let cancelled = false;
    layoutView(view).then((pos) => {
      if (cancelled) return;
      setPositions(pos);
      setLayoutKey((k) => k + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [view]);

  // Fit (or centre on a searched node) after each new layout.
  useEffect(() => {
    if (!layoutKey) return;
    const t = setTimeout(() => {
      const p = centerOn ? positions.get(centerOn) : undefined;
      if (p) rf.setCenter(p.x + p.width / 2, p.y + p.height / 2, { zoom: 1.1, duration: 350 });
      else rf.fitView({ padding: 0.14, duration: 300, maxZoom: 1.15 });
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // Map trace state (graph node ids) onto the nodes drawn at this level.
  const overlay = useMemo(() => {
    const active = trace?.activeNode ? view.repOf(trace.activeNode) : undefined;
    const visited = new Set<string>();
    const runs = new Map<string, number>();
    const errors = new Set<string>();
    if (trace) {
      for (const id of trace.visited) {
        const r = view.repOf(id);
        if (r) visited.add(r);
      }
      for (const [id, n] of trace.runs) {
        const r = view.repOf(id);
        if (r) runs.set(r, (runs.get(r) ?? 0) + n);
      }
      for (const id of trace.errors) {
        const r = view.repOf(id);
        if (r) errors.add(r);
      }
    }
    const hl = new Set<string>();
    for (const id of highlight?.nodes ?? []) {
      const r = view.repOf(id);
      if (r) hl.add(r);
    }
    const flagged = new Map<string, { count: number; severity: Severity }>();
    for (const [id, f] of flags ?? []) {
      const r = view.repOf(id);
      if (!r) continue;
      const cur = flagged.get(r);
      flagged.set(r, {
        count: (cur?.count ?? 0) + f.count,
        severity: cur && SEV_RANK[cur.severity] > SEV_RANK[f.severity] ? cur.severity : f.severity,
      });
    }
    return { active, visited, runs, errors, hl, flagged };
  }, [trace, view, highlight, flags]);

  const selfLoops = useMemo(() => new Set(view.edges.filter((e) => e.source === e.target).map((e) => e.source)), [view]);

  const nodes: Node[] = useMemo(() => {
    return view.nodes
      .filter((n) => positions.has(n.id))
      .map((n) => {
        const p = positions.get(n.id)!;
        const data: CardData = {
          v: n,
          selected: selected === n.id,
          active: overlay.active === n.id,
          visited: overlay.visited.has(n.id),
          dim: highlight ? !overlay.hl.has(n.id) : !!trace && !overlay.visited.has(n.id) && overlay.active !== n.id,
          insight: highlight && overlay.hl.has(n.id) ? highlight.severity : undefined,
          flag: !trace && !highlight ? overlay.flagged.get(n.id) : undefined,
          runs: trace ? (overlay.runs.get(n.id) ?? 0) : 0,
          error: overlay.errors.has(n.id),
          hasSelfLoop: selfLoops.has(n.id),
        };
        return { id: n.id, type: "card", position: { x: p.x, y: p.y }, data, draggable: true, selectable: false, initialWidth: p.width, initialHeight: p.height };
      });
  }, [view, positions, selected, overlay, trace, selfLoops, highlight]);

  const edges: Edge[] = useMemo(() => {
    const byId = new Map(view.nodes.map((n) => [n.id, n]));
    const showLabel = view.edges.length <= 120;
    const hex = EDGE_HEX[theme];
    return view.edges
      .filter((e) => positions.has(e.source) && positions.has(e.target))
      .map((e) => {
        const flaggedEdge =
          !!highlight &&
          (e.edgeIds.some((id) => highlight.edges.has(id)) || (!highlight.edges.size && overlay.hl.has(e.source) && overlay.hl.has(e.target)));
        const traversed = (!!trace && e.edgeIds.some((id) => trace.traversedEdges.has(id))) || flaggedEdge;
        const current = !!trace?.currentEdge && e.edgeIds.includes(trace.currentEdge);
        const data: EdgeData = { e, traversed, showLabel };
        const color = traversed ? "#ff6d5a" : hex[e.kind];
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: handleId(byId.get(e.source), "out", e.sourcePort),
          targetHandle: handleId(byId.get(e.target), "in", e.targetPort),
          type: "flow",
          data,
          className: [traversed && "traversed", current && "current", (trace || highlight) && !traversed && "dim"].filter(Boolean).join(" "),
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
          zIndex: traversed ? 2 : 0,
        } satisfies Edge;
      });
  }, [view, positions, trace, theme, highlight, overlay]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setPositions((prev) => {
      let next: Map<string, Positioned> | undefined;
      for (const c of changes) {
        if (c.type === "position" && c.position) {
          next ??= new Map(prev);
          const p = next.get(c.id);
          if (p) next.set(c.id, { ...p, x: c.position.x, y: c.position.y });
        }
      }
      return next ?? prev;
    });
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, n) => onSelect(n.id)}
      onNodeDoubleClick={(_, n) => {
        const v = view.nodes.find((x) => x.id === n.id);
        if (v && v.childCount > 0) onDrill(n.id);
      }}
      onPaneClick={() => onSelect(undefined)}
      colorMode={theme}
      minZoom={0.08}
      maxZoom={2.2}
      nodesConnectable={false}
      elementsSelectable={false}
      zoomOnDoubleClick={false}
      proOptions={{ hideAttribution: true }}
      fitView
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} color="var(--dots)" />
      <Controls showInteractive={false} position="bottom-right" />
      <MiniMap
        position="top-right"
        pannable
        zoomable
        nodeColor={(n) => nodeVisual((n.data as CardData).v.node).color}
        nodeBorderRadius={6}
        maskColor={theme === "dark" ? "rgba(0,0,0,0.45)" : "rgba(240,241,245,0.65)"}
        style={{ width: 150, height: 100, background: "var(--surface)" }}
      />
    </ReactFlow>
  );
}
