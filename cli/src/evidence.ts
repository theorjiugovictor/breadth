import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FlowGraph, FlowNode } from "@breadth/schema";
import { evaluateSlos, sourceSnapshot, type Check, type RunRecord, type Slo, type Verdict } from "@breadth/collectors";
import { behaviourUnits, serviceFingerprint } from "@breadth/insights";
import type { LiveSource, Measure } from "./sources/index.js";

/**
 * Evidence from an experiment window: measure what the scenario's criteria name (p95, error
 * rate, availability, throughput) from a live source over the window, judge them, and record a
 * run (.breadth/runs/<id>.json) that carries the service's behaviour fingerprint, so the
 * evidence goes stale by itself when that behaviour changes.
 */

/** "2026-10-23T09:00:00Z", epoch ms, "now", "15m" or "-15m" (that long ago) -> epoch ms */
export function parseTime(s: string, now = Date.now()): number {
  if (s === "now") return now;
  const rel = s.match(/^-?(\d+(?:\.\d+)?)(s|m|h|d)(?:\s*ago)?$/);
  if (rel) return now - Number(rel[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[rel[2] as "s"];
  if (/^\d{12,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`not a time: ${s} (ISO, epoch ms, now, or 15m for 15 minutes ago)`);
  return t;
}

export function findScenario(g: FlowGraph, ref: string): FlowNode | undefined {
  const scenarios = g.nodes.filter((n) => n.role === "scenario");
  const want = ref.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return scenarios.find((n) => n.id === ref) ?? scenarios.find((n) => n.id.endsWith(`/${want}`) || n.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") === want);
}

export interface EvidenceInput {
  graph: FlowGraph;
  root: string;
  scenario: string;
  service: string;
  endpoint?: string;
  from: number;
  to: number;
  source?: LiveSource;
  /** Measurements given directly (other tools, manual runs); they win over the source's. */
  results?: Partial<Record<string, number>>;
  id?: string;
  tool?: string;
  fault?: string;
  approvedBy?: string;
  store?: string;
}

export interface EvidenceOutput {
  record: RunRecord;
  file: string;
  verdict: Verdict;
  checks: Check[];
  scenario: FlowNode;
}

export async function recordEvidence(i: EvidenceInput): Promise<EvidenceOutput> {
  const scenario = findScenario(i.graph, i.scenario);
  if (!scenario) {
    const known = i.graph.nodes.filter((n) => n.role === "scenario").map((n) => `"${n.name}"`);
    throw new Error(`no scenario "${i.scenario}" in the specs${known.length ? `; known: ${known.join(", ")}` : " (is there an openspec/ folder?)"}`);
  }
  const slos = (scenario.metadata?.slos as Slo[] | undefined) ?? [];
  if (!slos.length) throw new Error(`scenario "${scenario.name}" has no measurable criteria (write them like "p95 <= 200 ms and errors <= 1 %")`);
  let measured: Partial<Record<Measure, number>> = {};
  if (i.source?.measure) measured = await i.source.measure({ from: i.from, to: i.to, service: i.service, endpoint: i.endpoint });
  const results: Record<string, number> = {};
  for (const [k, v] of Object.entries({ ...measured, ...(i.results ?? {}) })) if (typeof v === "number" && Number.isFinite(v)) results[k] = Math.round(v * 1000) / 1000;
  const { verdict, checks } = evaluateSlos(slos, results);
  const units = behaviourUnits(i.graph);
  const fingerprint = serviceFingerprint(units, i.service);
  const snapshot = await sourceSnapshot(i.root, {});
  const id = i.id ?? `${new Date(i.from).toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${scenario.id.split("/").pop()}`;
  const record: RunRecord = JSON.parse(
    JSON.stringify({
      kind: "breadth.run",
      id,
      scenario: scenario.id,
      target: i.endpoint ?? `service:${i.service}`,
      service: i.service,
      experiment: i.tool || i.fault ? { tool: i.tool, fault: i.fault } : undefined,
      window: { start: new Date(i.from).toISOString(), end: new Date(i.to).toISOString() },
      snapshot: { revision: snapshot.revision, digest: snapshot.digest },
      fingerprint,
      approval: i.approvedBy ? { by: i.approvedBy, at: new Date().toISOString() } : undefined,
      results,
      store: i.store,
      measured_by: i.source?.name,
    }),
  );
  const dir = path.join(i.root, ".breadth", "runs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return { record, file, verdict, checks, scenario };
}
