import { assertValidGraph, mergeGraphs, type FlowGraph } from "@breadth/schema";
import { codeCollector } from "../code/index.js";
import { infraCollector } from "../infra/index.js";
import { otelCollector } from "../otel/index.js";
import { cicdCollector } from "../cicd/index.js";
import { messagingCollector } from "../messaging/index.js";
import { netflowCollector } from "../netflow/index.js";
import { orgCollector } from "../org/index.js";
import type { Collector, CollectorOptions } from "./types.js";
import { linkCodeToInfra } from "../link.js";
import { linkResilience, resilienceCollector } from "../resilience/index.js";

export const collectors: Collector[] = [
  codeCollector,
  infraCollector,
  otelCollector,
  netflowCollector,
  messagingCollector,
  cicdCollector,
  orgCollector,
  resilienceCollector,
];

export function getCollector(name: string): Collector {
  const c = collectors.find((x) => x.name === name);
  if (!c) throw new Error(`unknown collector "${name}". Available: ${collectors.map((x) => x.name).join(", ")}`);
  return c;
}

/**
 * Run collectors against a target and merge their output.
 * With no names, every implemented collector whose detect() matches runs (zero config).
 * Each collector's output is validated before merging.
 */
export async function runCollectors(target: string, names: string[] | undefined, options: CollectorOptions = {}): Promise<FlowGraph> {
  let selected: Collector[];
  if (names?.length) {
    selected = names.map(getCollector);
  } else {
    selected = [];
    for (const c of collectors) {
      if (c.implemented && c.name !== "otel" && (await c.detect(target, options))) selected.push(c);
    }
    if (!selected.length) throw new Error(`no collector recognised ${target}; try --collector code`);
  }
  const graphs: FlowGraph[] = [];
  for (const c of selected) {
    const start = Date.now();
    const g = await c.collect(target, options);
    assertValidGraph(g, `output of collector "${c.name}"`);
    options.log?.info(`${c.name}: ${g.nodes.length} nodes, ${g.edges.length} edges (${Date.now() - start} ms)`);
    graphs.push(g);
  }
  const merged = graphs.length === 1 ? graphs[0] : mergeGraphs(...graphs);
  dropPlaceholders(merged);
  const linked = linkCodeToInfra(merged);
  if (linked) options.log?.info(`linked ${linked} resource${linked === 1 ? "" : "s"} used in code to the infrastructure that defines ${linked === 1 ? "it" : "them"}`);
  const traced = linkResilience(merged);
  if (traced) options.log?.info(`linked ${traced} requirement / test / experiment reference${traced === 1 ? "" : "s"}`);
  assertValidGraph(merged, "merged graph");
  return merged;
}

/**
 * Collectors may emit placeholder nodes aliased like another collector's node (a CI job's
 * "deploys service:orders", "triggered by changes in code:dir:services/orders") so the two
 * merge. A code-folder placeholder nothing claimed is dropped with its edges; claimed ones lose
 * the flag.
 */
function dropPlaceholders(g: FlowGraph): void {
  const drop = new Set(g.nodes.filter((n) => n.metadata?.placeholder && n.id.startsWith("ci:path:")).map((n) => n.id));
  g.nodes = g.nodes.filter((n) => !drop.has(n.id));
  g.edges = g.edges.filter((e) => !drop.has(e.from.node) && !drop.has(e.to.node));
  for (const n of g.nodes) {
    if (!n.metadata?.placeholder) continue;
    if (n.id.startsWith("deploy:")) continue; // deployed but not collected: still worth showing
    const { placeholder: _p, ...rest } = n.metadata;
    n.metadata = rest;
  }
}
