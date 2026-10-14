import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FlowGraph } from "@noodles/schema";
import { EXPLAIN_SYSTEM, explainPrompt, noneProvider, type LLMProvider } from "./llm/provider.js";
import type { LiveSession } from "./live.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** Find the built UI: next to the bundled CLI, or ui/dist in the source tree. */
export function findUiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "ui"), path.join(here, "..", "..", "ui", "dist"), path.join(here, "..", "ui", "dist")];
  const found = candidates.find((d) => existsSync(path.join(d, "index.html")));
  if (!found) throw new Error("built UI not found. Run `npm run build` in the noodles repo first.");
  return found;
}

export interface ServeOptions {
  /** A graph file (re-read on every request) or a live session (in memory, pushed over SSE). */
  graphFile?: string;
  live?: LiveSession;
  port: number;
  host: string;
  open: boolean;
  llm?: LLMProvider;
}

/**
 * Requests that cost something (LLM calls) or change state (agent activity) must carry this
 * header. Browsers cannot add it cross-origin without a CORS preflight we never answer, so
 * other web pages cannot trigger them against the local server.
 */
export const LOCAL_HEADER = "x-noodles";

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": TYPES[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 256_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Serve the UI and the graph on localhost only. */
export async function serve(opts: ServeOptions): Promise<string> {
  const uiDir = findUiDir();
  const graphPath = opts.graphFile ? path.resolve(opts.graphFile) : undefined;
  if (graphPath && !existsSync(graphPath)) throw new Error(`graph file not found: ${opts.graphFile}`);
  const llm = opts.llm ?? noneProvider;
  const currentGraph = (): FlowGraph => (opts.live ? opts.live.graph : (JSON.parse(readFileSync(graphPath!, "utf8")) as FlowGraph));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      switch (url.pathname) {
        case "/flowgraph.json":
          if (opts.live) return json(res, 200, opts.live.graph);
          res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
          return void res.end(readFileSync(graphPath!));
        case "/api/info":
          return json(res, 200, {
            live: !!opts.live,
            version: opts.live?.version ?? 0,
            target: opts.live?.target,
            llm: llm === noneProvider ? null : { name: llm.name, remote: llm.remote },
          });
        case "/api/source":
          return sendSource(currentGraph(), url, res);
        case "/api/events":
          if (!opts.live) return json(res, 404, { error: "not a live session" });
          return opts.live.subscribe(req, res);
        case "/api/activity":
          if (!opts.live) return json(res, 404, { error: "not a live session" });
          if (req.method === "POST") {
            if (req.headers[LOCAL_HEADER] !== "1") return json(res, 403, { error: `missing ${LOCAL_HEADER} header` });
            opts.live.agentActivity(JSON.parse(await readBody(req)));
            return json(res, 202, { ok: true });
          }
          return json(res, 200, opts.live.activity);
        case "/api/explain": {
          if (req.headers[LOCAL_HEADER] !== "1") return json(res, 403, { error: `missing ${LOCAL_HEADER} header` });
          if (llm === noneProvider) return json(res, 400, { error: "no LLM provider configured (see `noodles llm providers`)" });
          const graph = currentGraph();
          const node = graph.nodes.find((n) => n.id === url.searchParams.get("node"));
          if (!node) return json(res, 404, { error: "unknown node" });
          const src = node.source?.file && node.source.line ? readSource(graph, node.source.file, node.source.line, Math.min(node.source.endLine ?? node.source.line + 60, node.source.line + 150)) : undefined;
          const text = await llm.complete({ system: EXPLAIN_SYSTEM, prompt: explainPrompt(graph, node, src?.lines.join("\n")), maxTokens: 400 });
          return json(res, 200, { text: text ?? "(no answer)", by: llm.name, remote: llm.remote });
        }
      }
      if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
      let file = path.normalize(path.join(uiDir, decodeURIComponent(url.pathname)));
      if (!file.startsWith(uiDir)) return void res.writeHead(403).end();
      if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(uiDir, "index.html");
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  const link = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${port}/`;
  if (opts.open) openBrowser(link);
  return link;
}

/**
 * Source lines for the Source tab and LLM prompts. Only files under a scanned root
 * (sources[].target of the code collector) are readable.
 */
export function readSource(graph: FlowGraph, rel: string, start: number, end: number): { path: string; start: number; lines: string[] } | undefined {
  const roots = (graph.sources ?? []).filter((s) => s.collector === "code" && s.target && !/^https?:/.test(s.target)).map((s) => path.resolve(s.target!));
  for (const root of roots) {
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) continue;
    const from = Math.max(1, start);
    return { path: file, start: from, lines: readFileSync(file, "utf8").split("\n").slice(from - 1, Math.min(end, from + 400)) };
  }
  return undefined;
}

function sendSource(graph: FlowGraph, url: URL, res: ServerResponse) {
  const start = Math.max(1, Number(url.searchParams.get("start") ?? 1));
  const end = Number(url.searchParams.get("end") ?? start + 40);
  const src = readSource(graph, url.searchParams.get("file") ?? "", start, end);
  if (!src) return void res.writeHead(404).end();
  json(res, 200, src);
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no browser available: the URL is printed anyway */
  }
}
