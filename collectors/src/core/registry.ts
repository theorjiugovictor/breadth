import { assertValidGraph, mergeGraphs, type FlowGraph } from "@noodles/schema";
import { codeCollector } from "../code/index.js";
import { infraCollector } from "../infra/index.js";
import { otelCollector } from "../otel/index.js";
import { cicdCollector } from "../cicd/index.js";
import { messagingCollector } from "../messaging/index.js";
import { netflowCollector } from "../netflow/index.js";
import { orgCollector } from "../org/index.js";
import type { Collector, CollectorOptions } from "./types.js";

export const collectors: Collector[] = [
  codeCollector,
  infraCollector,
  otelCollector,
  netflowCollector,
  messagingCollector,
  cicdCollector,
  orgCollector,
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
  assertValidGraph(merged, "merged graph");
  return merged;
}
