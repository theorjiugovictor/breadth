import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertValidGraph, mergeGraphs, validateGraph, type FlowGraph } from "@breadth/schema";
import { collectors, importOtlp, linkTracesToCode, runCollectors, type Logger } from "@breadth/collectors";
import { RULES, runInsights, describeChanges, diffGraph, withoutRemoved, type ChangeReport } from "@breadth/insights";
import type { Insight, Severity } from "@breadth/schema";
import { loadConfig } from "./config.js";
import { createProvider, noneProvider, PRESETS, privacyNotice, resolveSettings, summarizeGraph, type LLMProvider } from "./llm/provider.js";
import { LiveSession } from "./live.js";
import { LOCAL_HEADER, serve } from "./serve.js";
import { hookPayload, hookReply } from "./hook.js";
import { integrations, renderConfig, writeConfig } from "./connect.js";
import { runMcp } from "./mcp.js";
import { diffRefs, loadGraph, renderMarkdown, renderText } from "./diff.js";

const VERSION = "0.1.0";

const HELP = `breadth ${VERSION}: turn any codebase or system into an n8n-style canvas

Usage:
  breadth scan <path> [--collector code,infra] [-o flowgraph.json] [--config file] [--exclude glob]...
  breadth diff [path] [--base ref] [--head ref] [-o diff.json] [--markdown pr.md] [--fail-on high]   what a change does, in behaviour
  breadth diff before.json after.json
  breadth import-traces <otlp.json>... [--merge flowgraph.json] [-o out.json]
  breadth serve [flowgraph.json] [--port 4321] [--host 127.0.0.1] [--no-open]
  breadth watch [path] [--port 4321] [--traces otlp.json] [-o flowgraph.json] [--llm]   live canvas while you (or an agent) code
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
  process.stderr.write(`breadth: scanning ${target}\n`);
  const graph = await runCollectors(target, names, {
    exclude: [...(config.exclude ?? []), ...(values.exclude ?? [])],
    include: config.include,
    settings,
    log,
  });

  if (values.llm) {
    const provider = llmFrom(config, values);
    if (provider === noneProvider) log.warn("--llm given but no provider configured; see `breadth llm`");
    else {
      const limit = config.llm?.limit ?? 50;
      process.stderr.write(`breadth: ${privacyNotice(provider, `source excerpts of up to ${limit} functions`)}\n`);
      const n = await summarizeGraph(graph, provider, (file, a, b) => readLines(path.join(target, file), a, b), limit);
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
    },
  });
  let before: FlowGraph;
  let after: FlowGraph;
  let report: ChangeReport;
  if (positionals.length === 2 && positionals.every((p) => p.endsWith(".json"))) {
    before = loadGraph(positionals[0]);
    after = loadGraph(positionals[1]);
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
      collectorOptions: { exclude: [...(config.exclude ?? []), ...(values.exclude ?? [])], include: config.include, settings: config.settings },
    }));
  }
  const md = renderMarkdown(report, before, after, { link: values.link });
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
