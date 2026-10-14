import { CircleAlert, CircleDot, GitCompareArrows, Info } from "lucide-react";
import type { BehaviorChange, GraphDiffInfo } from "@breadth/schema";
import type { GraphIndex } from "../graph/model";

const ICON = { high: CircleAlert, medium: CircleDot, low: Info } as const;
const COLOR = { high: "var(--sev-critical)", medium: "var(--sev-warning)", low: "var(--sev-info)" } as const;

interface Props {
  index: GraphIndex;
  diff: GraphDiffInfo;
  active?: number;
  onSelect: (i: number | undefined) => void;
}

/** The behaviour changes of a diff graph (`breadth diff -o`), most important first. */
export function ChangesList({ index, diff, active, onSelect }: Props) {
  const kind = (ids: string[], k: string) => ids.filter((id) => index.nodes.get(id)?.kind === k).length;
  const fnAdded = kind(diff.added, "function");
  const fnRemoved = kind(diff.removed, "function");
  const fnChanged = kind(diff.changed, "function");
  return (
    <div>
      <div className="diff-head">
        <GitCompareArrows size={15} />
        <span className="mono">{diff.base ?? "before"}</span> → <span className="mono">{diff.head ?? "after"}</span>
      </div>
      <div className="diff-counts">
        <span className="c-add">+{fnAdded}</span>
        <span className="c-del">−{fnRemoved}</span>
        <span className="c-chg">~{fnChanged}</span> functions · <span className="c-add">+{diff.edgesAdded.length}</span>{" "}
        <span className="c-del">−{diff.edgesRemoved.length}</span> connections
      </div>
      {diff.changes.length === 0 && (
        <div className="empty-note" style={{ padding: "4px 4px" }}>
          No behaviour changes: the same calls, data access and endpoints as before.
        </div>
      )}
      {diff.changes.map((c: BehaviorChange, i) => {
        const Icon = ICON[c.severity];
        return (
          <button key={i} className={`change-row${active === i ? " on" : ""}`} onClick={() => onSelect(active === i ? undefined : i)}>
            <Icon size={14} color={COLOR[c.severity]} style={{ flex: "none", marginTop: 2 }} />
            <span>{c.text}</span>
          </button>
        );
      })}
      <div className="side-foot">Green is new, red dashed is gone, amber changed. Click a change to see it on the canvas.</div>
    </div>
  );
}
