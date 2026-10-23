import type { FlowGraph, FlowNode } from "@breadth/schema";
import { endpointKey, type LiveStat } from "./types.js";

export interface LiveInfo {
  rpm: number;
  p95_ms?: number;
  error_pct?: number;
  source: string;
  /** "1h": the window the numbers cover */
  window: string;
  at: string;
}

/**
 * Write live traffic onto the graph: metadata.live on endpoints (matched by method and route)
 * and on services (summed over their endpoints, or the backend's own service totals).
 * Returns how many stats found a node.
 */
export function applyLiveStats(graph: FlowGraph, stats: LiveStat[], source: string, window: string): number {
  const at = new Date().toISOString();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const serviceNode = (name: string): FlowNode | undefined =>
    graph.nodes.find((n) => n.kind === "service" && (n.aliases?.includes(`service:${name}`) || n.name === name || n.id === `service:${name}`));
  const within = (n: FlowNode, svc: FlowNode) => {
    const seen = new Set<string>();
    let cur: FlowNode | undefined = n;
    while (cur && !seen.has(cur.id)) {
      if (cur.id === svc.id) return true;
      seen.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return n.metadata?.service === svc.name;
  };
  const routes = graph.nodes.filter((n) => n.kind === "network_endpoint" && /^[A-Z*]+ \//.test(n.name));
  let matched = 0;
  const perService = new Map<string, LiveStat[]>();
  for (const s of stats) {
    const svc = serviceNode(s.service);
    if (s.endpoint) {
      const key = endpointKey(s.endpoint);
      const route = routes.find((r) => endpointKey(r.name) === key && (!svc || within(r, svc))) ?? routes.find((r) => endpointKey(r.name) === key);
      if (route) {
        route.metadata = { ...route.metadata, live: info(s, source, window, at) };
        matched++;
      }
      if (svc) perService.set(svc.id, [...(perService.get(svc.id) ?? []), s]);
    } else if (svc) {
      svc.metadata = { ...svc.metadata, live: info(s, source, window, at) };
      matched++;
    }
  }
  // Services without their own totals: the sum of their endpoints.
  for (const [id, list] of perService) {
    const svc = byId.get(id)!;
    if ((svc.metadata?.live as LiveInfo | undefined)?.at === at) continue;
    const rpm = list.reduce((a, s) => a + s.rpm, 0);
    const errors = list.reduce((a, s) => a + s.rpm * ((s.error_pct ?? 0) / 100), 0);
    const p95 = Math.max(...list.map((s) => s.p95_ms ?? 0));
    svc.metadata = { ...svc.metadata, live: info({ service: svc.name, rpm, error_pct: rpm ? (errors / rpm) * 100 : undefined, p95_ms: p95 || undefined }, source, window, at) };
  }
  return matched;
}

function info(s: LiveStat, source: string, window: string, at: string): LiveInfo {
  const round = (v: number | undefined, d = 1) => (v === undefined || Number.isNaN(v) ? undefined : Math.round(v * 10 ** d) / 10 ** d);
  return JSON.parse(JSON.stringify({ rpm: round(s.rpm), p95_ms: round(s.p95_ms), error_pct: round(s.error_pct, 2), source, window, at }));
}

/** "1.2k req/min, p95 180 ms, 3.1% errors" */
export function liveText(l: LiveInfo | undefined): string | undefined {
  if (!l) return undefined;
  const rpm = l.rpm >= 1000 ? `${(l.rpm / 1000).toFixed(1)}k` : l.rpm >= 10 ? String(Math.round(l.rpm)) : String(l.rpm);
  return [`${rpm} req/min`, l.p95_ms !== undefined ? `p95 ${Math.round(l.p95_ms)} ms` : "", l.error_pct ? `${l.error_pct}% errors` : ""].filter(Boolean).join(", ");
}
