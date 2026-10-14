import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { assertValidGraph, mergeGraphs, validateGraph, type FlowGraph } from "@noodles/schema";
import { collectors, importOtlp, linkTracesToCode, runCollectors, type Logger } from "@noodles/collectors";
import { loadConfig } from "./config.js";
import { createProvider, summarizeGraph } from "./llm/provider.js";
import { serve } from "./serve.js";

const VERSION = "0.1.0";

const HELP = `noodles ${VERSION}: turn any codebase or system into an n8n-style canvas

Usage:
  noodles scan <path> [--collector code,infra] [-o flowgraph.json] [--config file] [--exclude glob]...
  noodles import-traces <otlp.json>... [--merge flowgraph.json] [-o out.json]
  noodles serve [flowgraph.json] [--port 4321] [--host 127.0.0.1] [--no-open]
  noodles validate <flowgraph.json>
  noodles collectors

Options:
  -o, --out         output file (scan: flowgraph.json; import-traces: the --merge file)
  -c, --collector   comma-separated collectors (default: auto-detect)
      --config      config file (default: <path>/noodles.config.json if present)
      --exclude     extra ignore pattern, gitignore syntax (repeatable)
      --no-external hide third-party packages
      --llm         summarise nodes with the configured LLM provider (off by default)
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

  writeGraph(values.out!, graph);
  process.stderr.write(`noodles: wrote ${values.out} (${graph.nodes.length} nodes, ${graph.edges.length} edges) in ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
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
  assertValidGraph(graph, "merged graph");
  writeGraph(out, graph);
  process.stderr.write(
    `noodles: imported ${traces.executions?.length ?? 0} traces (${traces.nodes.length} nodes, ${traces.edges.length} edges) into ${out}\n`,
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

main(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(`noodles: ${err.message}\n`);
  process.exit(1);
});
