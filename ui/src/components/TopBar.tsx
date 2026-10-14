import { useEffect, useState } from "react";
import { ChevronRight, Moon, PanelLeft, Play, Map as MapIcon, Sun, Upload, ChevronDown, House } from "lucide-react";
import type { GraphIndex } from "../graph/model";
import { ancestors, ROOT } from "../graph/model";
import type { DemoEntry } from "../data";
import type { LiveState } from "../live";

interface Props {
  index: GraphIndex;
  focus: string;
  mode: "map" | "trace";
  theme: "light" | "dark";
  graphName: string;
  fileName: string;
  demos: DemoEntry[];
  onFocus: (id: string) => void;
  onMode: (m: "map" | "trace") => void;
  onTheme: () => void;
  onToggleSide: () => void;
  onOpenFile: () => void;
  onDemo: (d: DemoEntry) => void;
  live?: LiveState;
}

export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#ff6d5a" />
      <path d="M7 11c5 0 5 10 10 10s4-10 8-10" stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="7" cy="11" r="2.5" fill="#fff" />
      <circle cx="25" cy="11" r="2.5" fill="#fff" />
    </svg>
  );
}

export function TopBar(p: Props) {
  const chain = p.focus === ROOT ? [] : [...ancestors(p.index, p.focus), p.focus];
  const hasRuns = p.index.executions.length > 0;
  return (
    <header className="topbar">
      <button className="icon-btn" onClick={p.onToggleSide} title="Toggle sidebar" aria-label="Toggle sidebar">
        <PanelLeft size={17} />
      </button>
      <a className="brand" href={IS_HOME ? "../" : "#"} title="noodles">
        <Logo />
        noodles
      </a>
      <nav className="crumbs" aria-label="Breadcrumbs">
        <button className={`crumb${chain.length === 0 ? " current" : ""}`} onClick={() => p.onFocus(ROOT)} title={`${p.graphName}: everything`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <House size={14} /> {chain.length === 0 ? p.graphName : ""}
        </button>
        {chain.map((id, i) => (
          <span key={id} style={{ display: "contents" }}>
            <ChevronRight size={14} className="crumb-sep" />
            <button className={`crumb${i === chain.length - 1 ? " current" : ""}`} onClick={() => p.onFocus(id)} title={id}>
              {p.index.nodes.get(id)?.name ?? id}
            </button>
          </span>
        ))}
      </nav>
      {p.live && <LiveBadge live={p.live} />}
      <span className="stats">
        {p.index.graph.nodes.length} nodes · {p.index.graph.edges.length} edges
        {hasRuns ? ` · ${p.index.executions.length} runs` : ""}
      </span>
      {p.demos.length > 1 && (
        <label className="seg" style={{ position: "relative", padding: 0 }}>
          <select
            aria-label="Demo graph"
            style={{ appearance: "none", border: 0, background: "none", padding: "7px 28px 7px 12px", cursor: "pointer", fontWeight: 500 }}
            value={p.demos.find((d) => d.file === p.fileName)?.file ?? ""}
            onChange={(e) => {
              const d = p.demos.find((x) => x.file === e.target.value);
              if (d) p.onDemo(d);
            }}
          >
            {!p.demos.some((d) => d.file === p.fileName) && <option value="">{p.fileName}</option>}
            {p.demos.map((d) => (
              <option key={d.file} value={d.file}>
                {d.title}
              </option>
            ))}
          </select>
          <ChevronDown size={14} style={{ position: "absolute", right: 9, top: 9, pointerEvents: "none", color: "var(--text-3)" }} />
        </label>
      )}
      <div className="seg" role="tablist" aria-label="Mode">
        <button className={p.mode === "map" ? "on" : ""} onClick={() => p.onMode("map")} role="tab" aria-selected={p.mode === "map"}>
          <MapIcon size={14} /> Map
        </button>
        <button
          className={p.mode === "trace" ? "on" : ""}
          onClick={() => p.onMode("trace")}
          disabled={!hasRuns}
          title={hasRuns ? "Replay a recorded execution" : "No executions in this graph. Import traces with `noodles import-traces`."}
          role="tab"
          aria-selected={p.mode === "trace"}
        >
          <Play size={13} /> Trace
        </button>
      </div>
      <button className="icon-btn" onClick={p.onOpenFile} title="Open a flowgraph.json" aria-label="Open file">
        <Upload size={16} />
      </button>
      <button className="icon-btn" onClick={p.onTheme} title="Toggle theme" aria-label="Toggle theme">
        {p.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </header>
  );
}

/** "Live" pill; shows what the coding agent is doing while it works. */
function LiveBadge({ live }: { live: LiveState }) {
  const [, tick] = useState(0);
  const a = live.agent;
  const fresh = !!a && Date.now() - a.at < 15_000;
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => tick((n) => n + 1), 15_000);
    return () => clearTimeout(t);
  }, [fresh, a?.at]);
  const doing = fresh && a ? (a.files.length ? `editing ${a.files[0].split("/").pop()}` : a.event === "UserPromptSubmit" ? "got a task" : "working") : "";
  return (
    <span className={`live-pill${live.connected ? "" : " off"}`} title={live.connected ? "Updates as files change" : "Reconnecting to noodles watch…"}>
      <span className={`live-dot${live.connected ? " on" : ""}`} />
      Live
      {doing && (
        <span className="live-doing">
          · {a!.agent} {doing}
        </span>
      )}
    </span>
  );
}

declare const __NOODLES_PAGES__: boolean;
const IS_HOME = typeof __NOODLES_PAGES__ !== "undefined" && __NOODLES_PAGES__;
