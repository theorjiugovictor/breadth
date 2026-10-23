import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FlowGraph } from "@breadth/schema";
import { behaviourUnits, type Unit } from "@breadth/insights";

export { behaviourUnits, type Unit };

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
