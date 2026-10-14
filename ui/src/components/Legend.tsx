import { EDGE_KINDS, type EdgeKind } from "@noodles/schema";
import { EDGE_STYLE, edgeColor } from "../graph/visual";

export function Legend({ kinds }: { kinds: Set<EdgeKind> }) {
  const shown = EDGE_KINDS.filter((k) => kinds.has(k));
  if (!shown.length) return null;
  return (
    <div className="legend" aria-label="Edge legend">
      {shown.map((k) => (
        <div className="item" key={k}>
          <svg width="22" height="6">
            <line x1="1" y1="3" x2="21" y2="3" stroke={edgeColor(k)} strokeWidth={2} strokeDasharray={EDGE_STYLE[k].dash} />
          </svg>
          {EDGE_STYLE[k].label}
        </div>
      ))}
    </div>
  );
}
