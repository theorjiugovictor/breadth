import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { EDGE_KINDS, LAYERS, type EdgeKind, type FlowNode, type Layer } from "@noodles/schema";
import type { GraphIndex } from "../graph/model";
import { ancestors } from "../graph/model";
import { EDGE_STYLE, LAYER_LABEL, edgeColor, nodeVisual } from "../graph/visual";
import type { Filters } from "../graph/view";

interface Props {
  index: GraphIndex;
  filters: Filters;
  onFilters: (f: Filters) => void;
  onPick: (id: string) => void;
}

function search(index: GraphIndex, q: string): FlowNode[] {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const scored: [number, FlowNode][] = [];
  for (const n of index.graph.nodes) {
    const name = n.name.toLowerCase();
    let s = -1;
    if (name === query) s = 0;
    else if (name.startsWith(query)) s = 1;
    else if (name.includes(query)) s = 2;
    else if (n.id.toLowerCase().includes(query) || n.source?.file?.toLowerCase().includes(query)) s = 3;
    else if (n.description?.toLowerCase().includes(query)) s = 4;
    if (s >= 0) scored.push([s * 1000 + Math.min(999, name.length), n]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, 30).map(([, n]) => n);
}

export function Sidebar({ index, filters, onFilters, onPick }: Props) {
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const results = useMemo(() => search(index, q), [index, q]);

  const layerCounts = useMemo(() => {
    const m = new Map<Layer, number>();
    for (const n of index.graph.nodes) m.set(n.layer, (m.get(n.layer) ?? 0) + 1);
    return m;
  }, [index]);
  const edgeCounts = useMemo(() => {
    const m = new Map<EdgeKind, number>();
    for (const e of index.graph.edges) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    return m;
  }, [index]);

  const toggleLayer = (l: Layer) => {
    const s = new Set(filters.layers);
    if (s.has(l)) s.delete(l);
    else s.add(l);
    onFilters({ ...filters, layers: s });
  };
  const toggleEdge = (k: EdgeKind) => {
    const s = new Set(filters.edgeKinds);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    onFilters({ ...filters, edgeKinds: s });
  };
  const pick = (id: string) => {
    onPick(id);
    setQ("");
  };

  return (
    <aside className="sidebar">
      <div className="search">
        <Search size={15} />
        <input
          placeholder="Search nodes…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setHl(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setHl((h) => Math.min(results.length - 1, h + 1));
            if (e.key === "ArrowUp") setHl((h) => Math.max(0, h - 1));
            if (e.key === "Enter" && results[hl]) pick(results[hl].id);
            if (e.key === "Escape") setQ("");
          }}
          aria-label="Search nodes"
        />
      </div>
      {q && (
        <div className="results">
          {results.length === 0 && <div className="result empty-note">No matches</div>}
          {results.map((n, i) => {
            const { Icon, color } = nodeVisual(n);
            const path = ancestors(index, n.id)
              .map((a) => index.nodes.get(a)?.name)
              .join(" › ");
            return (
              <button key={n.id} className={`result${i === hl ? " hl" : ""}`} onClick={() => pick(n.id)} onMouseEnter={() => setHl(i)}>
                <Icon size={15} color={color} style={{ flex: "none" }} />
                <div style={{ minWidth: 0 }}>
                  <div className="r-name">{n.name}</div>
                  {path && <div className="r-path">{path}</div>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="group">
        <div className="section-title">
          Layers
          <button onClick={() => onFilters({ ...filters, layers: new Set(LAYERS) })}>all</button>
        </div>
        {LAYERS.map((l) => {
          const on = filters.layers.has(l);
          const count = layerCounts.get(l) ?? 0;
          return (
            <button key={l} className={`toggle-row${on ? "" : " off"}`} onClick={() => toggleLayer(l)} disabled={!count} style={{ opacity: count ? 1 : 0.45 }}>
              <span className="check">{on && <Check size={11} strokeWidth={3} />}</span>
              {LAYER_LABEL[l]}
              <span className="count">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="group">
        <div className="section-title">
          Connections
          <button onClick={() => onFilters({ ...filters, edgeKinds: new Set(EDGE_KINDS) })}>all</button>
        </div>
        {EDGE_KINDS.map((k) => {
          const on = filters.edgeKinds.has(k);
          const count = edgeCounts.get(k) ?? 0;
          return (
            <button key={k} className={`toggle-row${on ? "" : " off"}`} onClick={() => toggleEdge(k)} disabled={!count} style={{ opacity: count ? 1 : 0.45 }}>
              <span className="check">{on && <Check size={11} strokeWidth={3} />}</span>
              <svg width="22" height="6" style={{ flex: "none" }}>
                <line x1="1" y1="3" x2="21" y2="3" stroke={edgeColor(k)} strokeWidth={2} strokeDasharray={EDGE_STYLE[k].dash} />
              </svg>
              {EDGE_STYLE[k].label}
              <span className="count">{count}</span>
            </button>
          );
        })}
      </div>
      <div className="side-foot">
        Double-click a card to open it. Click to inspect. Use the breadcrumbs to go back up.
      </div>
    </aside>
  );
}
