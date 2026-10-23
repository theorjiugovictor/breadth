import type { FlowEdge, FlowGraph, FlowNode } from "@breadth/schema";

/**
 * Behaviour units and their fingerprints: a function, an endpoint or a significant
 * infrastructure resource, fingerprinted by what it does (signature, calls, reads, writes,
 * exposure, settings), not where its lines are. Shared by the comprehension ledger (what has
 * been reviewed) and evidence (what a verdict was about).
 */

export interface Unit {
  id: string;
  node: FlowNode;
  fp: string;
  /** 3: does I/O, exposes or holds data; 2: reads or is an endpoint; 1: plain logic */
  weight: number;
  service: string;
}

function fnv(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

const BEHAVIOUR_EDGES = new Set(["call", "read", "write", "event", "network", "data"]);
/** Terraform plumbing whose meaning lives in what it connects (already part of those units). */
const PLUMBING = /(_attachment|_association|_rule|_route|_route_table\w*|_subnet\w*|_version|_acl|_public_access_block|_ownership_controls|_versioning|_lifecycle\w*|_notification|_alias|_record|_policy_document)$/;

/** The behaviour units of a graph, each with a fingerprint of what it does. */
export function behaviourUnits(g: FlowGraph): Map<string, Unit> {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const touching = new Map<string, FlowEdge[]>();
  for (const e of g.edges) {
    if (!BEHAVIOUR_EDGES.has(e.kind) || e.metadata?.diff === "removed") continue;
    for (const id of new Set([e.from.node, e.to.node])) touching.set(id, [...(touching.get(id) ?? []), e]);
  }
  const serviceOf = (n: FlowNode): string => {
    if (n.metadata?.platform === "terraform") return "infrastructure";
    let cur: FlowNode | undefined = n;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (cur.kind === "service" || cur.kind === "system") return cur.name;
      seen.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return "other";
  };
  const out = new Map<string, Unit>();
  for (const n of g.nodes) {
    if (n.metadata?.diff === "removed") continue;
    const tf = n.metadata?.platform === "terraform";
    const isFn = n.kind === "function" && n.layer === "code";
    const isRoute = n.kind === "network_endpoint" && n.id.startsWith("route:");
    const isInfra = tf && n.kind !== "module" && n.kind !== "system" && !PLUMBING.test(String(n.metadata?.type ?? ""));
    if (!isFn && !isRoute && !isInfra) continue;
    // What the unit does itself: outgoing effects, what it reads, being exposed as an endpoint.
    // Not who calls it: a new caller is not a change in its behaviour. Infrastructure keeps
    // both directions (who can reach or touch a resource is part of what it is).
    const own = (e: FlowEdge) => isInfra || e.from.node === n.id || e.kind === "read" || byId.get(e.from.node)?.kind === "network_endpoint";
    const edges = (touching.get(n.id) ?? [])
      .filter(own)
      .map((e) => {
        const other = e.from.node === n.id ? e.to.node : e.from.node;
        const dir = e.from.node === n.id ? ">" : "<";
        return `${e.kind}${dir}${other}${e.label ? `:${e.label}` : ""}${e.loop ? ":loop" : ""}`;
      })
      .sort();
    const m = n.metadata ?? {};
    const shape = isFn
      ? [n.name, (n.inputs ?? []).map((p) => p.name), edges]
      : isRoute
        ? [n.name, edges]
        : [m.type, m.settings, m.public, m.encrypted, m.iam_broad, edges];
    const io = (touching.get(n.id) ?? []).some((e) => {
      if (e.kind === "write" || e.kind === "event") return true;
      const other = byId.get(e.from.node === n.id ? e.to.node : e.from.node);
      return e.kind === "call" && (other?.kind === "external_api" || other?.kind === "network_endpoint") && e.from.node === n.id;
    });
    const reads = (touching.get(n.id) ?? []).some((e) => e.kind === "read" && e.to.node === n.id);
    const weight = isInfra ? (n.kind === "datastore" || n.kind === "queue" || m.iam_broad || m.public || String(m.type).startsWith("aws_iam") ? 3 : 1) : io ? 3 : reads || isRoute ? 2 : 1;
    out.set(n.id, { id: n.id, node: n, fp: fnv(JSON.stringify(shape)), weight, service: serviceOf(n) });
  }
  return out;
}


/** One fingerprint for everything a service does: changes when any of its units' behaviour changes. */
export function serviceFingerprint(units: Map<string, Unit>, service: string): string | undefined {
  const fps = [...units.values()].filter((u) => u.service === service).map((u) => `${u.id}=${u.fp}`).sort();
  return fps.length ? fnv(fps.join("\n")) : undefined;
}
