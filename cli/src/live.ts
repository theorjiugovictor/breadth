import { watch, writeFileSync, readFileSync, existsSync, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import ignore from "ignore";
import { diffGraphs, isEmptyDiff, mergeGraphs, type FlowGraph, type GraphDiff } from "@noodles/schema";
import { DEFAULT_EXCLUDES, importOtlp, linkTracesToCode, runCollectors, type CollectorOptions } from "@noodles/collectors";
import { runInsights } from "@noodles/insights";
import { noneProvider, type LLMProvider } from "./llm/provider.js";

type NodeRef = { id: string; name: string; kind: string; file?: string };
type InsightRef = { id: string; title: string; severity: string; nodes: string[] };

/** One entry in the live activity feed. */
export interface ActivityEntry {
  id: number;
  at: number;
  kind: "change" | "task" | "error";
  /** The coding agent the change is attributed to (from hooks), when known. */
  agent?: string;
  /** For task entries: what the user asked the agent. */
  prompt?: string;
  files?: string[];
  version?: number;
  added?: NodeRef[];
  changed?: NodeRef[];
  removed?: NodeRef[];
  edgesAdded?: number;
  edgesRemoved?: number;
  insightsAdded?: InsightRef[];
  insightsResolved?: InsightRef[];
  /** One-sentence LLM narration of the change (optional). */
  narration?: string;
  message?: string;
}

/** What coding-agent hooks send (Claude Code hook JSON is normalised into this by `noodles hook`). */
export interface AgentActivity {
  agent?: string;
  event?: string;
  tool?: string;
  files?: string[];
  prompt?: string;
  session?: string;
}

export interface LiveOptions {
  target: string;
  collectors?: string[];
  collectorOptions: CollectorOptions;
  /** OTLP files to merge on every rescan. */
  traces?: string[];
  /** Also write the graph here after each scan. */
  out?: string;
  llm?: LLMProvider;
  log?: (msg: string) => void;
}

const MAX_ACTIVITY = 300;
const MAX_REFS = 40;

/**
 * Keeps a graph of a working tree up to date while files change (for example while a coding
 * agent edits them), and pushes every change to connected browsers over Server-Sent Events.
 */
export class LiveSession {
  graph!: FlowGraph;
  version = 0;
  readonly activity: ActivityEntry[] = [];
  readonly target: string;
  private clients = new Set<ServerResponse>();
  private watcher?: FSWatcher;
  private timer?: NodeJS.Timeout;
  private ping?: NodeJS.Timeout;
  private scanning = false;
  private pending = false;
  private changedFiles = new Set<string>();
  private lastAgent?: { name: string; at: number; files: Set<string> };
  private nextId = 1;
  private ig = ignore();
  private llm: LLMProvider;

  constructor(private opts: LiveOptions) {
    this.target = path.resolve(opts.target);
    this.llm = opts.llm ?? noneProvider;
    this.ig.add(DEFAULT_EXCLUDES).add(opts.collectorOptions.exclude ?? []);
    const gi = path.join(this.target, ".gitignore");
    if (existsSync(gi)) this.ig.add(readFileSync(gi, "utf8"));
  }

  async start(): Promise<void> {
    this.graph = await this.build();
    this.version = 1;
    this.write();
    // Recursive fs.watch works on macOS, Windows and Linux (Node 20+).
    this.watcher = watch(this.target, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join("/");
      if (this.ignored(rel)) return;
      this.changedFiles.add(rel);
      this.schedule();
    });
    // Keep proxies and idle connections from dropping the event stream.
    this.ping = setInterval(() => this.send(": ping\n\n"), 25_000);
    this.ping.unref();
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.ping);
    this.watcher?.close();
    for (const c of this.clients) c.end();
  }

  private ignored(rel: string): boolean {
    if (!rel || rel.startsWith(".git/") || rel === ".git") return true;
    if (this.opts.out && path.resolve(this.target, rel) === path.resolve(this.opts.out)) return true;
    try {
      return this.ig.ignores(rel);
    } catch {
      return true; // paths `ignore` refuses (absolute, ..) are outside the tree
    }
  }

  private schedule(delay = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.rescan(), delay);
  }

  private async build(): Promise<FlowGraph> {
    let graph = await runCollectors(this.target, this.opts.collectors, this.opts.collectorOptions);
    for (const t of this.opts.traces ?? []) {
      const traces = importOtlp([{ name: t, text: readFileSync(t, "utf8") }]);
      graph = mergeGraphs(graph, linkTracesToCode(traces, graph));
    }
    graph.insights = runInsights(graph);
    return graph;
  }

  private write() {
    if (this.opts.out) writeFileSync(this.opts.out, JSON.stringify(this.graph) + "\n");
  }

  /** Rescan after a burst of file changes; concurrent requests collapse into one follow-up scan. */
  async rescan(): Promise<void> {
    if (this.scanning) {
      this.pending = true;
      return;
    }
    this.scanning = true;
    const files = [...this.changedFiles];
    this.changedFiles.clear();
    try {
      const prev = this.graph;
      const next = await this.build();
      const diff = diffGraphs(prev, next);
      this.graph = next;
      this.version++;
      this.write();
      if (isEmptyDiff(diff)) {
        // Only positions moved (line numbers): refresh quietly.
        this.send(event("graph", { version: this.version, quiet: true }));
      } else {
        const entry = this.entryFor(diff, files, prev);
        this.push(entry);
        this.send(event("graph", { version: this.version, added: diff.added, changed: diff.changed, removed: diff.removed }));
        if (this.llm !== noneProvider) void this.narrate(entry);
      }
    } catch (err) {
      // Half-written files are normal mid-edit; report and wait for the next change.
      this.push({ id: this.nextId++, at: Date.now(), kind: "error", files, message: (err as Error).message });
    } finally {
      this.scanning = false;
      if (this.pending) {
        this.pending = false;
        this.schedule(50);
      }
    }
  }

  private entryFor(diff: GraphDiff, files: string[], prev: FlowGraph): ActivityEntry {
    const ref = (g: FlowGraph) => (id: string): NodeRef => {
      const n = g.nodes.find((x) => x.id === id);
      return { id, name: n?.name ?? id, kind: n?.kind ?? "?", file: n?.source?.file };
    };
    const before = ref(prev);
    // Interesting first: functions/classes before files, files before directories.
    const rank = (r: NodeRef) => (r.kind === "function" ? 0 : r.kind === "network_endpoint" || r.kind === "datastore" ? 1 : 2);
    const refs = (ids: string[], g: (id: string) => NodeRef) => ids.map(g).sort((a, b) => rank(a) - rank(b)).slice(0, MAX_REFS);
    const agent = this.lastAgent && Date.now() - this.lastAgent.at < 60_000 ? this.lastAgent.name : undefined;
    const iref = (i: { id: string; title: string; severity: string; nodes: string[] }): InsightRef => ({ id: i.id, title: i.title, severity: i.severity, nodes: i.nodes.slice(0, 4) });
    const entry: ActivityEntry = {
      id: this.nextId++,
      at: Date.now(),
      kind: "change",
      agent,
      files: files.slice(0, 20),
      version: this.version,
      added: refs(diff.added, ref(this.graph)),
      changed: refs(diff.changed, ref(this.graph)),
      removed: refs(diff.removed, before),
      edgesAdded: diff.edgesAdded.length,
      edgesRemoved: diff.edgesRemoved.length,
      insightsAdded: diff.insightsAdded.map(iref),
      insightsResolved: diff.insightsResolved.map(iref),
    };
    return entry;
  }

  private push(entry: ActivityEntry) {
    this.activity.push(entry);
    if (this.activity.length > MAX_ACTIVITY) this.activity.splice(0, this.activity.length - MAX_ACTIVITY);
    this.send(event("activity", entry));
    if (entry.kind === "change") {
      const parts = [
        entry.added?.length ? `+${entry.added.length}` : "",
        entry.changed?.length ? `~${entry.changed.length}` : "",
        entry.removed?.length ? `-${entry.removed.length}` : "",
        entry.insightsAdded?.length ? `${entry.insightsAdded.length} new insight(s)` : "",
      ].filter(Boolean);
      this.opts.log?.(`${entry.agent ? `${entry.agent}: ` : ""}${parts.join(" ")} ${entry.files?.slice(0, 3).join(", ") ?? ""}`);
    } else if (entry.kind === "error") this.opts.log?.(`scan failed: ${entry.message}`);
  }

  /** Hook events from coding agents: attribute upcoming changes, show tasks, rescan promptly. */
  agentActivity(a: AgentActivity) {
    const name = (a.agent ?? "agent").slice(0, 40);
    if (a.prompt) {
      this.push({ id: this.nextId++, at: Date.now(), kind: "task", agent: name, prompt: a.prompt.slice(0, 500) });
    }
    const files = (a.files ?? []).map((f) => path.relative(this.target, path.resolve(this.target, f)).split(path.sep).join("/")).filter((f) => f && !f.startsWith(".."));
    this.lastAgent = { name, at: Date.now(), files: new Set(files) };
    this.send(event("agent", { agent: name, tool: a.tool, event: a.event, files, at: Date.now() }));
    if (files.length) {
      for (const f of files) if (!this.ignored(f)) this.changedFiles.add(f);
      this.schedule(150);
    }
  }

  private async narrate(entry: ActivityEntry) {
    const list = (label: string, refs?: NodeRef[]) => (refs?.length ? `${label}: ${refs.slice(0, 12).map((r) => `${r.name} (${r.kind}${r.file ? `, ${r.file}` : ""})`).join("; ")}` : "");
    const prompt = [
      `Files touched: ${entry.files?.join(", ") || "unknown"}`,
      list("Added", entry.added),
      list("Changed", entry.changed),
      list("Removed", entry.removed),
      entry.insightsAdded?.length ? `New findings: ${entry.insightsAdded.map((i) => i.title).join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      const text = await this.llm.complete({
        system:
          "You narrate, for a developer, what a coding agent just changed in their codebase, based on a structural diff. One sentence, at most 25 words, present tense, concrete names. If new findings appeared, mention the most important one.",
        prompt,
        maxTokens: 120,
      });
      if (!text) return;
      entry.narration = text.split("\n")[0];
      this.send(event("activity", entry));
    } catch (err) {
      this.opts.log?.(`llm narration failed: ${(err as Error).message}`);
    }
  }

  subscribe(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    res.write(event("hello", { version: this.version, target: this.target }));
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  private send(chunk: string) {
    for (const c of this.clients) c.write(chunk);
  }
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
