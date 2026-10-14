import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { assertValidGraph, mergeGraphs, validateGraph, type FlowGraph } from "@noodles/schema";
import { collectors, importOtlp, linkTracesToCode, runCollectors, type Logger } from "@noodles/collectors";
import { RULES, runInsights } from "@noodles/insights";
import type { Insight, Severity } from "@noodles/schema";
import { loadConfig } from "./config.js";
import { createProvider, summarizeGraph } from "./llm/provider.js";
import { serve } from "./serve.js";

const VERSION = "0.1.0";

const HELP = `noodles ${VERSION}: turn any codebase or system into an n8n-style canvas

Usage:
  noodles scan <path> [--collector code,infra] [-o flowgraph.json] [--config file] [--exclude glob]...
  noodles import-traces <otlp.json>... [--merge flowgraph.json] [-o out.json]
  noodles serve [flowgraph.json] [--port 4321] [--host 127.0.0.1] [--no-open]
  noodles insights <flowgraph.json> [--json] [--write] [--fail-on warning|critical] [--rules a,b]
  noodles validate <flowgraph.json>
  noodles collectors

Options:
  -o, --out         output file (scan: flowgraph.json; import-traces: the --merge file)
  -c, --collector   comma-separated collectors (default: auto-detect)
      --config      config file (default: <path>/noodles.config.json if present)
      --exclude     extra ignore pattern, gitignore syntax (repeatable)
      --no-external hide third-party packages
      --llm         summarise nodes with the configured LLM provider (off by default)
      --no-insights do not store insights in the written graph
  -q, --quiet       less output
`;

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
  writeFileSync(file, JSON.stringify(g, null, 1) + "\n");
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
      "no-insights": { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
    },
  });
  log.quiet = !!values.quiet;
  const target = path.resolve(positionals[0] ?? ".");
  if (!existsSync(target)) throw new Error(`path not found: ${target}`);
  const config = loadConfig(target, values.config);
  const names = values.collector?.split(",").map((s) => s.trim()).filter(Boolean) ?? config.collectors;
  const settings = { ...(config.settings ?? {}) } as Record<string, Record<string, unknown>>;
  if (values["no-external"]) settings.code = { ...(settings.code ?? {}), includeExternal: false };

  const start = Date.now();
  process.stderr.write(`noodles: scanning ${target}\n`);
  const graph = await runCollectors(target, names, {
    exclude: [...(config.exclude ?? []), ...(values.exclude ?? [])],
    include: config.include,
    settings,
    log,
  });

  if (values.llm) {
    const provider = createProvider(config.llm);
    if (provider.name === "none") log.warn('--llm given but no provider configured; set "llm": {"provider": "ollama"} in noodles.config.json');
    const n = await summarizeGraph(graph, provider, (file, a, b) => readLines(path.join(target, file), a, b), config.llm?.limit);
    log.info(`llm: summarised ${n} nodes with ${provider.name}`);
  }

  if (!values["no-insights"]) attachInsights(graph);
  writeGraph(values.out!, graph);
  process.stderr.write(`noodles: wrote ${values.out} (${graph.nodes.length} nodes, ${graph.edges.length} edges${insightSummary(graph)}) in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
  process.stderr.write(`         view it with: noodles serve ${values.out}\n`);
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
  if (!positionals.length) throw new Error("usage: noodles import-traces <otlp.json>... [--merge flowgraph.json] [-o out.json]");
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
    `noodles: imported ${traces.executions?.length ?? 0} traces (${traces.nodes.length} nodes, ${traces.edges.length} edges) into ${out}${insightSummary(graph, true)}\n`,
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
    },
  });
  const graphFile = positionals[0] ?? "flowgraph.json";
  readGraph(graphFile);
  const url = await serve({ graphFile, port: Number(values.port), host: values.host!, open: !values["no-open"] });
  process.stderr.write(`noodles: serving ${graphFile} at ${url}  (Ctrl+C to stop)\n`);
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
  if (!file) throw new Error("usage: noodles validate <flowgraph.json>");
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

// `noodles insights … | head` closes stdout early: that is not an error.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});

main(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(`noodles: ${err.message}\n`);
  process.exit(1);
});
