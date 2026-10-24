import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertValidGraph, mergeGraphs, validateGraph, type FlowGraph } from "@breadth/schema";
import { collectors, importOtlp, linkTracesToCode, runCollectors, spansToGraph, type Logger } from "@breadth/collectors";
import { SpanBuffer, startOtlpServer } from "./otlp.js";
import { createSource, parseDuration, pullLive, type LiveSource } from "./sources/index.js";
import { parseTime, recordEvidence } from "./evidence.js";
import { RULES, checkSpec, runInsights, describeChanges, diffGraph, withoutRemoved, type ChangeReport } from "@breadth/insights";
import type { Insight, Severity } from "@breadth/schema";
import { loadConfig } from "./config.js";
import { createProvider, noneProvider, PRESETS, privacyNotice, resolveSettings, summarizeGraph, type LLMProvider } from "./llm/provider.js";
import { LiveSession } from "./live.js";
import { LOCAL_HEADER, serve } from "./serve.js";
import { hookPayload, hookReply } from "./hook.js";
import { integrations, renderConfig, writeConfig } from "./connect.js";
import { runMcp } from "./mcp.js";
import { applyPlans, diffRefs, loadGraph, parsePlanArgs, renderMarkdown, renderText, repoRoot, scan as scanForDiff, shortRef } from "./diff.js";
import { behaviourUnits, computeDebt, LEDGER_FILE, loadLedger, markReviewed, saveLedger, unitsInDiff, type Unit } from "./ledger.js";
import { checkIntent } from "./intent.js";
import { loadWorkspace, scanWorkspace, stageOne } from "./workspace.js";

declare const __BREADTH_VERSION__: string | undefined;
/** Set from cli/package.json when bundled; "dev" when run from source. */
const VERSION = typeof __BREADTH_VERSION__ === "string" ? __BREADTH_VERSION__ : "dev";

const HELP = `breadth ${VERSION}: turn any codebase or system into an n8n-style canvas

Usage:
  breadth scan <path> [--collector code,infra] [-o flowgraph.json] [--config file] [--exclude glob]... [--plan [dir=]plan.json]
  breadth diff [path] [--base ref] [--head ref] [-o diff.json] [--markdown pr.md] [--fail-on high] [--plan [dir=]plan.json] [--intent "what was asked"] [--live datadog --since 1h]   what a change does, in behaviour
  breadth diff before.json after.json
  breadth review [path] --changed | --from diff.json | --nodes ids | --all [--by name]   record what you reviewed (.breadth/ledger.json)
  breadth debt [path] [--record] [--json] [--fail-above 30]   comprehension debt: behaviour nobody has reviewed, per service
  breadth import-traces <otlp.json>... [--merge flowgraph.json] [-o out.json]
  breadth pull <datadog|prometheus|tempo|jaeger>[,...] [path] [--merge flowgraph.json] [--since 1h]   traces and live traffic from your observability backend
  breadth evidence "<scenario>" [path] --service x --from 15m [--live datadog | --results p95_ms=180] [--run-id chaos-42]   judge an experiment window, record the run
  breadth receive [--port 4318] [--merge flowgraph.json]   OTLP/HTTP receiver: traces from running services, merged as they arrive
  breadth serve [flowgraph.json] [--port 4321] [--host 127.0.0.1] [--no-open]
  breadth watch [path] [--port 4321] [--traces otlp.json] [--otlp-port 4318] [--live datadog --every 60s] [-o flowgraph.json] [--llm]   live canvas while you (or an agent) code; also takes OTLP on /v1/traces
  breadth connect <agent>... [--write]   hooks + MCP for claude, copilot, cursor, gemini, windsurf, antigravity, codex
  breadth hook [--port 4321] [--agent name]   (run by agent hooks) forward an agent's prompt and edits to \`breadth watch\`
  breadth mcp [path] [--port 4321]   MCP server (stdio): the graph as tools for any coding agent
  breadth editor install             editor extension: show unsaved edits live (VS Code, Cursor, Windsurf, Antigravity)
  breadth llm [check]                list LLM providers / test the configured one
  breadth insights <flowgraph.json> [--json] [--write] [--fail-on warning|critical] [--rules a,b]
  breadth validate <flowgraph.json>
  breadth collectors

Options:
  -o, --out         output file (scan: flowgraph.json; import-traces: the --merge file)
  -c, --collector   comma-separated collectors (default: auto-detect)
      --config      config file (default: <path>/breadth.config.json if present)
      --exclude     extra ignore pattern, gitignore syntax (repeatable)
      --no-external hide third-party packages
      --llm         use the configured LLM: node summaries (scan), narration of changes (watch)
      --llm-provider, --llm-model, --llm-base-url   override the LLM settings (see \`breadth llm\`)
      --no-insights do not store insights in the written graph
      --intent      (diff) what the change was asked to do, or --intent-file: an LLM names what it does that was not asked for
      --plan        a Terraform plan (terraform show -json tfplan) for the root module in dir:
                    marks what applying it creates, changes, replaces or destroys (repeatable)
  -q, --quiet       less output
`;

/** LLM flags shared by scan, serve and watch. */
const LLM_FLAGS = {
  "llm-provider": { type: "string" },
  "llm-model": { type: "string" },
  "llm-base-url": { type: "string" },
} as const;

function llmFrom(config: { llm?: import("./llm/provider.js").LLMSettings }, values: Record<string, unknown>): LLMProvider {
  return createProvider(
    resolveSettings(config.llm, {
      provider: values["llm-provider"] as string | undefined,
      model: values["llm-model"] as string | undefined,
      baseUrl: values["llm-base-url"] as string | undefined,
    }),
  );
}

const log: Logger & { quiet: boolean } = {
  quiet: false,
  info(msg) {
    if (!this.quiet) process.stderr.write(`  ${msg}\n`);
  },
  warn(msg) {
    process.stderr.write(`  warning: ${msg}\n`);
  },
};

function readGraph(file: string): FlowGraph {
  const g = JSON.parse(readFileSync(file, "utf8"));
  assertValidGraph(g, file);
  return g;
}

function writeGraph(file: string, g: FlowGraph) {
  // small graphs stay readable and diffable; big ones are written compactly
  writeFileSync(file, JSON.stringify(g, null, g.nodes.length > 2000 ? undefined : 1) + "\n");
}

async function cmdScan(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o", default: "flowgraph.json" },
      collector: { type: "string", short: "c" },
      config: { type: "string" },
      exclude: { type: "string", multiple: true },
      "no-external": { type: "boolean" },
      llm: { type: "boolean" },
      ...LLM_FLAGS,
      "no-insights": { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      plan: { type: "string", multiple: true },
      workspace: { type: "string", short: "w" },
      as: { type: "string" },
    },
  });
  log.quiet = !!values.quiet;
  let target = path.resolve(positionals[0] ?? ".");
  if (!existsSync(target)) throw new Error(`path not found: ${target}`);
  // breadth scan breadth.workspace.json, or --workspace <file>: several repositories as one system
  const wsFile = values.workspace ? path.resolve(values.workspace) : target.endsWith(".json") ? target : undefined;
  const ws = wsFile ? loadWorkspace(wsFile) : undefined;
  if (ws) target = ws.dir;
  const config = loadConfig(target, values.config);
  const names = values.collector?.split(",").map((s) => s.trim()).filter(Boolean) ?? config.collectors;
  const settings = { ...(config.settings ?? {}) } as Record<string, Record<string, unknown>>;
  if (values["no-external"]) settings.code = { ...(settings.code ?? {}), includeExternal: false };

  const start = Date.now();
  const collectorOptions = { exclude: [...(config.exclude ?? []), ...(values.exclude ?? [])], include: config.include, settings, log };
  let graph: FlowGraph;
  // where the graph's paths are relative to: the staging folder links every repository by name
  let readRoot = target;
  if (ws) {
    process.stderr.write(`breadth: scanning workspace ${path.relative(process.cwd(), ws.file) || ws.file}: ${ws.repos.map((r) => r.name).join(", ")}\n`);
    const r = await scanWorkspace(ws, { ...collectorOptions, names });
    for (const w of r.warnings) log.warn(w);
    graph = r.graph;
    readRoot = r.staged.root;
  } else if (values.as) {
    // one repository, scanned under its name: what a workspace that includes it will see (publish this)
    process.stderr.write(`breadth: scanning ${target} as ${values.as}\n`);
    const exclude = collectorOptions.exclude.map((x) => `${values.as}/${x.replace(/^\//, "")}`);
    readRoot = stageOne(target, values.as);
    graph = await runCollectors(readRoot, names, { ...collectorOptions, exclude });
  } else {
    process.stderr.write(`breadth: scanning ${target}\n`);
    graph = await runCollectors(target, names, collectorOptions);
  }
  for (const w of applyPlans(graph, parsePlanArgs(values.plan))) log.warn(w);

  if (values.llm) {
    const provider = llmFrom(config, values);
    if (provider === noneProvider) log.warn("--llm given but no provider configured; see `breadth llm`");
    else {
      const limit = config.llm?.limit ?? 50;
      process.stderr.write(`breadth: ${privacyNotice(provider, `source excerpts of up to ${limit} functions`)}\n`);
      const n = await summarizeGraph(graph, provider, (file, a, b) => readLines(path.join(readRoot, file), a, b), limit);
      log.info(`llm: summarised ${n} nodes with ${provider.name}`);
    }
  }

  if (!values["no-insights"]) attachInsights(graph);
  writeGraph(values.out!, graph);
  process.stderr.write(`breadth: wrote ${values.out} (${graph.nodes.length} nodes, ${graph.edges.length} edges${insightSummary(graph)}) in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
  process.stderr.write(`         view it with: breadth serve ${values.out}\n`);
}

function readLines(file: string, start: number, end: number): string | undefined {
  try {
    return readFileSync(file, "utf8").split("\n").slice(start - 1, end).join("\n");
  } catch {
    return undefined;
  }
}

async function cmdImportTraces(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      merge: { type: "string", short: "m" },
      out: { type: "string", short: "o" },
      "no-insights": { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
    },
  });
  if (!positionals.length) throw new Error("usage: breadth import-traces <otlp.json>... [--merge flowgraph.json] [-o out.json]");
  const traces = importOtlp(positionals.map((f) => ({ name: f, text: readFileSync(f, "utf8") })));
  const out = values.out ?? values.merge ?? "flowgraph.json";
  let graph = traces;
  if (values.merge && existsSync(values.merge)) {
    const base = readGraph(values.merge);
    graph = mergeGraphs(base, linkTracesToCode(traces, base));
  }
  if (!values["no-insights"]) attachInsights(graph);
  assertValidGraph(graph, "merged graph");
  writeGraph(out, graph);
  process.stderr.write(
    `breadth: imported ${traces.executions?.length ?? 0} traces (${traces.nodes.length} nodes, ${traces.edges.length} edges) into ${out}${insightSummary(graph, true)}\n`,
  );
}

/** Sources named on the command line ("datadog,prometheus"), configured in breadth.config.json. */
function liveSources(names: string, config: import("./config.js").BreadthConfig): LiveSource[] {
  return names
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((n) => createSource(n, config.sources));
}

/** Traces and traffic from live backends into a graph. */
async function cmdPull(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      merge: { type: "string", short: "m" },
      out: { type: "string", short: "o" },
      since: { type: "string", default: "1h" },
      limit: { type: "string", default: "500" },
      services: { type: "string" },
      "no-traces": { type: "boolean" },
      "no-stats": { type: "boolean" },
      config: { type: "string" },
      quiet: { type: "boolean", short: "q" },
    },
  });
  log.quiet = !!values.quiet;
  const [names, target = "."] = positionals;
  if (!names) throw new Error("usage: breadth pull <datadog|prometheus|tempo|jaeger>[,...] [path] [--merge flowgraph.json] [--since 1h]");
  const config = loadConfig(path.resolve(target), values.config);
  const sources = liveSources(names, config);
  const merge = values.merge ?? (existsSync("flowgraph.json") && !positionals[1] ? "flowgraph.json" : undefined);
  let base: FlowGraph;
  if (merge && existsSync(merge)) base = readGraph(merge);
  else {
    process.stderr.write(`breadth: scanning ${path.resolve(target)}\n`);
    base = await scanTarget(path.resolve(target), values);
  }
  process.stderr.write(`breadth: reading ${sources.map((x) => x.describe).join(", ")}, last ${values.since}: span metadata and request counts, latency and errors (read only)\n`);
  const r = await pullLive(base, sources, {
    since: parseDuration(values.since!),
    traces: !values["no-traces"],
    stats: !values["no-stats"],
    limit: Number(values.limit),
    services: values.services?.split(",").map((x) => x.trim()).filter(Boolean) ?? config.sources?.services,
    window: values.since!,
  });
  attachInsights(r.graph);
  const out = values.out ?? merge ?? "flowgraph.json";
  writeGraph(out, r.graph);
  process.stderr.write(`breadth: ${r.traces} traces (${r.spans} spans), traffic for ${r.matched} of ${r.stats} endpoints and services → ${out}${insightSummary(r.graph, true)}\n`);
}

/** Judge a scenario from an experiment window and record the run as evidence. */
async function cmdEvidence(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      service: { type: "string" },
      endpoint: { type: "string" },
      from: { type: "string" },
      to: { type: "string", default: "now" },
      live: { type: "string" },
      results: { type: "string" },
      id: { type: "string" },
      tool: { type: "string" },
      fault: { type: "string" },
      "approved-by": { type: "string" },
      store: { type: "string" },
      "fail-on": { type: "string" },
      config: { type: "string" },
      "run-id": { type: "string" },
      "run-attr": { type: "string", default: "breadth.run_id" },
    },
  });
  const [scenario, target = "."] = positionals;
  if (!scenario || !values.service || !values.from) throw new Error('usage: breadth evidence "<scenario>" [path] --service <name> --from <time|15m> [--to now] [--endpoint "POST /x"] [--live datadog | --results p95_ms=180,error_pct=0.4]');
  if (!values.live && !values.results) throw new Error("say where the measurements come from: --live <source> or --results metric=value,...");
  const root = path.resolve(target);
  const config = loadConfig(root, values.config);
  const source = values.live ? liveSources(values.live, config)[0] : undefined;
  const results = values.results ? Object.fromEntries(values.results.split(",").map((kv) => kv.split("=")).map(([k, v]) => [k.trim(), Number(v)])) : undefined;
  process.stderr.write(`breadth: scanning ${root}\n`);
  const graph = await scanTarget(root, values);
  const from = parseTime(values.from);
  const to = parseTime(values.to!);
  const run = values["run-id"] ? { attr: values["run-attr"]!, value: values["run-id"] } : undefined;
  if (source) process.stderr.write(`breadth: measuring ${values.service}${values.endpoint ? ` ${values.endpoint}` : ""}${run ? ` (only spans with ${run.attr}=${run.value})` : ""} from ${new Date(from).toISOString()} to ${new Date(to).toISOString()} with ${source.describe} (read only)\n`);
  const r = await recordEvidence({ graph, root, scenario, service: values.service, endpoint: values.endpoint, from, to, source, results, id: values.id ?? values["run-id"], tool: values.tool, fault: values.fault, approvedBy: values["approved-by"], store: values.store, run });
  const mark = { supports: "✔", contradicts: "✖", inconclusive: "?" }[r.verdict];
  const lines = [`${mark} ${r.verdict}: ${r.scenario.name}`, ...r.checks.map((c) => `   ${c.ok === undefined ? "?" : c.ok ? "✓" : "✗"} ${c.metric} ${c.actual ?? "not measured"} (${c.op} ${c.expected})`), `   recorded ${path.relative(process.cwd(), r.file)}${r.record.fingerprint ? "" : " (no behaviour fingerprint: service not found in the scan, so this evidence cannot go stale)"}`];
  process.stdout.write(lines.join("\n") + "\n");
  const fail = values["fail-on"];
  if (fail && (r.verdict === "contradicts" || (fail === "inconclusive" && r.verdict === "inconclusive"))) process.exitCode = 2;
}

/** A standalone OTLP/HTTP receiver: traces from running services, merged into a graph file as they arrive. */
async function cmdReceive(args: string[]) {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p", default: "4318" },
      host: { type: "string", default: "127.0.0.1" },
      merge: { type: "string", short: "m", default: "flowgraph.json" },
      out: { type: "string", short: "o" },
      "max-traces": { type: "string", default: "2000" },
    },
  });
  const base = existsSync(values.merge!) ? readGraph(values.merge!) : undefined;
  const out = values.out ?? values.merge!;
  const buffer = new SpanBuffer(Number(values["max-traces"]));
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    const traces = spansToGraph(buffer.spans, ["otlp"]);
    const graph = base ? mergeGraphs(base, linkTracesToCode(traces, base)) : traces;
    attachInsights(graph);
    writeGraph(out, graph);
    log.info(`${buffer.size} traces → ${out}`);
  };
  await startOtlpServer({
    port: Number(values.port),
    host: values.host!,
    onSpans: (spans) => {
      buffer.add(spans);
      clearTimeout(timer);
      timer = setTimeout(flush, 1000);
    },
  });
  process.stderr.write(
    `breadth: receiving OTLP on http://${values.host}:${values.port}/v1/traces${base ? `, merging into ${values.merge}` : ""} (writing ${out})\n` +
      `         point an SDK or Collector at it: OTEL_EXPORTER_OTLP_ENDPOINT=http://${values.host}:${values.port}\n`,
  );
}

async function cmdServe(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p", default: "4321" },
      host: { type: "string", default: "127.0.0.1" },
      "no-open": { type: "boolean" },
      ...LLM_FLAGS,
    },
  });
  const graphFile = positionals[0] ?? "flowgraph.json";
  const graph = readGraph(graphFile);
  // "Explain" in the UI uses the LLM configured for the scanned project (or the current directory).
  const codeRoot = graph.sources?.find((s) => s.collector === "code" && s.target && existsSync(s.target))?.target ?? process.cwd();
  const llm = llmFrom(loadConfig(codeRoot), values);
  const url = await serve({ graphFile, port: Number(values.port), host: values.host!, open: !values["no-open"], llm });
  process.stderr.write(`breadth: serving ${graphFile} at ${url}  (Ctrl+C to stop)\n`);
  if (llm !== noneProvider) process.stderr.write(`breadth: "Explain" uses ${llm.name}${llm.remote ? " (remote: sends the node's source when you click it)" : " (local)"}\n`);
}

async function cmdWatch(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p", default: process.env.BREADTH_PORT ?? "4321" },
      host: { type: "string", default: "127.0.0.1" },
      "no-open": { type: "boolean" },
      out: { type: "string", short: "o" },
      collector: { type: "string", short: "c" },
      config: { type: "string" },
      exclude: { type: "string", multiple: true },
      traces: { type: "string", multiple: true },
      "otlp-port": { type: "string" },
      live: { type: "string" },
      every: { type: "string", default: "60s" },
      llm: { type: "boolean" },
      ...LLM_FLAGS,
    },
  });
  const target = path.resolve(positionals[0] ?? ".");
  if (!existsSync(target)) throw new Error(`path not found: ${target}`);
  const config = loadConfig(target, values.config);
  const llm = llmFrom(config, values);
  const narrate = values.llm ? llm : noneProvider;
  const started = Date.now();
  process.stderr.write(`breadth: watching ${target}\n`);
  const live = new LiveSession({
    target,
    collectors: values.collector?.split(",").map((x) => x.trim()).filter(Boolean) ?? config.collectors,
    collectorOptions: { exclude: [...(config.exclude ?? []), ...(values.exclude ?? [])], include: config.include, settings: config.settings },
    traces: values.traces,
    out: values.out,
    llm: narrate,
    log: (m) => process.stderr.write(`  ${new Date().toLocaleTimeString()}  ${m}\n`),
  });
  await live.start();
  const url = await serve({ live, port: Number(values.port), host: values.host!, open: !values["no-open"], llm });
  if (values.live) {
    const sources = liveSources(values.live, config);
    const every = parseDuration(values.every!);
    const window = values.every!;
    process.stderr.write(`breadth: reading ${sources.map((x) => x.describe).join(", ")} every ${window}: span metadata and request counts, latency and errors (read only)\n`);
    let last = Date.now() - every;
    const poll = async () => {
      const now = Date.now();
      for (const src of sources) {
        try {
          if (src.traces) live.ingestSpans(await src.traces({ from: last, to: now, services: config.sources?.services, limit: 300 }));
          if (src.stats) live.setLiveStats(src.name, window, await src.stats({ from: now - every, to: now, services: config.sources?.services }));
        } catch (err) {
          log.warn((err as Error).message);
        }
      }
      last = now;
    };
    await poll();
    setInterval(() => void poll(), every).unref?.();
    // keep the process alive: the server already does
  }
  if (values["otlp-port"]) {
    await startOtlpServer({ port: Number(values["otlp-port"]), host: values.host!, onSpans: (spans) => live.ingestSpans(spans) });
    process.stderr.write(`breadth: receiving OTLP traces on http://${values.host}:${values["otlp-port"]}/v1/traces (and on ${url}v1/traces)\n`);
  }
  process.stderr.write(
    `breadth: ${live.graph.nodes.length} nodes in ${((Date.now() - started) / 1000).toFixed(1)}s; live canvas at ${url}\n` +
      `         edits appear as they happen. Coding agent hooks: breadth hook --print-config\n`,
  );
  if (narrate !== noneProvider) process.stderr.write(`breadth: ${privacyNotice(narrate, "a structural summary of each change (names and files, no source)")}\n`);
}

async function cmdHook(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string", short: "p", default: process.env.BREADTH_PORT ?? "4321" },
      agent: { type: "string" },
      file: { type: "string", multiple: true },
      "print-config": { type: "boolean" },
    },
  });
  if (values["print-config"]) return cmdConnect(["claude", "--no-mcp", "--port", values.port!]);
  // A hook must never slow down or break the agent: short timeouts, always exit 0.
  let raw: Record<string, unknown> = {};
  if (!process.stdin.isTTY) {
    const text = await Promise.race([
      (async () => {
        let t = "";
        for await (const c of process.stdin) t += c;
        return t;
      })(),
      new Promise<string>((r) => setTimeout(() => r(""), 1000)),
    ]);
    try {
      raw = text.trim() ? JSON.parse(text) : {};
    } catch {
      raw = {};
    }
  }
  if (values.file?.length) raw.files = values.file;
  try {
    await fetch(`http://127.0.0.1:${values.port}/api/activity`, {
      method: "POST",
      headers: { "content-type": "application/json", [LOCAL_HEADER]: "1" },
      body: JSON.stringify(hookPayload(raw, values.agent)),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    /* breadth watch is not running: nothing to do */
  }
  process.stdout.write(hookReply(raw, values.agent), () => process.exit(0));
}

async function cmdConnect(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      write: { type: "boolean", short: "w" },
      dir: { type: "string", default: "." },
      port: { type: "string", short: "p", default: process.env.BREADTH_PORT ?? "4321" },
      "no-mcp": { type: "boolean" },
      "no-hooks": { type: "boolean" },
    },
  });
  const all = integrations(values.port);
  const wanted = positionals.length === 0 || positionals.includes("all") ? undefined : positionals.map((p) => p.toLowerCase().replace(/[^a-z]/g, ""));
  const aliases: Record<string, string> = { claudecode: "claude", vscode: "copilot", githubcopilot: "copilot", geminicli: "gemini", cascade: "windsurf", openai: "codex" };
  if (!positionals.length) {
    process.stdout.write(
      `Usage: breadth connect <agent>... [--write] [--port 4321] [--no-mcp] [--no-hooks]\n\n` +
        `Agents: ${all.map((a) => a.id).join(", ")}, all\n\n` +
        `Without --write, prints what to add. With --write, merges it into the project's config files (run it in the project).\n` +
        `Hooks report the agent's prompts and edits to \`breadth watch\`; the MCP server gives the agent the graph as tools.\n`,
    );
    return;
  }
  const chosen = wanted ? wanted.map((w) => all.find((a) => a.id === (aliases[w] ?? w)) ?? fail(w)) : all;
  function fail(w: string): never {
    throw new Error(`unknown agent "${w}". Known: ${all.map((a) => a.id).join(", ")}`);
  }
  const dir = path.resolve(values.dir!);
  for (const a of chosen) {
    process.stdout.write(`\n${a.name}\n${"-".repeat(a.name.length)}\n`);
    const files = [...(values["no-hooks"] ? [] : [a.hooks]), ...(values["no-mcp"] ? [] : [a.mcp])];
    for (const cf of files) {
      if (values.write) {
        const r = writeConfig(dir, cf);
        const shown = r.file.startsWith(process.cwd() + path.sep) ? path.relative(process.cwd(), r.file) : r.file;
        process.stdout.write(`  ${r.status.padEnd(9)} ${shown}${r.reason ? ` (${r.reason})` : ""}\n`);
        if (r.status === "skipped") process.stdout.write(renderConfig(cf).replace(/^/gm, "    "));
      } else process.stdout.write(renderConfig(cf));
    }
    for (const n of a.notes) process.stdout.write(`  note: ${n}\n`);
  }
  process.stdout.write(`\nThen run \`breadth watch${values.port !== "4321" ? ` --port ${values.port}` : ""}\` in the project and let the agent work.\n`);
}

const EDITORS = ["code", "code-insiders", "cursor", "windsurf", "antigravity", "codium"];

async function cmdEditor(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { editor: { type: "string", multiple: true } } });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const vsix = [path.join(here, "breadth-live.vsix"), path.join(here, "..", "dist", "breadth-live.vsix")].find((f) => existsSync(f));
  if (!vsix) throw new Error("breadth-live.vsix not found: run `npm run build` in the breadth repo first");
  if (positionals[0] === "path") return void process.stdout.write(`${vsix}\n`);
  if (positionals[0] !== "install") {
    process.stdout.write(
      `Usage: breadth editor install [--editor code|cursor|windsurf|antigravity]...\n       breadth editor path\n\n` +
        `Installs the breadth live extension, which sends unsaved edits to \`breadth watch\` so the canvas updates before files are saved.\n`,
    );
    return;
  }
  const targets = values.editor?.length ? values.editor : EDITORS;
  let installed = 0;
  for (const cli of targets) {
    const r = spawnSync(cli, ["--install-extension", vsix, "--force"], { encoding: "utf8", shell: process.platform === "win32" });
    if (r.error) {
      if (values.editor?.length) process.stdout.write(`  ${cli}: not found on PATH\n`);
      continue;
    }
    installed++;
    process.stdout.write(`  ${cli}: ${r.status === 0 ? "installed" : `failed (${(r.stderr || r.stdout).trim().split("\n").pop()})`}\n`);
  }
  if (!installed)
    process.stdout.write(`No editor command found on PATH (${targets.join(", ")}).\nInstall it from the editor instead: Extensions › … › Install from VSIX, and pick\n  ${vsix}\n`);
}

async function cmdMcp(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string", short: "p", default: process.env.BREADTH_PORT ?? "4321" },
      config: { type: "string" },
    },
  });
  const root = path.resolve(positionals[0] ?? process.env.BREADTH_ROOT ?? ".");
  const config = loadConfig(root, values.config);
  await runMcp({
    root,
    port: values.port!,
    version: VERSION,
    collectorOptions: { exclude: config.exclude, include: config.include, settings: config.settings },
  });
}

async function cmdLlm(args: string[]) {
  const [sub] = args;
  const config = loadConfig(process.cwd());
  const settings = resolveSettings(config.llm);
  if (sub === "check") {
    const p = createProvider(settings);
    if (p === noneProvider) throw new Error("no LLM provider configured (set BREADTH_LLM_PROVIDER or \"llm\" in breadth.config.json)");
    process.stderr.write(`breadth: ${privacyNotice(p, "a one-line test prompt")}\n`);
    const started = Date.now();
    const text = await p.complete({ system: "Reply with exactly: ok", prompt: "Say ok.", maxTokens: 20 });
    process.stdout.write(`${p.name}: ${JSON.stringify(text)} in ${Date.now() - started} ms\n`);
    return;
  }
  process.stdout.write(`LLM features are off unless you pick a provider. Current: ${settings.provider ?? "none"}${settings.model ? ` (${settings.model})` : ""}\n\n`);
  for (const [id, p] of Object.entries(PRESETS)) {
    const local = /127\.0\.0\.1|localhost/.test(p.baseUrl);
    process.stdout.write(`  ${id.padEnd(18)} ${p.label.padEnd(44)} ${local ? "local " : "remote"}  ${p.keyEnv ? `$${p.keyEnv}` : ""}${p.defaultModel ? `  default model ${p.defaultModel}` : ""}\n`);
  }
  process.stdout.write(
    `\nConfigure in breadth.config.json:  "llm": { "provider": "anthropic" }\n` +
      `or per run:  BREADTH_LLM_PROVIDER=ollama BREADTH_LLM_MODEL=qwen2.5-coder breadth scan . --llm\n` +
      `Any other OpenAI-compatible server or gateway: "provider": "openai-compatible", "baseUrl": "...", "model": "..."\n`,
  );
}

function attachInsights(graph: FlowGraph) {
  graph.insights = runInsights(graph);
  if (!graph.insights.length) delete graph.insights;
}

function insightSummary(graph: FlowGraph, sentence = false): string {
  const n = graph.insights?.length ?? 0;
  if (!n) return "";
  return sentence ? `; ${n} insight${n === 1 ? "" : "s"}` : `, ${n} insight${n === 1 ? "" : "s"}`;
}

const SEV_ORDER: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const SEV_MARK: Record<Severity, string> = { critical: "✖", warning: "▲", info: "●" };

async function cmdDiff(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      base: { type: "string", short: "b" },
      head: { type: "string" },
      out: { type: "string", short: "o" },
      markdown: { type: "string", short: "m" },
      json: { type: "boolean" },
      "fail-on": { type: "string" },
      link: { type: "string" },
      collector: { type: "string", short: "c" },
      config: { type: "string" },
      exclude: { type: "string", multiple: true },
      plan: { type: "string", multiple: true },
      intent: { type: "string" },
      "intent-file": { type: "string" },
      live: { type: "string" },
      since: { type: "string", default: "1h" },
      "spec-change": { type: "string" },
      "pr-text-file": { type: "string" },
      ...LLM_FLAGS,
    },
  });
  const plans = parsePlanArgs(values.plan);
  let before: FlowGraph;
  let after: FlowGraph;
  let report: ChangeReport;
  if (positionals.length === 2 && positionals.every((p) => p.endsWith(".json"))) {
    before = loadGraph(positionals[0]);
    after = loadGraph(positionals[1]);
    for (const w of applyPlans(after, plans)) log.warn(w);
    report = describeChanges(withoutRemoved(before), withoutRemoved(after), { base: values.base ?? path.basename(positionals[0]), head: values.head ?? path.basename(positionals[1]) });
  } else {
    const target = path.resolve(positionals[0] ?? ".");
    const config = loadConfig(target, values.config);
    process.stderr.write(`breadth: scanning ${values.base ?? "the merge base"} and ${values.head ?? "the working tree"}…\n`);
    ({ before, after, report } = await diffRefs({
      target,
      base: values.base,
      head: values.head,
      collectors: values.collector?.split(",").map((x) => x.trim()).filter(Boolean) ?? config.collectors,
      collectorOptions: { exclude: [...(config.exclude ?? []), ...(values.exclude ?? [])], include: config.include, settings: config.settings, log: { info() {}, warn: (m) => log.warn(m) } },
      plans,
    }));
  }
  // Repositories with specs: the spec change this pull request implements, and what falls outside it.
  const prText = values["pr-text-file"] && existsSync(values["pr-text-file"]) ? readFileSync(values["pr-text-file"], "utf8") : undefined;
  let request = values["intent-file"] ? readFileSync(values["intent-file"], "utf8") : values.intent;
  report.spec = checkSpec(before, after, report, { branch: currentBranch(positionals.length === 2 ? undefined : path.resolve(positionals[0] ?? "."), values.head), text: [prText, request].filter(Boolean).join("\n\n") || undefined, change: values["spec-change"] });
  if (request?.trim() && report.spec?.changes.length) request = `${request}\n\n${specRequest(after, report.spec.changes.map((c) => c.id))}`;
  if (request?.trim()) {
    const llm = llmFrom(loadConfig(path.resolve(positionals.length === 2 ? "." : (positionals[0] ?? ".")), values.config), values);
    if (llm === noneProvider) log.warn("--intent needs an LLM to compare the request with the change; configure one (see `breadth llm`). Skipped.");
    else {
      const notice = privacyNotice(llm, "the request text and the list of behaviour changes (no source code)");
      if (notice) process.stderr.write(`breadth: ${notice}\n`);
      try {
        report.intent = await checkIntent(request, report.changes, llm);
        if (!report.intent) log.warn(`${llm.name} gave no usable answer for --intent; the comparison is left out`);
      } catch (err) {
        log.warn(`--intent: ${(err as Error).message}`);
      }
    }
  }
  // Comprehension ledger in the repository: how much of this change nobody has reviewed yet.
  let comprehension: string | undefined;
  const ledgerFile = positionals.length === 2 ? undefined : ledgerPath(path.resolve(positionals[0] ?? "."));
  if (ledgerFile && existsSync(ledgerFile)) {
    const ledger = loadLedger(ledgerFile);
    const afterUnits = behaviourUnits(after);
    const touched = unitsInDiff(afterUnits, report, after).filter((u) => ledger.reviewed[u.id]?.fp !== u.fp);
    const was = computeDebt(behaviourUnits(before), ledger).debt;
    const now = computeDebt(afterUnits, ledger).debt;
    comprehension = `🧠 ${touched.length} behaviour${touched.length === 1 ? "" : "s"} in this change ${touched.length === 1 ? "is" : "are"} not in the comprehension ledger yet. Unreviewed behaviour overall: ${was}% → ${now}%. After reviewing, record it with \`breadth review --changed\`.`;
  }
  // Production traffic on what changed (blast radius): stats only, onto the head graph.
  let liveNote: string | undefined;
  if (values.live) {
    const config = loadConfig(path.resolve(positionals.length === 2 ? "." : (positionals[0] ?? ".")), values.config);
    try {
      const sources = liveSources(values.live, config);
      process.stderr.write(`breadth: reading request counts, latency and errors from ${sources.map((x) => x.describe).join(", ")} (read only)\n`);
      const r = await pullLive(after, sources, { since: parseDuration(values.since!), traces: false, stats: true, limit: 0, services: config.sources?.services, window: values.since! });
      liveNote = `${sources.map((x) => x.name).join(", ")}, last ${values.since} (${r.matched} endpoints and services matched)`;
    } catch (err) {
      log.warn(`--live: ${(err as Error).message}; the comment goes out without traffic`);
    }
  }
  const md = renderMarkdown(report, before, after, { link: values.link, comprehension, live: liveNote });
  if (values.out) {
    writeFileSync(values.out, JSON.stringify(diffGraph(before, after, report)) + "\n");
    process.stderr.write(`breadth: wrote the diff graph to ${values.out} (open it with \`breadth serve ${values.out}\`)\n`);
  }
  if (values.markdown) writeFileSync(values.markdown, md);
  if (values.json) {
    const { insightsAddedFull: _a, insightsResolvedFull: _r, ...plain } = report;
    process.stdout.write(JSON.stringify(plain, null, 2) + "\n");
  } else if (!values.markdown) process.stdout.write(process.stdout.isTTY ? renderText(report) : md);
  const failOn = values["fail-on"];
  if (failOn) {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const limit = rank[failOn as keyof typeof rank];
    if (limit === undefined) throw new Error("--fail-on takes high, medium or low");
    if (report.changes.some((c) => rank[c.severity] <= limit)) process.exitCode = 2;
  }
}

/** The branch a diff is about: the PR's head in GitHub Actions, the named ref, or the checkout's. */
function currentBranch(target: string | undefined, head?: string): string | undefined {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  if (head) return head;
  if (!target) return undefined;
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: target });
  const b = r.status === 0 ? r.stdout.toString().trim() : undefined;
  return b && b !== "HEAD" ? b : undefined;
}

/** The spec change as a request, for the intent check: what it says it does. */
function specRequest(g: FlowGraph, ids: string[]): string {
  const parts: string[] = [];
  for (const id of ids) {
    const c = g.nodes.find((n) => n.id === `change:${id}`);
    if (!c) continue;
    const reqs = g.nodes.filter((n) => n.role === "requirement" && (n.metadata?.change === id || n.parent === `spec:${id}` || n.parent === `change:${id}/spec:${n.id.split("/")[0].slice(4)}`));
    parts.push(`Spec change ${id}: ${c.name}${c.description ? `. Why: ${c.description}` : ""}`, ...reqs.map((r) => `- Requirement: ${r.name}${r.description ? `: ${r.description}` : ""}`));
  }
  return parts.join("\n");
}

/** The ledger file for a path: <repo root>/.breadth/ledger.json, or next to the path outside git. */
function ledgerPath(target: string, explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  try {
    return path.join(repoRoot(target), LEDGER_FILE);
  } catch {
    return path.join(target, LEDGER_FILE);
  }
}

async function scanTarget(target: string, values: { config?: string; collector?: string; exclude?: string[] }): Promise<FlowGraph> {
  const config = loadConfig(target, values.config);
  return scanForDiff(target, values.collector?.split(",").map((x) => x.trim()).filter(Boolean) ?? config.collectors, {
    exclude: [...(config.exclude ?? []), ...(values.exclude ?? [])],
    include: config.include,
    settings: config.settings,
  });
}

async function cmdReview(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      changed: { type: "boolean" },
      base: { type: "string" },
      from: { type: "string" },
      nodes: { type: "string" },
      by: { type: "string" },
      ledger: { type: "string" },
      config: { type: "string" },
      collector: { type: "string", short: "c" },
      exclude: { type: "string", multiple: true },
    },
  });
  const target = path.resolve(positionals[0] ?? ".");
  const file = ledgerPath(target, values.ledger);
  const ledger = loadLedger(file);
  if (!values.all && !values.changed && !values.from && !values.nodes) throw new Error("say what was reviewed: --changed (this branch's changes), --from diff.json, --nodes id,id or --all (adopt everything as reviewed)");
  process.stderr.write(`breadth: scanning ${target}\n`);
  const graph = await scanTarget(target, values);
  const units = behaviourUnits(graph);
  let picked: Unit[];
  if (values.all) picked = [...units.values()];
  else if (values.nodes) picked = values.nodes.split(",").map((id) => units.get(id.trim())).filter((u): u is Unit => !!u);
  else if (values.from) {
    const d = loadGraph(values.from);
    if (!d.diff) throw new Error(`${values.from} is not a diff graph (make one with breadth diff -o)`);
    picked = unitsInDiff(units, d.diff, d);
  } else {
    const config = loadConfig(target, values.config);
    const { after, report } = await diffRefs({ target, base: values.base, collectors: config.collectors, collectorOptions: { exclude: config.exclude, include: config.include, settings: config.settings } });
    picked = unitsInDiff(behaviourUnits(after), report, after);
  }
  const n = markReviewed(ledger, picked, values.by ?? process.env.GIT_AUTHOR_NAME ?? process.env.USER);
  saveLedger(file, ledger);
  const d = computeDebt(units, ledger);
  process.stderr.write(`breadth: ${n} behaviour${n === 1 ? "" : "s"} marked as reviewed (${picked.length - n} already were). Unreviewed: ${d.unreviewed} of ${d.units} (${d.debt}% weighted). Ledger: ${path.relative(process.cwd(), file)}\n`);
}

async function cmdDebt(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      record: { type: "boolean" },
      top: { type: "string", default: "10" },
      "fail-above": { type: "string" },
      ledger: { type: "string" },
      config: { type: "string" },
      collector: { type: "string", short: "c" },
      exclude: { type: "string", multiple: true },
    },
  });
  const target = path.resolve(positionals[0] ?? ".");
  const file = ledgerPath(target, values.ledger);
  const ledger = loadLedger(file);
  const graph = positionals[0]?.endsWith(".json") ? loadGraph(positionals[0]) : await scanTarget(target, values);
  const d = computeDebt(behaviourUnits(graph), ledger);
  const last = ledger.history[ledger.history.length - 1];
  if (values.record) {
    let ref: string | undefined;
    try {
      ref = shortRef(repoRoot(target), "HEAD");
    } catch {
      /* not a git checkout */
    }
    ledger.history.push({ at: new Date().toISOString(), ref, units: d.units, unreviewed: d.unreviewed, debt: d.debt });
    saveLedger(file, ledger);
  }
  if (values.json) {
    process.stdout.write(JSON.stringify({ ...d, open: d.open.map((u) => ({ id: u.id, name: u.node.name, service: u.service, weight: u.weight, file: u.node.source?.file, line: u.node.source?.line })), previous: last }, null, 2) + "\n");
  } else {
    const trend = last ? ` (${d.debt >= last.debt ? "+" : ""}${Math.round((d.debt - last.debt) * 10) / 10} since ${last.ref ?? last.at.slice(0, 10)})` : "";
    const out = [`Comprehension debt: ${d.debt}% of behaviour, weighted by risk, has not been reviewed${trend}`, `${d.unreviewed} of ${d.units} behaviours unreviewed${Object.keys(ledger.reviewed).length ? "" : " (the ledger is empty: start with \`breadth review --all\` to adopt today's code)"}`, ""];
    const w = Math.max(8, ...d.byService.map((s) => s.service.length));
    out.push(`  ${"service".padEnd(w)}  unreviewed   debt`);
    for (const s of d.byService) out.push(`  ${s.service.padEnd(w)}  ${`${s.unreviewed}/${s.units}`.padStart(10)}  ${`${s.debt}%`.padStart(5)}`);
    const top = d.open.slice(0, Number(values.top));
    if (top.length) {
      out.push("", "Riskiest unreviewed behaviour:");
      for (const u of top) out.push(`  ${"●".repeat(u.weight).padEnd(3)} ${u.node.name}${u.node.source?.file ? `  ${u.node.source.file}${u.node.source.line ? `:${u.node.source.line}` : ""}` : ""}`);
    }
    process.stdout.write(out.join("\n") + "\n");
  }
  if (values["fail-above"] !== undefined && d.debt > Number(values["fail-above"])) process.exitCode = 2;
}

async function cmdInsights(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      write: { type: "boolean" },
      "fail-on": { type: "string" },
      rules: { type: "string" },
      list: { type: "boolean" },
    },
  });
  if (values.list) {
    for (const r of RULES) process.stdout.write(`  ${r.id.padEnd(26)} ${r.category.padEnd(13)} ${r.description}\n`);
    return;
  }
  const file = positionals[0] ?? "flowgraph.json";
  const graph = readGraph(file);
  const insights: Insight[] = runInsights(graph, { rules: values.rules?.split(",").map((s) => s.trim()) });
  if (values.write) {
    graph.insights = insights;
    writeGraph(file, graph);
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(insights, null, 2) + "\n");
  } else if (!insights.length) {
    process.stdout.write(`${file}: no insights\n`);
  } else {
    const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
    for (const i of insights) {
      process.stdout.write(`${SEV_MARK[i.severity]} ${i.severity.padEnd(8)} ${i.title}  [${i.rule}]\n`);
      if (i.detail) process.stdout.write(`  ${i.detail}\n`);
      process.stdout.write(`  at: ${i.nodes.slice(0, 4).map((n) => names.get(n) ?? n).join(", ")}${i.confidence === "low" ? "  (low confidence)" : ""}\n\n`);
    }
    const counts = (["critical", "warning", "info"] as Severity[]).map((s) => `${insights.filter((i) => i.severity === s).length} ${s}`);
    process.stdout.write(`${insights.length} insights: ${counts.join(", ")}\n`);
  }
  const failOn = values["fail-on"] as Severity | undefined;
  if (failOn) {
    if (!(failOn in SEV_ORDER)) throw new Error("--fail-on must be info, warning or critical");
    if (insights.some((i) => SEV_ORDER[i.severity] >= SEV_ORDER[failOn])) process.exitCode = 1;
  }
}

function cmdValidate(args: string[]) {
  const file = args[0];
  if (!file) throw new Error("usage: breadth validate <flowgraph.json>");
  const r = validateGraph(JSON.parse(readFileSync(file, "utf8")));
  if (r.valid) {
    process.stdout.write(`${file}: valid\n`);
  } else {
    process.stdout.write(`${file}: ${r.errors.length} problem(s)\n  ${r.errors.join("\n  ")}\n`);
    process.exitCode = 1;
  }
}

function cmdCollectors() {
  for (const c of collectors) process.stdout.write(`  ${c.name.padEnd(10)} ${c.implemented ? "     " : "stub "} ${c.description}\n`);
}

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "scan":
      return cmdScan(rest);
    case "import-traces":
      return cmdImportTraces(rest);
    case "serve":
      return cmdServe(rest);
    case "validate":
      return cmdValidate(rest);
    case "insights":
      return cmdInsights(rest);
    case "watch":
      return cmdWatch(rest);
    case "diff":
      return cmdDiff(rest);
    case "review":
      return cmdReview(rest);
    case "receive":
      return cmdReceive(rest);
    case "pull":
      return cmdPull(rest);
    case "evidence":
      return cmdEvidence(rest);
    case "debt":
      return cmdDebt(rest);
    case "hook":
      return cmdHook(rest);
    case "connect":
      return cmdConnect(rest);
    case "mcp":
      return cmdMcp(rest);
    case "editor":
      return cmdEditor(rest);
    case "llm":
      return cmdLlm(rest);
    case "collectors":
      return cmdCollectors();
    case "-v":
    case "--version":
      process.stdout.write(`${VERSION}\n`);
      return;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

// `breadth insights … | head` closes stdout early: that is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

main(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(`breadth: ${err.message}\n`);
  process.exit(1);
});
