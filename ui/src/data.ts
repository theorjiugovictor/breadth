import { validateGraph, type FlowGraph } from "@noodles/schema";

declare const __NOODLES_PAGES__: boolean;
export const IS_PAGES = typeof __NOODLES_PAGES__ !== "undefined" && __NOODLES_PAGES__;

export interface DemoEntry {
  file: string;
  title: string;
  description?: string;
}

export interface Loaded {
  graph: FlowGraph;
  name: string;
  warnings: string[];
}

export function parseGraph(text: string, name: string): Loaded {
  const json = JSON.parse(text);
  const r = validateGraph(json);
  if (!r.valid && !(json && Array.isArray(json.nodes) && Array.isArray(json.edges))) {
    throw new Error(`${name} is not a flowgraph:\n${r.errors.slice(0, 5).join("\n")}`);
  }
  return { graph: json as FlowGraph, name, warnings: r.valid ? [] : r.errors };
}

async function tryFetch(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return undefined;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/html")) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

/** ?graph=<url>, then ./flowgraph.json (noodles serve), then the bundled demo list. */
export async function loadInitial(): Promise<{ loaded?: Loaded; demos: DemoEntry[] }> {
  const params = new URLSearchParams(location.search);
  const demosText = await tryFetch("./graphs/index.json");
  const demos: DemoEntry[] = demosText ? JSON.parse(demosText) : [];
  const explicit = params.get("graph");
  const candidates = explicit ? [explicit] : ["./flowgraph.json", ...demos.map((d) => `./graphs/${d.file}`)];
  for (const url of candidates) {
    const text = await tryFetch(url);
    if (text) return { loaded: parseGraph(text, url.split("/").pop() ?? url), demos };
  }
  return { demos };
}

export async function loadDemo(d: DemoEntry): Promise<Loaded> {
  const text = await tryFetch(`./graphs/${d.file}`);
  if (!text) throw new Error(`could not load ${d.file}`);
  return parseGraph(text, d.file);
}

/** Source snippet from `noodles serve` (absent on static hosting). */
export async function fetchSource(file: string, line: number, end: number): Promise<{ lines: string[]; start: number; path?: string } | undefined> {
  if (IS_PAGES) return undefined;
  const text = await tryFetch(`./api/source?file=${encodeURIComponent(file)}&start=${Math.max(1, line - 3)}&end=${end + 3}`);
  return text ? JSON.parse(text) : undefined;
}
