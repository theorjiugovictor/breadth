import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FlowEdge, FlowGraph, FlowNode } from "@breadth/schema";

/**
 * Comprehension debt, measured: which behaviour in the system a person has looked at.
 *
 * A behaviour unit is a function, an endpoint or a significant infrastructure resource. Its
 * fingerprint covers what it does (its signature, the calls it makes, what it reads, writes,
 * publishes and exposes, its settings), not where its lines are. `breadth review` records the
 * fingerprints someone has reviewed in .breadth/ledger.json (commit it: the team shares it).
 * When behaviour changes, its fingerprint changes and it counts as unreviewed again.
 */

export const LEDGER_FILE = ".breadth/ledger.json";

export interface Ledger {
  version: 1;
  /** unit id -> the fingerprint that was reviewed */
  reviewed: Record<string, { fp: string; at: string; by?: string }>;
  /** `breadth debt --record` snapshots, oldest first */
  history: DebtSnapshot[];
}

export interface DebtSnapshot {
  at: string;
  ref?: string;
  units: number;
  unreviewed: number;
  /** Weighted unreviewed share, 0..100 (I/O and exposure weigh more than plain logic). */
  debt: number;
}

export interface Unit {
  id: string;
  node: FlowNode;
  fp: string;
  /** 3: does I/O, exposes or holds data; 2: reads or is an endpoint; 1: plain logic */
  weight: number;
  service: string;
}

export function emptyLedger(): Ledger {
  return { version: 1, reviewed: {}, history: [] };
}

export function loadLedger(file: string): Ledger {
  if (!existsSync(file)) return emptyLedger();
  const l = JSON.parse(readFileSync(file, "utf8")) as Ledger;
  return { version: 1, reviewed: l.reviewed ?? {}, history: l.history ?? [] };
}

export function saveLedger(file: string, l: Ledger): void {
  mkdirSync(path.dirname(file), { recursive: true });
  // sorted keys: stable diffs when several people review
  const reviewed = Object.fromEntries(Object.entries(l.reviewed).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(file, JSON.stringify({ version: 1, reviewed, history: l.history.slice(-200) }, null, 1) + "\n");
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

export interface DebtReport {
  units: number;
  unreviewed: number;
  /** weighted unreviewed share, 0..100 */
  debt: number;
  byService: { service: string; units: number; unreviewed: number; debt: number }[];
  /** unreviewed units, riskiest first */
  open: Unit[];
}

export function computeDebt(units: Map<string, Unit>, ledger: Ledger): DebtReport {
  const isReviewed = (u: Unit) => ledger.reviewed[u.id]?.fp === u.fp;
  const groups = new Map<string, Unit[]>();
  for (const u of units.values()) groups.set(u.service, [...(groups.get(u.service) ?? []), u]);
  const pct = (list: Unit[]) => {
    const total = list.reduce((s, u) => s + u.weight, 0);
    const open = list.filter((u) => !isReviewed(u)).reduce((s, u) => s + u.weight, 0);
    return total ? Math.round((open / total) * 1000) / 10 : 0;
  };
  const all = [...units.values()];
  const open = all.filter((u) => !isReviewed(u));
  return {
    units: all.length,
    unreviewed: open.length,
    debt: pct(all),
    byService: [...groups]
      .map(([service, list]) => ({ service, units: list.length, unreviewed: list.filter((u) => !isReviewed(u)).length, debt: pct(list) }))
      .sort((a, b) => b.debt - a.debt || b.units - a.units),
    open: open.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id)),
  };
}

/** Record the current fingerprints of these units as reviewed. Returns how many changed in the ledger. */
export function markReviewed(ledger: Ledger, units: Iterable<Unit>, by?: string): number {
  let n = 0;
  const at = new Date().toISOString();
  for (const u of units) {
    if (ledger.reviewed[u.id]?.fp === u.fp) continue;
    ledger.reviewed[u.id] = { fp: u.fp, at, ...(by ? { by } : {}) };
    n++;
  }
  return n;
}

/** Units a diff touched: added or changed nodes, and both ends of added or removed edges. */
export function unitsInDiff(units: Map<string, Unit>, d: { added: string[]; changed: string[]; edgesAdded: string[]; edgesRemoved: string[] }, g: FlowGraph): Unit[] {
  const ids = new Set([...d.added, ...d.changed]);
  const edgeIds = new Set([...d.edgesAdded, ...d.edgesRemoved]);
  for (const e of g.edges) if (edgeIds.has(e.id)) ids.add(e.from.node).add(e.to.node);
  return [...ids].map((id) => units.get(id)).filter((u): u is Unit => !!u);
}
