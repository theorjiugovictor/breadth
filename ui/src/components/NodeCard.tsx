import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ChevronsDown, Repeat, TriangleAlert } from "lucide-react";
import type { Port, Severity } from "@breadth/schema";
import { nodeVisual } from "../graph/visual";
import { visiblePorts } from "../graph/layout";
import type { ViewNode } from "../graph/view";

export interface CardData extends Record<string, unknown> {
  v: ViewNode;
  selected: boolean;
  active: boolean;
  visited: boolean;
  dim: boolean;
  runs: number;
  error: boolean;
  hasSelfLoop: boolean;
  /** Ring colour when part of the selected insight. */
  insight?: Severity;
  /** Insight badge in map mode. */
  flag?: { count: number; severity: Severity };
  /** Live mode: appeared or changed in the latest update (a card holding changed nodes counts as edited). */
  change?: "new" | "edited" | "removed";
}

function subtitle(v: ViewNode, label: string): string {
  if (v.more) return "grouped";
  const n = v.node;
  if (v.ghost) return `${label} · outside this view`;
  const bits = [label];
  if (n.kind === "network_endpoint" && n.metadata?.service) bits.push(String(n.metadata.service));
  else if (n.metadata?.engine || n.metadata?.system) bits.push(String(n.metadata?.engine ?? n.metadata?.system));
  else if (n.source?.file && n.kind === "function") bits.push(`${n.source.file.split("/").pop()}:${n.source.line ?? ""}`);
  else if (n.metadata?.type) bits.push(String(n.metadata.type));
  return bits.join(" · ");
}

function PortRows({ ports, side }: { ports?: Port[]; side: "in" | "out" }) {
  const { shown, more } = visiblePorts(ports);
  return (
    <>
      {shown.map((p, i) => (
        <div key={p.name} className={`port ${side}`} style={{ gridRow: i + 1 }} title={`${p.name}${p.type ? `: ${p.type}` : ""}`}>
          {side === "in" && <Handle type="target" position={Position.Left} id={`in:${p.name}`} className="h" style={{ left: 0 }} />}
          <span>{p.name}</span>
          {p.type && <span className="ptype">{p.type.length > 14 ? p.type.slice(0, 13) + "…" : p.type}</span>}
          {side === "out" && <Handle type="source" position={Position.Right} id={`out:${p.name}`} className="h" style={{ right: 0 }} />}
        </div>
      ))}
      {more > 0 && (
        <div className={`port ${side} more`} style={{ gridRow: shown.length + 1 }}>
          <span>+{more} more</span>
        </div>
      )}
    </>
  );
}

export const NodeCard = memo(function NodeCard({ data }: NodeProps) {
  const d = data as CardData;
  const { v } = d;
  const { Icon, color, label } = nodeVisual(v.node);
  const showPorts = !v.ghost && !v.more && ((v.node.inputs?.length ?? 0) > 0 || (v.node.outputs?.length ?? 0) > 0);
  const cls = ["card", v.ghost && "ghost", d.selected && "selected", d.active && "active", d.visited && "visited", d.dim && "dim", d.error && "error", d.insight && `flagged sev-${d.insight}`, d.change && `live-${d.change}`]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls} title={v.node.description ?? v.node.name}>
      <Handle type="target" position={Position.Left} id="in" className="h h-main" style={{ top: 29, left: 0 }} />
      <Handle type="source" position={Position.Right} id="out" className="h h-main" style={{ top: 29, right: 0 }} />
      <div className="badges">
        {d.change && <span className={`badge live-${d.change}`}>{d.change}</span>}
        {d.flag && (
          <span className={`badge sev-${d.flag.severity}`} title={`${d.flag.count} insight${d.flag.count === 1 ? "" : "s"}`}>
            <TriangleAlert size={10} /> {d.flag.count}
          </span>
        )}
        {d.runs > 1 && <span className="badge runs">×{d.runs}</span>}
        {d.runs === 1 && <span className="badge runs">ran</span>}
        {d.error && <span className="badge err">error</span>}
        {d.hasSelfLoop && (
          <span className="badge" title="Calls itself (recursion)">
            <Repeat size={10} /> self
          </span>
        )}
        {v.childCount > 0 && !v.ghost && (
          <span className="badge" title="Double-click to open">
            {v.childCount} inside
          </span>
        )}
      </div>
      <div className="card-head">
        <span className="kind-icon" style={{ background: `color-mix(in srgb, ${color} 13%, transparent)`, color }}>
          <Icon size={18} strokeWidth={2} />
        </span>
        <div className="card-title">
          <div className="card-name">{v.node.name}</div>
          <div className="card-sub">{subtitle(v, label)}</div>
        </div>
        {v.childCount > 0 && !v.ghost && <ChevronsDown size={15} color="var(--text-3)" />}
      </div>
      {showPorts && (
        <div className="ports">
          <div style={{ display: "contents" }}>
            <PortRows ports={v.node.inputs} side="in" />
          </div>
          <div style={{ display: "contents" }}>
            <PortRows ports={v.node.outputs} side="out" />
          </div>
        </div>
      )}
    </div>
  );
});
