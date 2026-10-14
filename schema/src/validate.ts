import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../flowgraph.schema.json" with { type: "json" };
import type { FlowGraph } from "./types.js";

export { schema };

export interface ValidationResult {
  valid: boolean;
  /** Schema errors plus referential problems (dangling parents/edges, duplicate ids). */
  errors: string[];
}

let compiled: ReturnType<Ajv2020["compile"]> | undefined;

function validator() {
  if (!compiled) {
    // ajv's CJS/ESM interop differs between bundlers; unwrap defaults defensively.
    const AjvCtor = ((Ajv2020 as unknown as { default?: unknown }).default ?? Ajv2020) as typeof Ajv2020;
    const formats = ((addFormats as unknown as { default?: unknown }).default ?? addFormats) as typeof addFormats;
    const ajv = new AjvCtor({ allErrors: true, strict: false });
    formats(ajv);
    compiled = ajv.compile(schema);
  }
  return compiled;
}

/** Validate against the JSON Schema, then check references between nodes, edges and steps. */
export function validateGraph(graph: unknown): ValidationResult {
  const validate = validator();
  const errors: string[] = [];
  if (!validate(graph)) {
    for (const e of validate.errors ?? []) {
      errors.push(`${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
    }
    return { valid: false, errors };
  }

  const g = graph as FlowGraph;
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  for (const n of g.nodes) {
    if (n.parent !== undefined && !ids.has(n.parent)) errors.push(`node "${n.id}" has unknown parent "${n.parent}"`);
    if (n.parent === n.id) errors.push(`node "${n.id}" is its own parent`);
  }
  const edgeIds = new Set<string>();
  for (const e of g.edges) {
    if (edgeIds.has(e.id)) errors.push(`duplicate edge id "${e.id}"`);
    edgeIds.add(e.id);
    if (!ids.has(e.from.node)) errors.push(`edge "${e.id}" has unknown source node "${e.from.node}"`);
    if (!ids.has(e.to.node)) errors.push(`edge "${e.id}" has unknown target node "${e.to.node}"`);
  }
  for (const x of g.executions ?? []) {
    for (const s of x.steps) {
      if (!ids.has(s.node)) errors.push(`execution "${x.id}" step "${s.id}" has unknown node "${s.node}"`);
    }
  }
  for (const i of g.insights ?? []) {
    for (const n of i.nodes) if (!ids.has(n)) errors.push(`insight "${i.id}" has unknown node "${n}"`);
  }
  if (errors.length === 0) {
    const cycle = findParentCycle(g);
    if (cycle) errors.push(`parent cycle: ${cycle.join(" > ")}`);
  }
  return { valid: errors.length === 0, errors };
}

function findParentCycle(g: FlowGraph): string[] | undefined {
  const parent = new Map(g.nodes.map((n) => [n.id, n.parent]));
  const done = new Set<string>();
  for (const n of g.nodes) {
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = n.id;
    while (cur !== undefined && !done.has(cur)) {
      if (seen.has(cur)) return [...path.slice(path.indexOf(cur)), cur];
      seen.add(cur);
      path.push(cur);
      cur = parent.get(cur);
    }
    for (const p of path) done.add(p);
  }
  return undefined;
}

export function assertValidGraph(graph: unknown, label = "flowgraph"): asserts graph is FlowGraph {
  const r = validateGraph(graph);
  if (!r.valid) {
    const shown = r.errors.slice(0, 20).join("\n  ");
    const more = r.errors.length > 20 ? `\n  ... and ${r.errors.length - 20} more` : "";
    throw new Error(`${label} is not a valid flowgraph:\n  ${shown}${more}`);
  }
}
