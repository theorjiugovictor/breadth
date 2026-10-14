import { useMemo, useState } from "react";
import { CircleAlert, Info, Play, TriangleAlert } from "lucide-react";
import type { Insight, InsightCategory, Severity } from "@breadth/schema";
import type { GraphIndex } from "../graph/model";
import { nodeVisual } from "../graph/visual";

const SEV_ICON: Record<Severity, typeof Info> = { critical: CircleAlert, warning: TriangleAlert, info: Info };
const SEV_COLOR: Record<Severity, string> = { critical: "var(--sev-critical)", warning: "var(--sev-warning)", info: "var(--sev-info)" };
const CATS: { id: InsightCategory; label: string }[] = [
  { id: "inefficiency", label: "Inefficiency" },
  { id: "redundancy", label: "Redundancy" },
  { id: "risk", label: "Risk" },
];

interface Props {
  index: GraphIndex;
  insights: Insight[];
  active?: string;
  onSelect: (id: string | undefined) => void;
  onReplay: (i: Insight) => void;
  onNode: (id: string) => void;
}

export function InsightsList({ index, insights, active, onSelect, onReplay, onNode }: Props) {
  const [cats, setCats] = useState<Set<InsightCategory>>(new Set());
  const shown = useMemo(() => insights.filter((i) => !cats.size || (i.category && cats.has(i.category))), [insights, cats]);
  const counts = useMemo(() => {
    const m = new Map<InsightCategory, number>();
    for (const i of insights) if (i.category) m.set(i.category, (m.get(i.category) ?? 0) + 1);
    return m;
  }, [insights]);

  if (!insights.length) {
    return (
      <div className="empty-note" style={{ padding: "4px 4px" }}>
        No insights for this graph. Rules look for N+1 queries, repeated work, chatty services, shared state with many writers, sensitive data
        sent to third parties and unused infrastructure. Importing traces enables the runtime rules.
      </div>
    );
  }

  return (
    <div>
      <div className="cat-chips">
        {CATS.filter((c) => counts.get(c.id)).map((c) => (
          <button
            key={c.id}
            className={`cat-chip${cats.has(c.id) ? " on" : ""}`}
            onClick={() => {
              const s = new Set(cats);
              if (s.has(c.id)) s.delete(c.id);
              else s.add(c.id);
              setCats(s);
            }}
          >
            {c.label} {counts.get(c.id)}
          </button>
        ))}
      </div>
      {shown.map((i) => {
        const Icon = SEV_ICON[i.severity];
        const on = i.id === active;
        return (
          <div
            key={i.id}
            className={`insight${on ? " on" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(on ? undefined : i.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSelect(on ? undefined : i.id);
            }}
          >
            <div className="insight-head">
              <Icon size={14} color={SEV_COLOR[i.severity]} />
              <div className="insight-title">{i.title}</div>
            </div>
            {i.detail && <div className="insight-detail">{i.detail}</div>}
            <div className="insight-meta">
              <span className="tag">{i.rule}</span>
              {i.execution && <span className="tag">runtime</span>}
              {i.confidence === "low" && <span className="tag">low confidence</span>}
            </div>
            {on && (
              <>
                <div className="insight-nodes">
                  {i.nodes.slice(0, 6).map((id) => {
                    const n = index.nodes.get(id);
                    if (!n) return null;
                    const { Icon: NI, color } = nodeVisual(n);
                    return (
                      <button
                        key={id}
                        className="link-row"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNode(id);
                        }}
                      >
                        <NI size={13} color={color} />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.name}</span>
                      </button>
                    );
                  })}
                </div>
                {i.execution && i.steps?.length ? (
                  <div className="insight-actions">
                    <button
                      className="btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onReplay(i);
                      }}
                    >
                      <Play size={12} /> Replay where it happens
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        );
      })}
      <div className="insights-note">Findings are signals, not verdicts: code reached through reflection, cron jobs or other repos may not be in this graph.</div>
    </div>
  );
}
