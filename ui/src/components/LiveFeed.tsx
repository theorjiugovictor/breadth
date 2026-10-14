import { useEffect, useState } from "react";
import { Bot, CircleAlert, FilePen, Lightbulb, Sparkles } from "lucide-react";
import type { GraphIndex } from "../graph/model";
import { nodeVisual } from "../graph/visual";
import type { ActivityEntry, LiveState, NodeRef } from "../live";

interface Props {
  index: GraphIndex;
  live: LiveState;
  followAgent: boolean;
  onFollowAgent: (on: boolean) => void;
  onNode: (id: string) => void;
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function LiveFeed({ index, live, followAgent, onFollowAgent, onNode }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="live-feed">
      <div className="live-head">
        <span className={`live-dot${live.connected ? " on" : ""}`} />
        {live.connected ? "Watching for changes" : "Reconnecting…"}
        <label className="live-follow" title="Open the level where the latest change happened">
          <input type="checkbox" checked={followAgent} onChange={(e) => onFollowAgent(e.target.checked)} /> Follow
        </label>
      </div>
      {live.target && <div className="live-target mono">{live.target}</div>}
      {live.activity.length === 0 && (
        <div className="empty-note" style={{ padding: "4px 4px" }}>
          Nothing yet. Edit a file, or let your coding agent work: every change appears here and on the canvas as it happens. Run{" "}
          <code>noodles hook --print-config</code> to connect Claude Code, so tasks and edits are attributed to it.
        </div>
      )}
      {live.activity.map((a) => (
        <Entry key={a.id} a={a} index={index} now={now} onNode={onNode} />
      ))}
    </div>
  );
}

function Entry({ a, index, now, onNode }: { a: ActivityEntry; index: GraphIndex; now: number; onNode: (id: string) => void }) {
  if (a.kind === "task") {
    return (
      <div className="act task">
        <div className="act-head">
          <Bot size={14} /> <b>{a.agent ?? "agent"}</b> got a task <span className="act-time">{ago(a.at, now)}</span>
        </div>
        <div className="act-prompt">{a.prompt}</div>
      </div>
    );
  }
  if (a.kind === "error") {
    return (
      <div className="act error">
        <div className="act-head">
          <CircleAlert size={14} /> Scan failed <span className="act-time">{ago(a.at, now)}</span>
        </div>
        <div className="act-prompt">{a.message}</div>
      </div>
    );
  }
  const files = a.files ?? [];
  return (
    <div className="act">
      <div className="act-head">
        {a.agent ? <Bot size={14} /> : <FilePen size={14} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={files.join("\n")}>
          {a.agent ? <b>{a.agent}</b> : "Edited"} {files.length ? files.slice(0, 2).map((f) => f.split("/").pop()).join(", ") + (files.length > 2 ? ` +${files.length - 2}` : "") : ""}
        </span>
        <span className="act-time">{ago(a.at, now)}</span>
      </div>
      {a.narration && (
        <div className="act-narration">
          <Sparkles size={12} /> {a.narration}
        </div>
      )}
      <Refs label="new" refs={a.added} index={index} onNode={onNode} />
      <Refs label="edited" refs={a.changed} index={index} onNode={onNode} />
      <Refs label="removed" refs={a.removed} index={index} onNode={onNode} />
      {a.insightsAdded?.map((i) => (
        <button key={i.id} className={`act-insight sev-${i.severity}`} onClick={() => i.nodes[0] && onNode(i.nodes[0])}>
          <Lightbulb size={12} /> {i.title}
        </button>
      ))}
      {!!a.insightsResolved?.length && <div className="act-resolved">{a.insightsResolved.length} finding(s) resolved</div>}
    </div>
  );
}

function Refs({ label, refs, index, onNode }: { label: string; refs?: NodeRef[]; index: GraphIndex; onNode: (id: string) => void }) {
  if (!refs?.length) return null;
  // Folders and files are implied by the functions inside them; list them only when alone.
  const leaves = refs.filter((r) => r.kind !== "module");
  const shown = (leaves.length ? leaves : refs).slice(0, 8);
  const extra = (leaves.length ? leaves : refs).length - shown.length;
  return (
    <div className="act-refs">
      <span className={`act-tag ${label}`}>{label}</span>
      {shown.map((r) => {
        const node = index.nodes.get(r.id);
        const gone = !node;
        const { Icon, color } = nodeVisual(node ?? ({ kind: r.kind, name: r.name } as never));
        return (
          <button key={r.id} className="act-ref" disabled={gone} onClick={() => onNode(r.id)} title={r.file ?? r.id}>
            <Icon size={12} color={color} /> {r.name}
          </button>
        );
      })}
      {extra > 0 && <span className="act-more">+{extra}</span>}
    </div>
  );
}
