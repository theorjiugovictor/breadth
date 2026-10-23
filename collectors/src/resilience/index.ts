import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION, type FlowEdge, type FlowGraph, type FlowNode } from "@breadth/schema";
import type { Collector, CollectorOptions } from "../core/types.js";
import { walkFiles } from "../core/walk.js";
import { evaluateSlos, parseChange, parseSpec, slug, type Capability, type Change, type Scenario } from "./openspec.js";

export { evaluateSlos, parseSlos, parseSpec, type Slo, type Verdict, type Check } from "./openspec.js";
export { linkResilience } from "./link.js";

/**
 * The resilience-v1 profile: from intent to evidence.
 *
 *   OpenSpec change -> capability -> requirement -> scenario (with machine-readable SLOs)
 *   code --implements--> requirement, test --verifies--> scenario, scenario --targets--> service
 *   approval --approves--> experiment --associated_with--> evidence --supports|contradicts--> requirement
 *
 * Inputs: openspec/ (specs and changes) and run records in .breadth/runs/*.json (see
 * RunRecord). References to code ("Implemented by: checkout()") are resolved after all
 * collectors merged (link.ts). Verdicts are computed here, deterministically, from the
 * scenario's criteria and the run's measurements: an LLM never decides them.
 */

export const PROFILE = "resilience-v1";

/** .breadth/runs/<id>.json, written by `breadth evidence` or by any tool that runs experiments. */
export interface RunRecord {
  kind: "breadth.run";
  id: string;
  /** Scenario id (scenario:<cap>/<req>/<scenario>), slug or name. */
  scenario: string;
  /** What the experiment hits: "service:checkout", "POST /checkout", "datastore:redis". */
  target?: string;
  /** The service whose behaviour the verdict is about (for staleness). */
  service?: string;
  experiment?: { tool?: string; fault?: string; plan?: Record<string, unknown> };
  window?: { start: string; end: string };
  snapshot?: { revision?: string; digest?: string };
  /** Behaviour fingerprint of `service` when the run happened (breadth evidence records it). */
  fingerprint?: string;
  approval?: { by: string; at?: string; hash?: string };
  /** Measurements, keyed like the SLO metrics: p95_ms, error_pct, availability_pct, ... */
  results?: Record<string, number>;
  /** Where the full evidence lives (a quality lake, an artifact URL). */
  store?: string;
}

const node = (n: FlowNode): FlowNode => n;

export function resilienceGraph(input: { capabilities: Capability[]; changes: Change[]; runs: { file: string; run: RunRecord }[]; snapshot?: { revision?: string; digest: string; files: number } }): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const add = (n: FlowNode) => {
    const prev = nodes.get(n.id);
    nodes.set(n.id, prev ? { ...prev, ...n, metadata: { ...prev.metadata, ...n.metadata } } : n);
    return n.id;
  };
  const rel = (relation: string, from: string, to: string, extra: Partial<FlowEdge> = {}) => {
    const id = `rel:${relation}:${from}->${to}`;
    if (!edges.has(id)) edges.set(id, { id, from: { node: from }, to: { node: to }, kind: "depends_on", relation, ...extra });
  };

  for (const c of input.changes) {
    add(node({ id: `change:${c.id}`, name: c.title, kind: "artifact", role: "change", layer: "resilience", description: c.why, source: { file: c.file }, metadata: { change: c.id, tasks: c.tasks } }));
  }
  const scenarios = new Map<string, { s: Scenario; req: string }>();
  for (const cap of input.capabilities) {
    add(node({ id: cap.id, name: cap.name, kind: "artifact", role: "capability", layer: "resilience", description: cap.purpose, source: { file: cap.file }, metadata: { capability: cap.id.split("spec:").pop(), ...(cap.change ? { change: cap.change } : {}) } }));
    if (cap.change) rel("contains", `change:${cap.change}`, cap.id);
    for (const r of cap.requirements) {
      add(
        node({
          id: r.id,
          name: r.name,
          kind: "artifact",
          role: "requirement",
          layer: "resilience",
          parent: nodes.has(r.id) ? nodes.get(r.id)!.parent : cap.id,
          description: r.text.slice(0, 300) || undefined,
          source: { file: cap.file, line: r.line },
          metadata: compact({
            delta: r.delta,
            change: cap.change,
            implemented_by: r.implementedBy.length ? r.implementedBy : undefined,
            verified_by: r.verifiedBy.length ? r.verifiedBy : undefined,
            targets: r.targets.length ? r.targets : undefined,
          }),
        }),
      );
      rel("contains", cap.id, r.id);
      for (const s of r.scenarios) {
        add(
          node({
            id: s.id,
            name: s.name,
            kind: "artifact",
            role: "scenario",
            layer: "resilience",
            parent: r.id,
            description: s.steps.join(" · ").slice(0, 300) || undefined,
            source: { file: cap.file, line: s.line },
            metadata: compact({ steps: s.steps, slos: s.slos.length ? s.slos : undefined, targets: s.targets.length ? s.targets : undefined, verified_by: s.verifiedBy.length ? s.verifiedBy : undefined }),
          }),
        );
        rel("has_scenario", r.id, s.id);
        scenarios.set(s.id, { s, req: r.id });
      }
    }
  }

  if (input.snapshot) {
    add(node({ id: "snapshot:source", name: `source ${input.snapshot.revision?.slice(0, 7) ?? input.snapshot.digest.slice(7, 19)}`, kind: "artifact", role: "snapshot", layer: "resilience", description: "Identity of exactly what was scanned", metadata: { ...input.snapshot } }));
  }

  // Scenario references in run records: id, "<requirement> / <scenario>" slug, or the scenario's name.
  const findScenario = (ref: string) => {
    if (scenarios.has(ref)) return scenarios.get(ref);
    const want = slug(ref);
    return [...scenarios.values()].find(({ s }) => s.id.endsWith(`/${want}`) || slug(s.name) === want || s.id.split("/").slice(-2).join("-") === want);
  };
  for (const { file, run } of input.runs) {
    const exp = `experiment:${run.id}`;
    const ev = `evidence:${run.id}`;
    const found = findScenario(run.scenario);
    const judged = found ? evaluateSlos(found.s.slos, run.results ?? {}) : { verdict: "inconclusive" as const, checks: [] };
    add(
      node({
        id: exp,
        name: run.experiment?.fault ? `${run.experiment.fault}` : `run ${run.id}`,
        kind: "artifact",
        role: "experiment",
        layer: "resilience",
        description: run.experiment?.tool ? `${run.experiment.tool} experiment` : undefined,
        source: { file },
        metadata: compact({ run: run.id, tool: run.experiment?.tool, fault: run.experiment?.fault, plan: run.experiment?.plan, window: run.window, targets: run.target ? [run.target] : undefined }),
      }),
    );
    add(
      node({
        id: ev,
        name: `${judged.verdict}: ${found?.s.name ?? run.scenario}`,
        kind: "artifact",
        role: "evidence",
        layer: "resilience",
        description: judged.checks.map((c) => `${c.metric} ${c.actual ?? "?"} ${c.op} ${c.expected}${c.ok === false ? " ✗" : c.ok ? " ✓" : ""}`).join(", ") || (found ? "no measurements for its criteria" : `scenario "${run.scenario}" not found in the specs`),
        source: { file },
        metadata: compact({
          run: run.id,
          verdict: judged.verdict,
          checks: judged.checks,
          results: run.results,
          scenario: found?.s.id ?? run.scenario,
          service: run.service,
          fingerprint: run.fingerprint,
          snapshot: run.snapshot,
          window: run.window,
          store: run.store,
        }),
      }),
    );
    rel("associated_with", exp, ev);
    if (found) {
      rel("associated_with", ev, found.s.id);
      if (judged.verdict !== "inconclusive") rel(judged.verdict, ev, found.req, { label: judged.verdict });
    }
    if (input.snapshot && run.snapshot?.digest === input.snapshot.digest) rel("associated_with", ev, "snapshot:source");
    if (run.approval) {
      const ap = `approval:${run.id}`;
      add(node({ id: ap, name: `approved by ${run.approval.by}`, kind: "artifact", role: "approval", layer: "resilience", source: { file }, metadata: compact({ ...run.approval }) }));
      rel("approves", ap, exp);
    }
    if (run.store) {
      const storeName = run.store.match(/^([\w.-]+):\/\//)?.[1] ?? run.store.split("/")[0];
      const st = `store:evidence:${storeName}`;
      add(node({ id: st, name: storeName, kind: "datastore", layer: "resilience", description: "Evidence store", metadata: { evidence_store: true } }));
      rel("stored_in", ev, st);
    }
  }
  return { version: SCHEMA_VERSION, profiles: [PROFILE], nodes: [...nodes.values()], edges: [...edges.values()] };
}

/* ---------------- reading the repository ---------------- */

/** git revision plus a digest over every scanned file's content: the identity of exactly what was mapped. */
export async function sourceSnapshot(root: string, options: CollectorOptions): Promise<{ revision?: string; digest: string; files: number }> {
  const files = (await walkFiles(root, { exclude: options.exclude, include: options.include, maxFileBytes: 5_000_000 })).sort();
  const all = createHash("sha256");
  for (const f of files) {
    const text = options.overlay?.get(path.join(root, f));
    const body = text !== undefined ? Buffer.from(text) : await fs.readFile(path.join(root, f)).catch(() => undefined);
    if (!body) continue;
    all.update(`${f}\0${createHash("sha256").update(body).digest("hex")}\n`);
  }
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root });
  const revision = r.status === 0 ? r.stdout.toString().trim() : undefined;
  return { revision, digest: `sha256:${all.digest("hex")}`, files: files.length };
}

async function read(root: string, rel: string, options: CollectorOptions): Promise<string | undefined> {
  const abs = path.join(root, rel);
  return options.overlay?.get(abs) ?? (await fs.readFile(abs, "utf8").catch(() => undefined));
}

async function inputs(target: string, options: CollectorOptions) {
  const root = target;
  const files = await walkFiles(root, { exclude: options.exclude, include: options.include, filter: (f) => /(^|\/)openspec\/.+\.md$/.test(f) || /(^|\/)\.breadth\/runs\/[^/]+\.json$/.test(f) });
  // .breadth/ is a dot folder some walkers skip: look for runs explicitly too
  const runFiles = await walkFiles(path.join(root, ".breadth", "runs"), { filter: (f) => f.endsWith(".json") }).catch(() => [] as string[]);
  const capabilities: Capability[] = [];
  const changes: Change[] = [];
  for (const f of files) {
    const spec = f.match(/(?:^|\/)openspec\/(?:changes\/([^/]+)\/)?specs\/([^/]+)\/spec\.md$/);
    if (spec && !/\/archive\//.test(f)) {
      const text = await read(root, f, options);
      if (text) capabilities.push(parseSpec(text, f, spec[2], spec[1]));
    }
    const prop = f.match(/(?:^|\/)openspec\/changes\/([^/]+)\/proposal\.md$/);
    if (prop && prop[1] !== "archive") changes.push(parseChange(prop[1], await read(root, f, options), await read(root, f.replace(/proposal\.md$/, "tasks.md"), options), f));
  }
  const runs: { file: string; run: RunRecord }[] = [];
  for (const f of [...new Set([...files.filter((x) => x.endsWith(".json")), ...runFiles.map((x) => `.breadth/runs/${x}`)])]) {
    try {
      const run = JSON.parse((await read(root, f, options)) ?? "") as RunRecord;
      if (run?.kind === "breadth.run" && run.id && run.scenario) runs.push({ file: f, run });
      else options.log?.warn(`resilience: ${f} is not a breadth.run record (needs kind, id, scenario)`);
    } catch {
      options.log?.warn(`resilience: could not parse ${f}`);
    }
  }
  return { capabilities, changes, runs };
}

export const resilienceCollector: Collector = {
  name: "resilience",
  description: "OpenSpec requirements and scenarios, tests that verify them, experiments and evidence (.breadth/runs) with verdicts",
  implemented: true,
  async detect(target) {
    for (const p of ["openspec", path.join(".breadth", "runs")]) {
      if (await fs.stat(path.join(target, p)).then((s) => s.isDirectory(), () => false)) return true;
    }
    return false;
  },
  async collect(target, options = {}) {
    const root = (await fs.stat(target)).isFile() ? path.dirname(target) : target;
    const inp = await inputs(root, options);
    const snapshot = await sourceSnapshot(root, options);
    const g = resilienceGraph({ ...inp, snapshot });
    options.log?.info(`resilience: ${inp.capabilities.reduce((n, c) => n + c.requirements.length, 0)} requirements, ${inp.runs.length} runs`);
    g.sources = [{ collector: "resilience", target: path.resolve(target), collectedAt: new Date().toISOString() }];
    return g;
  },
};

function compact(o: Record<string, unknown>) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === null || o[k] === "") delete o[k];
  return o;
}
