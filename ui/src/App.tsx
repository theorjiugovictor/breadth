import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { EDGE_KINDS, LAYERS, type FlowGraph } from "@noodles/schema";
import { ancestors, buildIndex, commonAncestor, defaultFocus, ROOT } from "./graph/model";
import { computeView, MORE_ID, type Filters } from "./graph/view";
import { Canvas, type TraceOverlay } from "./components/Canvas";
import { Sidebar } from "./components/Sidebar";
import { TopBar, Logo } from "./components/TopBar";
import { SidePanel, type Tab } from "./components/SidePanel";
import { TracePlayer } from "./components/TracePlayer";
import { Legend } from "./components/Legend";
import { loadDemo, loadInitial, parseGraph, type DemoEntry, type Loaded } from "./data";

type Theme = "light" | "dark";

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("noodles-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    loadInitial()
      .then(({ loaded, demos }) => {
        setDemos(demos);
        if (loaded) setLoaded(loaded);
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

  if (booting) return <div className="center-screen empty-note">Loading…</div>;

  if (!loaded) {
    return (
      <div className="center-screen">
        {hidden}
        {dragging && <div className="drop-overlay" />}
        <div className="drop">
          <Logo />
          <h1>Open a flowgraph</h1>
          <p>
            Run <code>noodles scan .</code> then <code>noodles serve</code>, or drop a <code>flowgraph.json</code> here.
          </p>
          {error && <p style={{ color: "var(--err)", whiteSpace: "pre-wrap" }}>{error}</p>}
          <button className="btn primary" onClick={() => fileInput.current?.click()}>
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
          key={loaded.name + loaded.graph.generatedAt}
          graph={loaded.graph}
          name={loaded.name}
          demos={demos}
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
  demos: DemoEntry[];
  theme: Theme;
  onTheme: () => void;
  onOpenFile: () => void;
  onDemo: (d: DemoEntry) => void;
}

function Workspace({ graph, name, demos, theme, onTheme, onOpenFile, onDemo }: WorkspaceProps) {
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

  const view = useMemo(() => computeView(index, focus, filters), [index, focus, filters]);
  const exec = index.executions.find((x) => x.id === execId);
  const step = mode === "trace" ? exec?.steps[stepIdx] : undefined;

  const goTo = useCallback(
    (id: string) => {
      setFocus(id);
      setCenterOn(undefined);
    },
    [],
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

  // Entering trace mode: open the level that contains the whole run.
  useEffect(() => {
    if (mode !== "trace" || !exec) return;
    const ids = [...new Set(exec.steps.map((s) => s.node))];
    setFocus(commonAncestor(index, ids));
    setStepIdx(0);
    setPlaying(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, execId]);

  // Follow: when the active node is hidden inside a card, drill to its level.
  useEffect(() => {
    if (!step) return;
    setSelected(step.node);
    if (!follow) return;
    const rep = view.repOf(step.node);
    if (rep === step.node) return;
    const parent = index.nodes.get(step.node)?.parent;
    const target = parent && index.nodes.has(parent) ? parent : ROOT;
    // Only drill down into the containing card; never jump sideways.
    if (rep === undefined || rep === MORE_ID || ancestors(index, step.node).includes(rep) || rep === focus) setFocus(target);
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

  // Keyboard: Esc closes the panel, Backspace goes up a level, arrows step through a trace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "SELECT") return;
      if (e.key === "Escape") setSelected(undefined);
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
      />
      <Sidebar index={index} filters={filters} onFilters={setFilters} onPick={reveal} />
      <main className="canvas-area">
        <Canvas
          view={view}
          selected={selectedReal ? view.repOf(selectedReal) : undefined}
          trace={trace}
          theme={theme}
          centerOn={centerOn}
          onSelect={(id) => setSelected(id === MORE_ID ? undefined : id)}
          onDrill={goTo}
        />
        {view.nodes.length === 0 && <div className="canvas-note">Nothing to show here with the current filters.</div>}
        {view.hidden > 0 && <div className="canvas-note">{view.hidden} less connected nodes are grouped. Search or drill in to see them.</div>}
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
          onDrill={goTo}
          onClose={() => setSelected(undefined)}
          tab={tab}
          onTab={setTab}
        />
      )}
    </div>
  );
}
