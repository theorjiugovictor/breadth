import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { EDGE_STYLE, edgeColor } from "../graph/visual";
import type { ViewEdge } from "../graph/view";

export interface EdgeData extends Record<string, unknown> {
  e: ViewEdge;
  traversed: boolean;
  showLabel: boolean;
}

function labelText(e: ViewEdge): string | undefined {
  const parts: string[] = [];
  if (e.loop) parts.push("↻");
  // Plain code calls only show how often; protocol edges (http, sql, kafka...) show what.
  const meaningful = e.protocols.length > 0 || e.kind !== "call";
  if (meaningful && e.label) parts.push(e.label);
  else if (meaningful && e.protocols.length) parts.push(e.protocols.join(", "));
  if (e.count > 1) parts.push(`×${e.count}`);
  return parts.length ? parts.join(" ") : undefined;
}

export const FlowEdge = memo(function FlowEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd } = props;
  const d = data as EdgeData;
  const e = d.e;
  const style = EDGE_STYLE[e.kind];
  let path: string;
  let lx: number;
  let ly: number;
  if (e.source === e.target) {
    // Recursion: a loop arcing over the card from its output back to its input.
    const lift = 70;
    path = `M ${sourceX} ${sourceY} C ${sourceX + 70} ${sourceY - lift - 30}, ${targetX - 70} ${targetY - lift - 30}, ${targetX} ${targetY}`;
    lx = (sourceX + targetX) / 2;
    ly = Math.min(sourceY, targetY) - lift - 8;
  } else if (targetX < sourceX + 30) {
    // Back edge (target is left of the source): swing below both ends instead of cutting across.
    const low = Math.max(sourceY, targetY) + 60 + Math.min(120, Math.abs(sourceY - targetY) * 0.25);
    const mx = (sourceX + targetX) / 2;
    path = `M ${sourceX} ${sourceY} C ${sourceX + 90} ${sourceY}, ${sourceX + 90} ${low}, ${mx} ${low} S ${targetX - 90} ${targetY}, ${targetX} ${targetY}`;
    lx = mx;
    ly = low;
  } else {
    [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  }
  const text = d.showLabel ? labelText(e) : undefined;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: edgeColor(e.kind),
          strokeWidth: style.width + Math.min(2, Math.log10(Math.max(1, e.count))),
          strokeDasharray: style.dash,
          opacity: e.conditional ? 0.75 : 1,
        }}
        interactionWidth={14}
      />
      {text && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label nodrag nopan${d.traversed ? " traversed" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            title={`${style.label}${e.protocols.length ? ` (${e.protocols.join(", ")})` : ""}: ${e.count} ${e.count === 1 ? "occurrence" : "occurrences"}${e.folded > 1 ? `, ${e.folded} edges folded` : ""}${e.conditional ? ", conditional" : ""}${e.loop ? ", in a loop" : ""}`}
          >
            {text}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
