import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { EDGE_KINDS, LAYERS, type FlowGraph, type Insight, type Severity } from "@noodles/schema";
import { RULES, runInsights } from "@noodles/insights";
import { ancestors, buildIndex, commonAncestor, defaultFocus, ROOT } from "./graph/model";
import { computeView, MORE_ID, type Filters } from "./graph/view";
import { Canvas, type InsightHighlight, type TraceOverlay } from "./components/Canvas";
import { Sidebar, type SideTab } from "./components/Sidebar";
import { TopBar, Logo } from "./components/TopBar";
import { SidePanel, type Tab } from "./components/SidePanel";
import { TracePlayer } from "./components/TracePlayer";
import { Legend } from "./components/Legend";
import { loadDemo, loadInitial, parseGraph, type DemoEntry, type Loaded } from "./data";
import { RepoForm, RepoScan } from "./scan/RepoScan";
import { fetchInfo, useLive, type LiveState, type ServerInfo } from "./live";

type Theme = "light" | "dark";
type ChangeMark = { kind: "new" | "edited"; at: number };
/** How long "new" / "edited" badges stay on cards after a live update. */
const MARK_MS = 20_000;
/** Which changed node to follow: functions first, then other leaves, then files and folders. */
const FOLLOW_RANK: Record<string, number> = { function: 0, network_endpoint: 1, datastore: 1, queue: 1, external_api: 1, infra_resource: 1, module: 3 };

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("noodles-theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage blocked */
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded>();
  const [demos, setDemos] = useState<DemoEntry[]>([]);
  const [error, setError] = useState<string>();
  const [booting, setBooting] = useState(true);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [repo, setRepo] = useState(() => new URLSearchParams(location.search).get("repo") ?? undefined);
  const [info, setInfo] = useState<ServerInfo>();
  const live = useLive(!!info?.live, setLoaded);

  const scanRepo = useCallback((r: string | undefined) => {
    const url = new URL(location.href);
    if (r) url.searchParams.set("repo", r);
    else url.searchParams.delete("repo");
    history.replaceState(null, "", url);
    setRepo(r);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("noodles-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    if (repo) {
      setBooting(false);
      return;
    }
    Promise.all([loadInitial(), fetchInfo()])
      .then(([{ loaded, demos }, info]) => {
        setDemos(demos);
        setInfo(info);
        if (loaded) setLoaded(info?.live ? { ...loaded, origin: "live" } : loaded);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBooting(false));
  }, []);

  const openText = useCallback((text: string, name: string) => {
    try {
      setLoaded(parseGraph(text, name));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onFiles = useCallback(
    (files: FileList | null) => {
      const f = files?.[0];
      if (!f) return;
      f.text().then((t) => openText(t, f.name));
    },
    [openText],
  );

  // Drag & drop a flowgraph.json anywhere.
  useEffect(() => {
    const over = (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      onFiles(e.dataTransfer?.files ?? null);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [onFiles]);

  const hidden = (
    <input ref={fileInput} type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => onFiles(e.target.files)} />
  );

  if (repo && !loaded) {
    return (
      <RepoScan
        key={repo}
        input={repo}
        onDone={setLoaded}
        onCancel={() => {
          scanRepo(undefined);
          setBooting(true);
          loadInitial()
            .then(({ loaded, demos }) => {
              setDemos(demos);
              if (loaded) setLoaded(loaded);
            })
            .finally(() => setBooting(false));
        }}
      />
    );
  }

  if (booting) return <div className="center-screen empty-note">Loading…</div>;

  if (!loaded) {
    return (
      <div className="center-screen">
        {hidden}
        {dragging && <div className="drop-overlay" />}
        <div className="drop">
          <Logo />
          <h1>Open a flowgraph</h1>
          <p>Scan a public GitHub repository right here in the browser:</p>
          <RepoForm onSubmit={scanRepo} autoFocus />
          <p style={{ marginTop: 22 }}>
            Or run <code>noodles scan .</code> then <code>noodles serve</code>, or drop a <code>flowgraph.json</code> here.
          </p>
          {error && <p style={{ color: "var(--err)", whiteSpace: "pre-wrap" }}>{error}</p>}
          <button className="btn" onClick={() => fileInput.current?.click()}>
            Choose file
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {hidden}
      {dragging && <div className="drop-overlay" />}
      <ReactFlowProvider>
        <Workspace
          // A live graph changes in place: keep the workspace (focus, selection) across updates.
          key={loaded.origin === "live" ? "live" : loaded.name + loaded.graph.generatedAt}
          graph={loaded.graph}
          name={loaded.name}
          notice={loaded.notice}
          initialTab={loaded.origin === "repo" && (loaded.graph.insights?.length ?? 0) > 0 ? "insights" : "explore"}
          demos={demos}
          live={loaded.origin === "live" ? live : undefined}
          llm={info?.llm ?? undefined}
          theme={theme}
          onTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          onOpenFile={() => fileInput.current?.click()}
          onDemo={(d) => loadDemo(d).then(setLoaded).catch((e) => setError(e.message))}
        />
      </ReactFlowProvider>
    </>
  );
}

/** Breadcrumb root: the scanned project's name when known, else the file name. */
function rootLabel(graph: FlowGraph, file: string): string {
  const target = graph.sources?.find((s) => s.target)?.target;
  if (target && !target.endsWith(".json")) return target.replace(/\/+$/, "").split(/[\\/]/).pop() || file;
  return file.replace(/\.json$/, "");
}

interface WorkspaceProps {
  graph: FlowGraph;
  name: string;
  notice?: string;
  initialTab: SideTab;
  demos: DemoEntry[];
  live?: LiveState;
  llm?: { name: string; remote: boolean };
  theme: Theme;
  onTheme: () => void;
  onOpenFile: () => void;
  onDemo: (d: DemoEntry) => void;
}

function Workspace({ graph, name, notice, initialTab, demos, live, llm, theme, onTheme, onOpenFile, onDemo }: WorkspaceProps) {
  const [showNotice, setShowNotice] = useState(!!notice);
  const index = useMemo(() => buildIndex(graph), [graph]);
  const [focus, setFocus] = useState(() => defaultFocus(index));
  const [selected, setSelected] = useState<string>();
  const [centerOn, setCenterOn] = useState<string>();
  const [filters, setFilters] = useState<Filters>({ layers: new Set(LAYERS), edgeKinds: new Set(EDGE_KINDS) });
  const [mode, setMode] = useState<"map" | "trace">("map");
  const [execId, setExecId] = useState(index.executions[0]?.id);
  const [stepIdx, setStepIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(true);
  const [sideOpen, setSideOpen] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");

  const [sideTab, setSideTab] = useState<SideTab>(live ? "live" : initialTab);
  const [activeInsight, setActiveInsight] = useState<string>();
  const pendingStep = useRef<string>();
  const [followAgent, setFollowAgent] = useState(true);
  const [marks, setMarks] = useState<Map<string, ChangeMark>>(new Map());

  // A live graph was replaced: drop state that points at nodes that no longer exist.
  useEffect(() => {
    if (focus !== ROOT && !index.nodes.has(focus)) setFocus(ROOT);
    if (execId && !index.executions.some((x) => x.id === execId)) setExecId(index.executions[0]?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Built-in rules always run on the loaded graph; findings from other tools in the file are kept.
  const insights: Insight[] = useMemo(() => {
    const computed = runInsights(graph);
    const known = new Set(RULES.map((r) => r.id));
    const foreign = (graph.insights ?? []).filter((i) => !known.has(i.rule) && i.nodes.every((n) => index.nodes.has(n)));
    return [...computed, ...foreign];
  }, [graph, index]);
  const insight = mode === "map" ? insights.find((i) => i.id === activeInsight) : undefined;
  // Steps on shared nodes (a database, a topic, a third-party API) are followed from the caller's
  // level, with the shared node pinned next to it instead of opening wherever it lives.
  const exec0 = index.executions.find((x) => x.id === execId);
  const step0 = mode === "trace" ? exec0?.steps[stepIdx] : undefined;
  const sharedStep = !!step0 && ["datastore", "queue", "external_api"].includes(index.nodes.get(step0.node)?.kind ?? "");
  const followNode = useMemo(() => {
    if (!step0) return undefined;
    if (!sharedStep || !step0.parent) return step0.node;
    return exec0?.steps.find((s) => s.id === step0.parent)?.node ?? step0.node;
  }, [step0, sharedStep, exec0]);
  const pinned = useMemo(
    () => (insight ? new Set(insight.nodes) : sharedStep && step0 ? new Set([step0.node]) : undefined),
    [insight, sharedStep, step0],
  );
  const highlight: InsightHighlight | undefined = useMemo(
    () => (insight ? { nodes: new Set(insight.nodes), edges: new Set(insight.edges ?? []), severity: insight.severity } : undefined),
    [insight],
  );
  const flags = useMemo(() => {
    const rank: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };
    const m = new Map<string, { count: number; severity: Severity }>();
    for (const i of insights) {
      const subject = i.nodes[0];
      const cur = m.get(subject);
      m.set(subject, { count: (cur?.count ?? 0) + 1, severity: cur && rank[cur.severity] > rank[i.severity] ? cur.severity : i.severity });
    }
    return m;
  }, [insights]);

  const view = useMemo(() => computeView(index, focus, filters, undefined, pinned), [index, focus, filters, pinned]);
  const exec = index.executions.find((x) => x.id === execId);
  const step = mode === "trace" ? exec?.steps[stepIdx] : undefined;

  const goTo = useCallback((id: string) => {
    setFocus(id);
    setCenterOn(undefined);
  }, []);

  /** Open a node: the panel closes so the new level gets the full canvas. */
  const drill = useCallback(
    (id: string) => {
      if (mode === "map") setSelected(undefined);
      goTo(id);
    },
    [goTo, mode],
  );

  /** Show a node: open its parent level, select it, centre on it. */
  const reveal = useCallback(
    (id: string) => {
      const parent = index.nodes.get(id)?.parent;
      const level = parent && index.nodes.has(parent) ? parent : ROOT;
      setFocus(level);
      setSelected(id);
      setCenterOn(id);
    },
    [index],
  );

  const selectInsight = useCallback(
    (id: string | undefined) => {
      setActiveInsight(id);
      const i = insights.find((x) => x.id === id);
      if (!i) return;
      setMode("map");
      // Open the level that holds the subject; other involved nodes are pinned as context.
      const lca = commonAncestor(index, i.nodes);
      const subjectParent = index.nodes.get(i.nodes[0])?.parent;
      const level = lca !== ROOT || i.nodes.length === 1 ? lca : subjectParent && index.nodes.has(subjectParent) ? subjectParent : ROOT;
      setFocus(level);
      setSelected(i.nodes[0]);
      setCenterOn(undefined);
    },
    [insights, index],
  );

  const replayInsight = useCallback((i: Insight) => {
    if (!i.execution) return;
    setActiveInsight(undefined);
    pendingStep.current = i.steps?.[0];
    setExecId(i.execution);
    setMode("trace");
  }, []);

  // Entering trace mode: open the level that contains the whole run.
  useEffect(() => {
    if (mode !== "trace" || !exec) return;
    const ids = [...new Set(exec.steps.map((s) => s.node))];
    setFocus(commonAncestor(index, ids));
    const pending = pendingStep.current ? exec.steps.findIndex((st) => st.id === pendingStep.current) : -1;
    pendingStep.current = undefined;
    setStepIdx(Math.max(0, pending));
    setPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, execId]);

  // Follow: when the active node is hidden inside a card, drill to its level.
  useEffect(() => {
    if (!step || !followNode) return;
    setSelected(step.node);
    if (!follow) return;
    const rep = view.repOf(followNode);
    if (rep === followNode) return;
    const parent = index.nodes.get(followNode)?.parent;
    const target = parent && index.nodes.has(parent) ? parent : ROOT;
    // Only drill down into the containing card; never jump sideways.
    if (rep === undefined || rep === MORE_ID || ancestors(index, followNode).includes(rep) || rep === focus) setFocus(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id, follow]);

  // Playback.
  useEffect(() => {
    if (!playing || !exec) return;
    if (stepIdx >= exec.steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStepIdx((i) => i + 1), 1100);
    return () => clearTimeout(t);
  }, [playing, stepIdx, exec]);

  const trace: TraceOverlay | undefined = useMemo(() => {
    if (mode !== "trace" || !exec) return undefined;
    const done = exec.steps.slice(0, stepIdx + 1);
    const runs = new Map<string, number>();
    for (const s of exec.steps) runs.set(s.node, (runs.get(s.node) ?? 0) + 1);
    return {
      activeNode: step?.node,
      visited: new Set(done.map((s) => s.node)),
      runs,
      errors: new Set(done.filter((s) => s.status === "error").map((s) => s.node)),
      traversedEdges: new Set(done.map((s) => s.via).filter(Boolean) as string[]),
      currentEdge: step?.via,
    };
  }, [mode, exec, stepIdx, step]);

  // Live: badge what just changed and follow the agent to it.
  useEffect(() => {
    const c = live?.change;
    if (!c) return;
    const now = Date.now();
    setMarks((m) => {
      const next = new Map(m);
      for (const id of c.changed) if (next.get(id)?.kind !== "new") next.set(id, { kind: "edited", at: now });
      for (const id of c.added) next.set(id, { kind: "new", at: now });
      return next;
    });
    if (!followAgent || mode !== "map" || activeInsight) return;
    const ids = [...c.added, ...c.changed].filter((id) => index.nodes.has(id));
    const rank = (id: string) => (FOLLOW_RANK[index.nodes.get(id)!.kind] ?? 2) * 2 + (c.added.includes(id) ? 0 : 1);
    const target = ids.sort((a, b) => rank(a) - rank(b))[0];
    if (!target) return;
    const parent = index.nodes.get(target)?.parent;
    setFocus(parent && index.nodes.has(parent) ? parent : ROOT);
    setCenterOn(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.change?.version]);

  // Expire change badges.
  useEffect(() => {
    if (!marks.size) return;
    const oldest = Math.min(...[...marks.values()].map((m) => m.at));
    const t = setTimeout(
      () => setMarks((m) => new Map([...m].filter(([, v]) => Date.now() - v.at < MARK_MS))),
      Math.max(50, oldest + MARK_MS - Date.now()),
    );
    return () => clearTimeout(t);
  }, [marks]);
  const markKinds = useMemo(() => new Map([...marks].map(([id, m]) => [id, m.kind])), [marks]);

  // Keyboard: Esc closes the panel, Backspace goes up a level, arrows step through a trace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT") return;
      if (e.key === "Escape") {
        setSelected(undefined);
        setActiveInsight(undefined);
      }
      if (e.key === "Backspace" && focus !== ROOT) {
        const p = index.nodes.get(focus)?.parent;
        goTo(p && index.nodes.has(p) ? p : ROOT);
      }
      if (mode === "trace" && exec) {
        if (e.key === "ArrowRight") setStepIdx((i) => Math.min(exec.steps.length - 1, i + 1));
        if (e.key === "ArrowLeft") setStepIdx((i) => Math.max(0, i - 1));
        if (e.key === " ") {
          e.preventDefault();
          setPlaying((p) => !p);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, index, mode, exec, goTo]);

  const selectedReal = selected && index.nodes.has(selected) ? selected : undefined;

  return (
    <div className={`app${sideOpen ? "" : " no-side"}`}>
      <TopBar
        index={index}
        focus={focus}
        mode={mode}
        theme={theme}
        graphName={rootLabel(graph, name)}
        fileName={name}
        demos={demos}
        onFocus={goTo}
        onMode={(m) => {
          setMode(m);
          setPlaying(false);
          if (m === "trace") setTab("overview");
        }}
        onTheme={onTheme}
        onToggleSide={() => setSideOpen((s) => !s)}
        onOpenFile={onOpenFile}
        onDemo={onDemo}
        live={live}
      />
      <Sidebar
        index={index}
        filters={filters}
        onFilters={setFilters}
        onPick={reveal}
        tab={sideTab}
        onTab={setSideTab}
        insights={insights}
        activeInsight={activeInsight}
        onInsight={selectInsight}
        onReplay={replayInsight}
        live={live}
        followAgent={followAgent}
        onFollowAgent={setFollowAgent}
      />
      <main className="canvas-area">
        <Canvas
          view={view}
          selected={selectedReal ? view.repOf(selectedReal) : undefined}
          trace={trace}
          theme={theme}
          centerOn={centerOn}
          highlight={highlight}
          flags={flags}
          marks={live ? markKinds : undefined}
          live={!!live}
          onSelect={(id) => setSelected(id === MORE_ID ? undefined : id)}
          onDrill={drill}
        />
        {insight && (
          <div className="insight-banner">
            <span>{insight.title}</span>
            <button onClick={() => setActiveInsight(undefined)}>Clear</button>
          </div>
        )}
        {showNotice && notice && !insight && (
          <div className="insight-banner">
            <span>{notice}</span>
            <button onClick={() => setShowNotice(false)}>Dismiss</button>
          </div>
        )}
        {view.nodes.length === 0 && <div className="canvas-note">Nothing to show here with the current filters.</div>}
        {view.hidden > 0 && !insight && <div className="canvas-note">{view.hidden} less connected nodes are grouped. Search or drill in to see them.</div>}
        <Legend kinds={new Set(view.edges.map((e) => e.kind))} />
        {mode === "trace" && exec && (
          <TracePlayer
            index={index}
            exec={exec}
            stepIdx={stepIdx}
            playing={playing}
            follow={follow}
            onExec={setExecId}
            onStep={(i) => {
              setStepIdx(i);
              setPlaying(false);
            }}
            onPlay={setPlaying}
            onFollow={setFollow}
          />
        )}
      </main>
      {selectedReal && (
        <SidePanel
          key={selectedReal}
          index={index}
          nodeId={selectedReal}
          execId={mode === "trace" ? execId : undefined}
          activeStep={step}
          onSelect={reveal}
          onDrill={drill}
          onClose={() => setSelected(undefined)}
          tab={tab}
          onTab={setTab}
          llm={llm}
        />
      )}
    </div>
  );
}
