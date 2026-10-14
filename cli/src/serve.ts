import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
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
  graphFile: string;
  port: number;
  host: string;
  open: boolean;
}

/** Serve the UI and the graph on localhost only. The graph is re-read on every request. */
export async function serve(opts: ServeOptions): Promise<string> {
  const uiDir = findUiDir();
  const graphPath = path.resolve(opts.graphFile);
  if (!existsSync(graphPath)) throw new Error(`graph file not found: ${opts.graphFile}`);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/flowgraph.json") {
      res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
      res.end(readFileSync(graphPath));
      return;
    }
    let file = path.normalize(path.join(uiDir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(uiDir)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(uiDir, "index.html");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
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
