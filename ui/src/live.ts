import { useEffect, useRef, useState } from "react";
import { IS_PAGES, parseGraph, type Loaded } from "./data";

/** What `breadth serve` / `breadth watch` report at /api/info. */
export interface ServerInfo {
  live: boolean;
  version: number;
  target?: string;
  llm: { name: string; remote: boolean } | null;
}

export type NodeRef = { id: string; name: string; kind: string; file?: string };
export type InsightRef = { id: string; title: string; severity: string; nodes: string[] };

/** Mirrors ActivityEntry in cli/src/live.ts. */
export interface ActivityEntry {
  id: number;
  at: number;
  kind: "change" | "task" | "error";
  agent?: string;
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
  narration?: string;
  message?: string;
  unsaved?: boolean;
}

export interface GraphChange {
  version: number;
  added: string[];
  changed: string[];
  removed: string[];
}

export interface AgentStatus {
  agent: string;
  tool?: string;
  event?: string;
  files: string[];
  at: number;
}

export interface LiveState {
  connected: boolean;
  activity: ActivityEntry[];
  /** The latest structural change (not set for quiet refreshes). */
  change?: GraphChange;
  agent?: AgentStatus;
  target?: string;
}

/** The local server's capabilities; undefined on static hosting or when no server answers. */
export async function fetchInfo(): Promise<ServerInfo | undefined> {
  if (IS_PAGES) return undefined;
  try {
    const res = await fetch("./api/info", { cache: "no-store" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return undefined;
    return (await res.json()) as ServerInfo;
  } catch {
    return undefined;
  }
}

/**
 * Follows a live session: keeps the activity feed, and re-fetches the graph whenever the
 * server reports a new version.
 */
export function useLive(enabled: boolean, onGraph: (loaded: Loaded) => void): LiveState {
  const [state, setState] = useState<LiveState>({ connected: false, activity: [] });
  const onGraphRef = useRef(onGraph);
  onGraphRef.current = onGraph;

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let fetching: Promise<void> = Promise.resolve();
    const refetch = (change?: GraphChange) => {
      // Serialise fetches so an older graph never lands after a newer one.
      fetching = fetching.then(async () => {
        try {
          const res = await fetch("./flowgraph.json", { cache: "no-store" });
          if (!res.ok || closed) return;
          const loaded = parseGraph(await res.text(), "flowgraph.json");
          onGraphRef.current({ ...loaded, origin: "live" });
          if (change) setState((s) => ({ ...s, change }));
        } catch {
          /* the next event retries */
        }
      });
    };

    fetch("./api/activity", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((activity: ActivityEntry[]) => !closed && setState((s) => ({ ...s, activity: mergeActivity(activity, s.activity) })))
      .catch(() => {});

    const es = new EventSource("./api/events");
    let seen = 0;
    es.addEventListener("open", () => setState((s) => ({ ...s, connected: true })));
    es.addEventListener("error", () => setState((s) => ({ ...s, connected: false })));
    es.addEventListener("hello", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { version: number; target?: string };
      setState((s) => ({ ...s, connected: true, target: d.target }));
      // Reconnected after missing updates: catch up.
      if (seen && d.version !== seen) refetch();
      seen = d.version;
    });
    es.addEventListener("graph", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as GraphChange & { quiet?: boolean };
      seen = d.version;
      refetch(d.quiet ? undefined : { version: d.version, added: d.added ?? [], changed: d.changed ?? [], removed: d.removed ?? [] });
    });
    es.addEventListener("activity", (e) => {
      const entry = JSON.parse((e as MessageEvent).data) as ActivityEntry;
      setState((s) => ({ ...s, activity: mergeActivity([entry], s.activity) }));
    });
    es.addEventListener("agent", (e) => {
      const agent = JSON.parse((e as MessageEvent).data) as AgentStatus;
      setState((s) => ({ ...s, agent }));
    });
    return () => {
      closed = true;
      es.close();
    };
  }, [enabled]);

  return state;
}

/** Newest first; an entry seen again (for example once narrated) replaces the old copy. */
function mergeActivity(incoming: ActivityEntry[], current: ActivityEntry[]): ActivityEntry[] {
  const byId = new Map(current.map((a) => [a.id, a]));
  for (const a of incoming) byId.set(a.id, a);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, 300);
}

/** Ask the local LLM provider to explain a node. */
export async function explainNode(id: string): Promise<{ text: string; by: string; remote: boolean }> {
  const res = await fetch(`./api/explain?node=${encodeURIComponent(id)}`, { headers: { "x-breadth": "1" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `explain failed (${res.status})`);
  return body;
}
