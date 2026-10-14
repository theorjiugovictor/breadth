import path from "node:path";
import { createInterface } from "node:readline";
import type { FlowEdge, FlowGraph, FlowNode, Insight } from "@noodles/schema";
import { runCollectors, type CollectorOptions } from "@noodles/collectors";
import { runInsights } from "@noodles/insights";
import { AGENTS } from "./hook.js";

/**
 * `noodles mcp`: a Model Context Protocol server (stdio) for any coding agent.
 *
 * Agents get the graph as tools (find, callers and callees, impact of a change, insights),
 * and can report what they are working on to the live canvas. MCP only hears from an agent
 * when it calls a tool, so edits are still captured by hooks and file watching; this adds
 * what those cannot: the agent's own view of its task, and the graph as context for it.
 */

export interface McpOptions {
  root: string;
  port: string;
  version: string;
  collectorOptions?: CollectorOptions;
  /** Defaults to the process's stdin/stdout. */
  input?: NodeJS.ReadableStream;
  output?: { write(chunk: string): unknown };
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: Ctx) => Promise<string>;
}

interface Ctx {
  graph: () => Promise<{ graph: FlowGraph; live: boolean }>;
  report: (summary: string, files: string[]) => Promise<boolean>;
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

function where(n: FlowNode): string {
  return n.source?.file ? ` ${n.source.file}${n.source.line ? `:${n.source.line}` : ""}` : "";
}
function line(n: FlowNode): string {
  return `- ${n.name} (${n.metadata?.subkind ?? n.kind})${where(n)}  [${n.id}]`;
}

function findNodes(g: FlowGraph, q: string, limit = 20): FlowNode[] {
  const query = q.trim().toLowerCase();
  const scored: [number, FlowNode][] = [];
  for (const n of g.nodes) {
    const name = n.name.toLowerCase();
    let s: number | undefined;
    if (n.id === q) s = -1;
    else if (name === query) s = 0;
    else if (name.startsWith(query)) s = 1;
    else if (name.includes(query)) s = 2;
    else if (n.source?.file?.toLowerCase().includes(query) || n.id.toLowerCase().includes(query)) s = 3;
    if (s !== undefined) scored.push([s * 1000 + Math.min(999, name.length), n]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, n]) => n);
}

function resolveNode(g: FlowGraph, ref: string): FlowNode | undefined {
  return g.nodes.find((n) => n.id === ref || n.aliases?.includes(ref)) ?? findNodes(g, ref, 1)[0];
}

/** Edges between nodes, with calls into a node's children counted as calls into the node. */
function edgeIndex(g: FlowGraph) {
  const incoming = new Map<string, FlowEdge[]>();
  const outgoing = new Map<string, FlowEdge[]>();
  for (const e of g.edges) {
    if (e.from.node === e.to.node) continue;
    (incoming.get(e.to.node) ?? incoming.set(e.to.node, []).get(e.to.node)!).push(e);
    (outgoing.get(e.from.node) ?? outgoing.set(e.from.node, []).get(e.from.node)!).push(e);
  }
  return { incoming, outgoing };
}

function insightLine(i: Insight, byId: Map<string, FlowNode>): string {
  const subject = byId.get(i.nodes[0]);
  return `- [${i.severity}] ${i.title}${subject ? ` — ${subject.name}${where(subject)}` : ""}${i.detail ? `\n  ${i.detail.split("\n")[0]}` : ""}`;
}

const TOOLS: Tool[] = [
  {
    name: "noodles_report_task",
    description:
      "Tell the developer what you are about to work on. Call this once at the start of every task with a one-line summary, and again when the plan changes. It shows up on the live noodles canvas next to the code you change. Cheap and safe: it never fails the task.",
    inputSchema: schema(
      {
        summary: { type: "string", description: "One line: what you are doing and why, e.g. 'Add a cancel endpoint that refunds the order'." },
        files: { type: "array", items: { type: "string" }, description: "Files you expect to touch (optional)." },
      },
      ["summary"],
    ),
    async run(args, ctx) {
      const ok = await ctx.report(String(args.summary ?? "").slice(0, 500), (args.files as string[] | undefined) ?? []);
      return ok ? "Shown on the live canvas." : "Noted (noodles watch is not running, so nothing is shown live).";
    },
  },
  {
    name: "noodles_overview",
    description: "Summary of the codebase graph: top-level systems, services and folders, node counts, and the most important insights. Use it to orient yourself in an unfamiliar repository.",
    inputSchema: schema({}),
    async run(_args, ctx) {
      const { graph: g } = await ctx.graph();
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      const kinds = new Map<string, number>();
      for (const n of g.nodes) kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
      const roots = g.nodes.filter((n) => !n.parent || !byId.has(n.parent));
      const kids = new Map<string, number>();
      for (const n of g.nodes) if (n.parent) kids.set(n.parent, (kids.get(n.parent) ?? 0) + 1);
      const sev = { critical: 0, warning: 1, info: 2 } as const;
      const insights = [...(g.insights ?? [])].sort((a, b) => sev[a.severity] - sev[b.severity]);
      return [
        `${g.nodes.length} nodes, ${g.edges.length} edges, ${g.executions?.length ?? 0} recorded runs.`,
        `By kind: ${[...kinds].map(([k, c]) => `${k} ${c}`).join(", ")}.`,
        "",
        "Top level:",
        ...roots.slice(0, 40).map((n) => `${line(n)}${kids.get(n.id) ? ` (${kids.get(n.id)} inside)` : ""}`),
        "",
        `Insights: ${insights.length}`,
        ...insights.slice(0, 10).map((i) => insightLine(i, byId)),
      ].join("\n");
    },
  },
  {
    name: "noodles_find",
    description: "Find functions, classes, files, endpoints, datastores or services by name or path. Returns ids to use with the other noodles tools.",
    inputSchema: schema({ query: { type: "string" }, limit: { type: "number", description: "Default 20." } }, ["query"]),
    async run(args, ctx) {
      const { graph } = await ctx.graph();
      const hits = findNodes(graph, String(args.query ?? ""), Number(args.limit ?? 20));
      return hits.length ? hits.map(line).join("\n") : "No matches.";
    },
  },
  {
    name: "noodles_node",
    description: "Everything noodles knows about one node: where it lives, inputs and outputs, what calls it, what it calls, data it reads or writes, and insights about it. Accepts an id or a name.",
    inputSchema: schema({ node: { type: "string", description: "Node id or name." } }, ["node"]),
    async run(args, ctx) {
      const { graph: g } = await ctx.graph();
      const n = resolveNode(g, String(args.node ?? ""));
      if (!n) return "Unknown node. Use noodles_find first.";
      const byId = new Map(g.nodes.map((x) => [x.id, x]));
      const { incoming, outgoing } = edgeIndex(g);
      const chain: string[] = [];
      for (let p = n.parent; p && byId.has(p) && chain.length < 10; p = byId.get(p)!.parent) chain.unshift(byId.get(p)!.name);
      const rel = (edges: FlowEdge[] | undefined, side: "from" | "to") =>
        (edges ?? []).slice(0, 40).map((e) => {
          const other = byId.get(e[side].node);
          return `- ${e.kind}${e.label ? ` ${e.label}` : ""} ${side === "from" ? "from" : "to"} ${other ? `${other.name}${where(other)}  [${other.id}]` : e[side].node}`;
        });
      const ports = (p?: { name: string; type?: string }[]) => (p?.length ? p.map((x) => `${x.name}${x.type ? `: ${x.type}` : ""}`).join(", ") : "none");
      const children = g.nodes.filter((x) => x.parent === n.id);
      const insights = (g.insights ?? []).filter((i) => i.nodes.includes(n.id));
      return [
        line(n).slice(2),
        chain.length ? `Inside: ${chain.join(" › ")}` : "",
        n.description ? `Description: ${n.description}` : "",
        `Inputs: ${ports(n.inputs)}`,
        `Outputs: ${ports(n.outputs)}`,
        children.length ? `Contains ${children.length}: ${children.slice(0, 30).map((c) => c.name).join(", ")}` : "",
        "",
        `Incoming (${incoming.get(n.id)?.length ?? 0}):`,
        ...rel(incoming.get(n.id), "from"),
        `Outgoing (${outgoing.get(n.id)?.length ?? 0}):`,
        ...rel(outgoing.get(n.id), "to"),
        insights.length ? `\nInsights:\n${insights.map((i) => insightLine(i, byId)).join("\n")}` : "",
      ]
        .filter((x) => x !== "")
        .join("\n");
    },
  },
  {
    name: "noodles_impact",
    description:
      "What could break if this node changes: everything that calls it or reads its data, directly or through other nodes (up to `depth` hops), plus the endpoints and services those belong to. Use before changing a function's signature or behaviour.",
    inputSchema: schema({ node: { type: "string" }, depth: { type: "number", description: "Hops to follow, default 3, max 6." } }, ["node"]),
    async run(args, ctx) {
      const { graph: g } = await ctx.graph();
      const n = resolveNode(g, String(args.node ?? ""));
      if (!n) return "Unknown node. Use noodles_find first.";
      const byId = new Map(g.nodes.map((x) => [x.id, x]));
      const { incoming } = edgeIndex(g);
      const depth = Math.min(6, Math.max(1, Number(args.depth ?? 3)));
      const seen = new Map<string, number>([[n.id, 0]]);
      let frontier = [n.id];
      for (let d = 1; d <= depth && frontier.length; d++) {
        const next: string[] = [];
        for (const id of frontier)
          for (const e of incoming.get(id) ?? [])
            if (["call", "data", "read", "event", "network"].includes(e.kind) && !seen.has(e.from.node)) {
              seen.set(e.from.node, d);
              next.push(e.from.node);
            }
        frontier = next;
      }
      seen.delete(n.id);
      if (!seen.size) return `Nothing in the graph depends on ${n.name}. (Dynamic calls and code outside the scanned folder are not visible.)`;
      const rows = [...seen].sort((a, b) => a[1] - b[1]).slice(0, 80);
      const entry = rows.filter(([id]) => byId.get(id)?.kind === "network_endpoint" || byId.get(id)?.kind === "service");
      return [
        `${seen.size} node(s) depend on ${n.name}:`,
        ...rows.map(([id, d]) => (byId.get(id) ? `${"  ".repeat(d - 1)}${line(byId.get(id)!)}` : `- ${id}`)),
        entry.length ? `\nReachable from: ${entry.map(([id]) => byId.get(id)!.name).join(", ")}` : "",
      ].join("\n");
    },
  },
  {
    name: "noodles_insights",
    description: "Problems found in the graph (N+1 queries, repeated work, dead code, duplicate logic, unhandled errors, data sent to third parties, ...), optionally only for a file or folder.",
    inputSchema: schema({
      path: { type: "string", description: "Only insights about nodes in this file or folder." },
      severity: { type: "string", enum: ["critical", "warning", "info"], description: "Minimum severity." },
    }),
    async run(args, ctx) {
      const { graph: g } = await ctx.graph();
      const byId = new Map(g.nodes.map((x) => [x.id, x]));
      const rank = { critical: 3, warning: 2, info: 1 } as const;
      const min = rank[(args.severity as keyof typeof rank) ?? "info"] ?? 1;
      const p = args.path ? String(args.path).replace(/^\.\//, "") : undefined;
      const list = (g.insights ?? []).filter(
        (i) => rank[i.severity] >= min && (!p || i.nodes.some((id) => byId.get(id)?.source?.file?.startsWith(p))),
      );
      return list.length ? list.slice(0, 60).map((i) => insightLine(i, byId)).join("\n") : "No insights.";
    },
  },
];

/** Friendly agent name from the MCP client's self-description. */
export function clientAgent(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("claude")) return AGENTS.claude;
  if (n.includes("cursor")) return AGENTS.cursor;
  if (n.includes("windsurf") || n.includes("cascade")) return AGENTS.windsurf;
  if (n.includes("antigravity")) return AGENTS.antigravity;
  if (n.includes("gemini")) return AGENTS.gemini;
  if (n.includes("codex")) return AGENTS.codex;
  if (n.includes("visual studio code") || n.includes("vscode") || n.includes("copilot")) return AGENTS.copilot;
  return name || "agent";
}

export async function runMcp(opts: McpOptions): Promise<void> {
  const base = `http://127.0.0.1:${opts.port}`;
  let agent = "agent";
  let local: { graph: FlowGraph; at: number } | undefined;

  const ctx: Ctx = {
    async graph() {
      // Prefer the live session (always current); otherwise scan here, cached for a few seconds.
      try {
        const res = await fetch(`${base}/flowgraph.json`, { signal: AbortSignal.timeout(800) });
        if (res.ok) return { graph: (await res.json()) as FlowGraph, live: true };
      } catch {
        /* no noodles watch */
      }
      if (!local || Date.now() - local.at > 5000) {
        const graph = await runCollectors(opts.root, undefined, { ...opts.collectorOptions, log: undefined });
        graph.insights = runInsights(graph);
        local = { graph, at: Date.now() };
      }
      return { graph: local.graph, live: false };
    },
    async report(summary, files) {
      try {
        const res = await fetch(`${base}/api/activity`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-noodles": "1" },
          body: JSON.stringify({ agent, event: "mcp", prompt: summary, files: files.map((f) => path.resolve(opts.root, f)) }),
          signal: AbortSignal.timeout(1500),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };

  const out = opts.output ?? process.stdout;
  const send = (msg: unknown) => out.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: opts.input ?? process.stdin });
  const pending = new Set<Promise<unknown>>();

  rl.on("line", (text) => {
    if (!text.trim()) return;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(text);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const reply = (result: unknown) => msg.id !== undefined && send({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => msg.id !== undefined && send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize": {
        agent = clientAgent((msg.params?.clientInfo as { name?: string } | undefined)?.name);
        return void reply({
          protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "noodles", version: opts.version },
          instructions:
            "noodles maps this codebase as a graph. At the start of each task call noodles_report_task with a one-line summary so the developer can follow your work on the live canvas. Use noodles_impact before changing a function others depend on, and noodles_node / noodles_find to see callers and callees without reading every file.",
        });
      }
      case "ping":
        return void reply({});
      case "tools/list":
        return void reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === msg.params?.name);
        if (!tool) return void fail(-32602, `unknown tool ${String(msg.params?.name)}`);
        const p = tool
          .run((msg.params?.arguments as Record<string, unknown>) ?? {}, ctx)
          .then((text) => reply({ content: [{ type: "text", text }] }))
          .catch((err: Error) => reply({ content: [{ type: "text", text: `noodles: ${err.message}` }], isError: true }))
          .finally(() => pending.delete(p));
        pending.add(p);
        return;
      }
      default:
        // Notifications (no id) need no answer; unknown requests get "method not found".
        if (msg.id !== undefined) fail(-32601, `method not found: ${msg.method}`);
    }
  });
  await new Promise<void>((resolve) => rl.on("close", resolve));
  await Promise.all(pending);
}
