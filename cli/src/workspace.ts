import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { linkCodeToInfra, linkGrpcNames, linkHttpCalls, runCollectors, type CollectorOptions } from "@breadth/collectors";
import { mergeGraphs, SCHEMA_VERSION, type FlowGraph } from "@breadth/schema";
import { CONFIG_FILE, loadConfig } from "./config.js";

/**
 * A system spread over several repositories, described in breadth.workspace.json:
 *
 *   { "repos": [
 *       { "name": "orders",   "path": "../orders" },                                   scanned from disk
 *       { "name": "payments", "git": "https://github.com/acme/payments", "ref": "main" }, cloned (shallow, cached)
 *       { "name": "web",      "graph": "https://acme.github.io/web/flowgraph.json" }   published graph, not scanned
 *   ] }
 *
 * Repositories that are scanned are staged as links in one folder (orders -> ../orders) and
 * scanned as one tree, so every path carries its repository's name and calls between them
 * (HTTP, gRPC, topics, cloud resources) are matched exactly as inside one repository.
 * Published graphs were scanned the same way in their own CI (breadth scan --as web), so their
 * ids already carry the repository's name and merge as they are.
 */

export const WORKSPACE_FILE = "breadth.workspace.json";

export interface WorkspaceMember {
  name: string;
  path?: string;
  git?: string;
  ref?: string;
  graph?: string;
}

export interface Workspace {
  file: string;
  dir: string;
  repos: WorkspaceMember[];
}

const NAME = /^[A-Za-z0-9][\w.-]*$/;
const SYSTEM = "workspace";

export function loadWorkspace(file: string): Workspace {
  const abs = path.resolve(file);
  let raw: { repos?: WorkspaceMember[] };
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`could not read ${abs}: ${(err as Error).message}`);
  }
  const repos = raw.repos ?? [];
  if (!repos.length) throw new Error(`${abs}: "repos" is empty`);
  const seen = new Set<string>();
  for (const r of repos) {
    if (!r.name || !NAME.test(r.name)) throw new Error(`${abs}: repository name "${r.name ?? ""}" must be letters, digits, . _ or -`);
    if (seen.has(r.name)) throw new Error(`${abs}: two repositories are named "${r.name}"`);
    seen.add(r.name);
    if ([r.path, r.git, r.graph].filter(Boolean).length !== 1) throw new Error(`${abs}: "${r.name}" needs exactly one of path, git or graph`);
  }
  return { file: abs, dir: path.dirname(abs), repos };
}

/** breadth.workspace.json given directly, or found in the folder given. */
export function findWorkspace(target: string): string | undefined {
  if (target.endsWith(".json") && existsSync(target)) return target;
  const f = path.join(target, WORKSPACE_FILE);
  return existsSync(f) ? f : undefined;
}

export function cacheDir(...parts: string[]): string {
  const base = process.env.BREADTH_CACHE ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "breadth");
  return path.join(base, ...parts);
}

const slug = (s: string) => s.replace(/^[a-z]+:\/\//, "").replace(/[^\w.-]+/g, "_").slice(0, 80);

/** A shallow clone of url at ref in the cache, fetched again on every call. Uses git's own credentials. */
export function syncGit(url: string, ref: string | undefined, log?: (m: string) => void): string {
  const dir = cacheDir("repos", `${slug(url)}-${createHash("sha1").update(url).digest("hex").slice(0, 8)}`);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  if (!existsSync(path.join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git("init", "-q");
    git("remote", "add", "origin", url);
  }
  log?.(`fetching ${url}${ref ? ` @ ${ref}` : ""}`);
  try {
    git("fetch", "-q", "--depth", "1", "origin", ref ?? "HEAD");
  } catch (err) {
    const msg = String((err as { stderr?: Buffer }).stderr ?? (err as Error).message).trim().split("\n").pop();
    throw new Error(`could not fetch ${url}${ref ? ` @ ${ref}` : ""}: ${msg}`);
  }
  git("checkout", "-q", "--force", "FETCH_HEAD");
  return dir;
}

export interface Staged {
  /** Folder of links, one per scanned repository. */
  root: string;
  /** Excludes from each repository's own breadth.config.json, under its name. */
  exclude: string[];
  /** Published graphs to merge after the scan. */
  graphs: { name: string; source: string }[];
  /** name -> where it was read from (folder, or git url @ revision) */
  origins: Record<string, string>;
}

/**
 * Link every scanned repository into one folder. `override` points a member at another folder
 * (the pull request's checkout, or the base revision of it).
 */
export function stage(ws: Workspace, opts: { override?: Record<string, string>; log?: (m: string) => void } = {}): Staged {
  // the folder's name is the system's name on the canvas: the same for every workspace scan and
  // every published graph (scan --as), so their top-level nodes merge
  const root = cacheDir("workspaces", createHash("sha1").update(ws.file + JSON.stringify(opts.override ?? {})).digest("hex").slice(0, 12), SYSTEM);
  mkdirSync(root, { recursive: true });
  for (const e of readdirSync(root)) {
    const p = path.join(root, e);
    if (lstatSync(p).isSymbolicLink()) rmSync(p);
  }
  const out: Staged = { root, exclude: [], graphs: [], origins: {} };
  for (const r of ws.repos) {
    const local = opts.override?.[r.name];
    if (r.graph && !local) {
      out.graphs.push({ name: r.name, source: /^https?:\/\//.test(r.graph) ? r.graph : path.resolve(ws.dir, r.graph) });
      out.origins[r.name] = r.graph;
      continue;
    }
    const dir = local ?? (r.path ? path.resolve(ws.dir, r.path) : syncGit(r.git!, r.ref, opts.log));
    if (!existsSync(dir)) throw new Error(`${r.name}: ${dir} does not exist`);
    symlinkSync(dir, path.join(root, r.name), "dir");
    out.origins[r.name] = local ? dir : r.git ? `${r.git}${r.ref ? ` @ ${r.ref}` : ""}` : dir;
    if (existsSync(path.join(dir, CONFIG_FILE))) for (const x of loadConfig(dir).exclude ?? []) out.exclude.push(`${r.name}/${x.replace(/^\//, "")}`);
  }
  return out;
}

/** One repository scanned under its name, as a workspace would see it (breadth scan --as <name>). */
export function stageOne(dir: string, name: string): string {
  if (!NAME.test(name)) throw new Error(`--as ${name}: use letters, digits, . _ or -`);
  const root = cacheDir("as", createHash("sha1").update(path.resolve(dir)).digest("hex").slice(0, 12), SYSTEM);
  mkdirSync(root, { recursive: true });
  for (const e of readdirSync(root)) rmSync(path.join(root, e), { recursive: true, force: true });
  symlinkSync(path.resolve(dir), path.join(root, name), "dir");
  return root;
}

/** A published graph, from a file or URL. */
export async function loadPublished(source: string, name: string): Promise<FlowGraph> {
  let text: string;
  if (/^https?:\/\//.test(source)) {
    const headers: Record<string, string> = {};
    // A private graph: a token from the environment, never from the workspace file.
    const token = process.env.BREADTH_GRAPH_TOKEN;
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(source, { headers }).catch((err: Error) => {
      throw new Error(`${name}: cannot reach ${source}: ${err.message}`);
    });
    if (!res.ok) throw new Error(`${name}: ${res.status} from ${source}`);
    text = await res.text();
  } else text = readFileSync(source, "utf8");
  const g = JSON.parse(text) as FlowGraph;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error(`${name}: ${source} is not a breadth graph`);
  return g;
}

export interface WorkspaceScan {
  graph: FlowGraph;
  staged: Staged;
  /** Published graphs that do not look scanned under their repository's name. */
  warnings: string[];
}

/** Scan every repository of the workspace as one tree, then merge the published graphs. */
export async function scanWorkspace(ws: Workspace, opts: CollectorOptions & { names?: string[]; override?: Record<string, string> } = {}): Promise<WorkspaceScan> {
  const staged = stage(ws, { override: opts.override, log: (m) => opts.log?.info(m) });
  const scanned = ws.repos.filter((r) => !staged.graphs.some((g) => g.name === r.name));
  let graph: FlowGraph = scanned.length
    ? await runCollectors(staged.root, opts.names, { ...opts, exclude: [...(opts.exclude ?? []), ...staged.exclude] })
    : { version: SCHEMA_VERSION, nodes: [], edges: [] };
  const warnings: string[] = [];
  for (const g of staged.graphs) {
    const pub = await loadPublished(g.source, g.name);
    if (!pub.nodes.some((n) => n.source?.file?.startsWith(`${g.name}/`)) && pub.nodes.some((n) => n.source?.file)) {
      warnings.push(`${g.name}: ${g.source} was not scanned under its name (publish it with \`breadth scan --as ${g.name}\`); its paths may clash with other repositories`);
    }
    graph = mergeGraphs(graph, pub);
  }
  if (staged.graphs.length) {
    linkHttpCalls(graph);
    linkGrpcNames(graph);
    linkCodeToInfra(graph);
  }
  graph.sources = [...(graph.sources ?? []), ...ws.repos.map((r) => ({ collector: "workspace", target: `${r.name}: ${staged.origins[r.name]}`, collectedAt: new Date().toISOString() }))];
  return { graph, staged, warnings };
}
