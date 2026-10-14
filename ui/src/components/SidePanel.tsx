import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, FolderOpen, Sparkles, X } from "lucide-react";
import { explainNode } from "../live";
import type { FlowEdge, FlowNode, Port, Step } from "@breadth/schema";
import type { GraphIndex } from "../graph/model";
import { ancestors } from "../graph/model";
import { EDGE_STYLE, KIND_LABEL, LAYER_LABEL, edgeColor, nodeVisual } from "../graph/visual";
import { fetchGithubSource, fetchSource } from "../data";
import { Json } from "./Json";

export type Tab = "overview" | "inputs" | "outputs" | "source";

interface Props {
  index: GraphIndex;
  nodeId: string;
  /** Execution currently replayed in trace mode, and its active step. */
  execId?: string;
  activeStep?: Step;
  onSelect: (id: string) => void;
  onDrill: (id: string) => void;
  onClose: () => void;
  tab: Tab;
  onTab: (t: Tab) => void;
  /** LLM provider configured on the local server (enables "Explain"). */
  llm?: { name: string; remote: boolean };
}

export function SidePanel({ index, nodeId, execId, activeStep, onSelect, onDrill, onClose, tab, onTab: setTab, llm }: Props) {
  const node = index.nodes.get(nodeId);
  if (!node) return null;
  const { Icon, color, label } = nodeVisual(node);
  return (
    <aside className="panel" aria-label="Node details">
      <div className="panel-head">
        <div className="panel-title">
          <span className="kind-icon" style={{ background: `color-mix(in srgb, ${color} 13%, transparent)`, color }}>
            <Icon size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{node.name}</h2>
            <div className="sub">
              {label} · {LAYER_LABEL[node.layer]}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close panel">
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {(["overview", "inputs", "outputs", "source"] as Tab[]).map((t) => (
          <button key={t} className={`tab${tab === t ? " on" : ""}`} onClick={() => setTab(t)} role="tab" aria-selected={tab === t}>
            {t[0].toUpperCase() + t.slice(1)}
            {t === "inputs" && node.inputs?.length ? ` ${node.inputs.length}` : ""}
            {t === "outputs" && node.outputs?.length ? ` ${node.outputs.length}` : ""}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === "overview" && activeStep?.node === node.id && <StepSummary step={activeStep} />}
        {tab === "overview" && llm && <Explain nodeId={node.id} llm={llm} />}
        {tab === "overview" && <Overview index={index} node={node} onSelect={onSelect} onDrill={onDrill} />}
        {tab === "inputs" && <PortsTab index={index} node={node} side="input" execId={execId} activeStep={activeStep} />}
        {tab === "outputs" && <PortsTab index={index} node={node} side="output" execId={execId} activeStep={activeStep} />}
        {tab === "source" && <SourceTab index={index} node={node} />}
      </div>
    </aside>
  );
}

function Explain({ nodeId, llm }: { nodeId: string; llm: { name: string; remote: boolean } }) {
  const [state, setState] = useState<{ busy?: boolean; text?: string; error?: string }>({});
  if (!state.text && !state.error) {
    return (
      <button
        className="btn"
        style={{ marginBottom: 14 }}
        disabled={state.busy}
        title={llm.remote ? `Sends this node's code and neighbours to ${llm.name}` : `Runs on ${llm.name}, locally`}
        onClick={() => {
          setState({ busy: true });
          explainNode(nodeId)
            .then((r) => setState({ text: r.text }))
            .catch((e) => setState({ error: (e as Error).message }));
        }}
      >
        <Sparkles size={14} /> {state.busy ? "Explaining…" : "Explain"}
        <span className="empty-note" style={{ fontSize: 11 }}>
          {llm.name}
          {llm.remote ? " · sends code" : " · local"}
        </span>
      </button>
    );
  }
  return (
    <div className="explain">
      <div className="h3" style={{ marginTop: 0 }}>
        <Sparkles size={13} /> Explanation <span className="empty-note">· {llm.name}</span>
      </div>
      {state.error ? <p className="desc" style={{ color: "var(--err)" }}>{state.error}</p> : <p className="desc" style={{ whiteSpace: "pre-wrap" }}>{state.text}</p>}
    </div>
  );
}

function StepSummary({ step }: { step: Step }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="h3" style={{ marginTop: 0 }}>
        <span className={`dot ${step.status ?? "unset"}`} /> This step
        {step.start !== undefined && step.end !== undefined ? ` · ${(step.end - step.start).toFixed(1)} ms` : ""}
      </div>
      {step.error && <p className="desc" style={{ color: "var(--err)" }}>{step.error}</p>}
      <div className="empty-note" style={{ margin: "6px 0 4px" }}>Input</div>
      {step.input !== undefined ? <Json value={step.input} /> : <p className="empty-note">Not recorded.</p>}
      <div className="empty-note" style={{ margin: "10px 0 4px" }}>Output</div>
      {step.output !== undefined ? <Json value={step.output} /> : <p className="empty-note">Not recorded.</p>}
    </div>
  );
}

function short(v: unknown): string {
  if (typeof v === "string") return v;
  const s = JSON.stringify(v);
  return s && s.length > 120 ? s.slice(0, 119) + "…" : String(s);
}

function Overview({ index, node, onSelect, onDrill }: { index: GraphIndex; node: FlowNode; onSelect: (id: string) => void; onDrill: (id: string) => void }) {
  const chain = ancestors(index, node.id);
  const kids = index.children.get(node.id)?.length ?? 0;
  const edges = index.edgesByNode.get(node.id) ?? [];
  const incoming = edges.filter((e) => e.to.node === node.id && e.from.node !== node.id);
  const outgoing = edges.filter((e) => e.from.node === node.id && e.to.node !== node.id);
  const self = edges.filter((e) => e.from.node === node.id && e.to.node === node.id);
  const runs = index.stepsByNode.get(node.id);
  const stepCount = runs ? [...runs.values()].reduce((s, l) => s + l.length, 0) : 0;
  // internal bookkeeping used by collectors and rules, not useful to read
  const HIDDEN = new Set(["lines", "shape", "size", "sig", "referenced", "nameCalled", "guarded", "diff"]);
  const meta = Object.entries(node.metadata ?? {}).filter(([k, v]) => v !== undefined && !HIDDEN.has(k));

  return (
    <>
      {node.description && <p className="desc">{node.description}</p>}
      {kids > 0 && (
        <button className="btn primary" style={{ marginBottom: 16 }} onClick={() => onDrill(node.id)}>
          <FolderOpen size={14} /> Open ({kids} inside)
        </button>
      )}
      <dl className="kv">
        <dt>Kind</dt>
        <dd>{KIND_LABEL[node.kind]}</dd>
        <dt>Layer</dt>
        <dd>{LAYER_LABEL[node.layer]}</dd>
        {chain.length > 0 && (
          <>
            <dt>Inside</dt>
            <dd>
              {chain.map((id, i) => (
                <span key={id}>
                  {i > 0 && " › "}
                  <a href="#" onClick={(e) => (e.preventDefault(), onSelect(id))} style={{ color: "inherit" }}>
                    {index.nodes.get(id)?.name}
                  </a>
                </span>
              ))}
            </dd>
          </>
        )}
        {stepCount > 0 && (
          <>
            <dt>Observed</dt>
            <dd>
              {stepCount} step{stepCount === 1 ? "" : "s"} in {runs!.size} run{runs!.size === 1 ? "" : "s"}
            </dd>
          </>
        )}
        <dt>Id</dt>
        <dd className="mono" style={{ fontSize: 11.5 }}>
          {node.id}
        </dd>
        {meta.map(([k, v]) => (
          <span key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{short(v)}</dd>
          </span>
        ))}
      </dl>
      {(node.tags?.length || node.aliases?.length) && (
        <div style={{ marginBottom: 12 }}>
          {node.tags?.map((t) => (
            <span className="chip" key={t}>
              {t}
            </span>
          ))}
          {node.aliases?.map((t) => (
            <span className="chip mono" key={t} title="alias">
              {t}
            </span>
          ))}
        </div>
      )}
      <EdgeList title="Incoming" edges={incoming} index={index} dir="in" onSelect={onSelect} />
      <EdgeList title="Outgoing" edges={outgoing} index={index} dir="out" onSelect={onSelect} />
      {self.length > 0 && <div className="h3">Calls itself (recursion)</div>}
    </>
  );
}

function EdgeList({ title, edges, index, dir, onSelect }: { title: string; edges: FlowEdge[]; index: GraphIndex; dir: "in" | "out"; onSelect: (id: string) => void }) {
  const [all, setAll] = useState(false);
  if (!edges.length) return null;
  const shown = all ? edges : edges.slice(0, 12);
  return (
    <>
      <div className="h3">
        {title} · {edges.length}
      </div>
      {shown.map((e) => {
        const other = index.nodes.get(dir === "in" ? e.from.node : e.to.node);
        if (!other) return null;
        const { Icon, color } = nodeVisual(other);
        return (
          <button
            className={`link-row${e.metadata?.diff === "removed" ? " removed" : ""}`}
            key={e.id}
            onClick={() => onSelect(other.id)}
            title={e.metadata?.diff === "removed" ? "Removed by this change" : e.id}
          >
            {dir === "in" ? <ArrowLeft size={13} color={edgeColor(e.kind)} /> : <ArrowRight size={13} color={edgeColor(e.kind)} />}
            <Icon size={14} color={color} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{other.name}</span>
            <span className="meta">
              {e.metadata?.diff === "removed" ? <b className="c-del">removed · </b> : e.metadata?.diff === "added" ? <b className="c-add">new · </b> : null}
              {e.label ?? EDGE_STYLE[e.kind].label}
              {e.count && e.count > 1 ? ` ×${e.count}` : ""}
            </span>
          </button>
        );
      })}
      {edges.length > 12 && !all && (
        <button className="link-row" onClick={() => setAll(true)} style={{ color: "var(--text-3)" }}>
          Show {edges.length - 12} more
        </button>
      )}
    </>
  );
}

function PortTable({ ports }: { ports?: Port[] }) {
  if (!ports?.length) return <p className="empty-note">No declared ports.</p>;
  return (
    <table className="port-table">
      <tbody>
        {ports.map((p) => (
          <tr key={p.name}>
            <td>{p.name}</td>
            <td className="ptype">
              {p.type ?? "any"}
              {p.default !== undefined && <span style={{ color: "var(--text-3)" }}> = {p.default}</span>}
              {p.optional && p.default === undefined && <span style={{ color: "var(--text-3)" }}> (optional)</span>}
              {p.description && <div style={{ fontFamily: "var(--font)", color: "var(--text-3)", marginTop: 2 }}>{p.description}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PortsTab({ index, node, side, execId, activeStep }: { index: GraphIndex; node: FlowNode; side: "input" | "output"; execId?: string; activeStep?: Step }) {
  const runs = index.stepsByNode.get(node.id);
  const execs = useMemo(() => index.executions.filter((x) => runs?.has(x.id)), [index, runs]);
  const [run, setRun] = useState<string | undefined>(execId && runs?.has(execId) ? execId : execs[0]?.id);
  const [stepIdx, setStepIdx] = useState(0);

  // Follow the trace player.
  useEffect(() => {
    if (execId && runs?.has(execId)) setRun(execId);
  }, [execId, runs]);
  useEffect(() => {
    if (activeStep && activeStep.node === node.id && run) {
      const i = runs?.get(run)?.findIndex((s) => s.id === activeStep.id) ?? -1;
      if (i >= 0) setStepIdx(i);
    }
  }, [activeStep, node.id, run, runs]);

  const steps = run ? (runs?.get(run) ?? []) : [];
  const step = steps[Math.min(stepIdx, steps.length - 1)];
  const value = step ? (side === "input" ? step.input : step.output) : undefined;

  // Without executions, fall back to payload samples seen on edges.
  const samples = useMemo(() => {
    if (runs) return [];
    const edges = (index.edgesByNode.get(node.id) ?? []).filter((e) => (side === "input" ? e.to.node === node.id : e.from.node === node.id));
    return edges.flatMap((e) => (e.samples ?? []).map((s) => ({ edge: e, s }))).slice(0, 5);
  }, [index, node.id, runs, side]);

  return (
    <>
      <PortTable ports={side === "input" ? node.inputs : node.outputs} />
      <div className="h3">{side === "input" ? "What went in" : "What came out"}</div>
      {execs.length > 0 ? (
        <>
          <div className="run-picker">
            {execs.map((x) => (
              <button
                key={x.id}
                className={`run-pill${x.id === run ? " on" : ""}`}
                onClick={() => {
                  setRun(x.id);
                  setStepIdx(0);
                }}
                title={x.id}
              >
                <span className={`dot ${x.status ?? "unset"}`} />
                {x.name ?? x.id}
              </button>
            ))}
          </div>
          {steps.length > 1 && (
            <div className="run-picker">
              {steps.map((s, i) => (
                <button key={s.id} className={`run-pill${i === stepIdx ? " on" : ""}`} onClick={() => setStepIdx(i)}>
                  <span className={`dot ${s.status ?? "unset"}`} /> run {i + 1}
                </button>
              ))}
            </div>
          )}
          {step && (
            <div className="empty-note" style={{ marginBottom: 8 }}>
              {step.start !== undefined && step.end !== undefined && `${(step.end - step.start).toFixed(1)} ms`}
              {step.status && ` · ${step.status}`}
              {step.error && ` · ${step.error}`}
            </div>
          )}
          {value !== undefined ? <Json value={value} /> : <p className="empty-note">Nothing recorded for this step.</p>}
        </>
      ) : samples.length ? (
        samples.map(({ edge, s }, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div className="empty-note" style={{ marginBottom: 4 }}>
              sample on {edge.label ?? edge.kind}
            </div>
            <Json value={(s.value as Record<string, unknown>)?.[side] ?? s.value} />
          </div>
        ))
      ) : (
        <p className="empty-note">No runtime data yet. Import traces with <code>breadth import-traces</code> to see real values here.</p>
      )}
    </>
  );
}

function SourceTab({ index, node }: { index: GraphIndex; node: FlowNode }) {
  const src = node.source;
  const [snippet, setSnippet] = useState<{ lines: string[]; start: number; path?: string } | undefined>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setSnippet(undefined);
    if (!src?.file || !src.line) return;
    setLoading(true);
    const end = Math.min(src.endLine ?? src.line + 30, src.line + 80);
    (src.url?.startsWith("https://github.com/") ? fetchGithubSource(src.url, src.line, end) : fetchSource(src.file, src.line, end))
      .then(setSnippet)
      .finally(() => setLoading(false));
  }, [src?.file, src?.line, src?.endLine, src?.url]);

  if (!src) return <p className="empty-note">This node has no source location.</p>;
  const root = index.graph.sources?.find((s) => s.collector === "code")?.target;
  const abs = snippet?.path ?? (root && src.file ? `${root}/${src.file}` : undefined);
  return (
    <>
      <dl className="kv">
        {src.file && (
          <>
            <dt>File</dt>
            <dd className="mono" style={{ fontSize: 12 }}>
              {src.file}
            </dd>
          </>
        )}
        {src.line && (
          <>
            <dt>Line</dt>
            <dd>
              {src.line}
              {src.endLine && src.endLine !== src.line ? `–${src.endLine}` : ""}
            </dd>
          </>
        )}
        {src.resource_ref && (
          <>
            <dt>Resource</dt>
            <dd className="mono" style={{ fontSize: 12 }}>
              {src.resource_ref}
            </dd>
          </>
        )}
      </dl>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {abs && src.line && !src.url && (
          <a className="btn" href={`vscode://file/${abs}:${src.line}`}>
            <ExternalLink size={13} /> Open in VS Code
          </a>
        )}
        {src.url && (
          <a className="btn" href={src.url} target="_blank" rel="noreferrer">
            <ExternalLink size={13} /> {src.url.startsWith("https://github.com/") ? "Open on GitHub" : "Open link"}
          </a>
        )}
      </div>
      {loading && <p className="empty-note">Loading source…</p>}
      {snippet && (
        <pre className="code">
          {snippet.lines.map((l, i) => {
            const n = snippet.start + i;
            const hl = n >= (src.line ?? 0) && n <= (src.endLine ?? src.line ?? 0) && n === src.line;
            return (
              <div key={i} className={`row${hl ? " hl" : ""}`}>
                <span className="ln">{n}</span>
                {l}
              </div>
            );
          })}
        </pre>
      )}
      {!snippet && !loading && src.file && <p className="empty-note">Source preview is available when running <code>breadth serve</code> locally.</p>}
    </>
  );
}
