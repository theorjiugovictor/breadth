import type { FlowEdge, FlowGraph, FlowNode } from "@breadth/schema";
import { slug } from "./openspec.js";

/**
 * After all collectors merged: connect requirements and scenarios to what implements, verifies
 * and is targeted by them, from references written in the spec and markers in test code.
 *
 *   Implemented by: checkout(), workload/app.py, POST /checkout      code --implements--> requirement
 *   Verified by: tests/test_workload.py::test_redis_fault            test --verifies--> scenario
 *   Target: service checkout, datastore:redis                        scenario --targets--> service
 *   @pytest.mark.requirement("checkout-recovers-...")  /  @Verifies("...")  /  docstring "verifies: ..."
 *
 * A reference matches: a route ("POST /checkout"), a file or file#function, path::test (pytest),
 * an id or alias (service:checkout, datastore:redis), "service X", a function name (unique,
 * tests preferred for "verified by"). Unresolved references are kept on the node as
 * metadata.unresolved so the gap is visible. Returns how many edges were added.
 */
export function linkResilience(graph: FlowGraph): number {
  const reqs = graph.nodes.filter((n) => n.kind === "artifact" && (n.role === "requirement" || n.role === "scenario"));
  if (!reqs.length) return 0;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const byAlias = new Map<string, string>();
  for (const n of graph.nodes) for (const a of n.aliases ?? []) if (!byAlias.has(a)) byAlias.set(a, n.id);
  const fns = graph.nodes.filter((n) => n.kind === "function");
  const isTest = (n: FlowNode) => /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]+$|_test\.(go|py)$|\.(test|spec)\.[jt]sx?$|Test\.java$/.test(n.source?.file ?? "") || /^test/i.test(n.name);

  const resolve = (ref: string, prefer?: "test"): string[] => {
    const r = ref.trim().replace(/\(\)$/, "");
    if (byId.has(r)) return [r];
    if (byAlias.has(r)) return [byAlias.get(r)!];
    const route = r.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)$/i);
    if (route) return graph.nodes.filter((n) => n.kind === "network_endpoint" && n.name.toUpperCase() === `${route[1].toUpperCase()} ${route[2].toUpperCase()}`).map((n) => n.id);
    const svc = r.match(/^(?:the\s+)?service\s+([\w.-]+)$/i);
    if (svc) {
      const id = byAlias.get(`service:${svc[1]}`) ?? graph.nodes.find((n) => n.kind === "service" && n.name === svc[1])?.id;
      return id ? [id] : [];
    }
    // tests/test_x.py::test_name (pytest), file.py#qual, file.py
    const [file, member] = r.split(/::|#/);
    if (/\.\w+$/.test(file)) {
      const f = graph.nodes.find((n) => n.id === `code:file:${file}` || (n.source?.file === file && n.metadata?.subkind === "file")) ?? graph.nodes.find((n) => n.id.startsWith("code:file:") && n.id.endsWith(`/${file}`));
      if (!f) return [];
      if (!member) return [f.id];
      const path = f.id.slice("code:file:".length);
      const fn = byId.get(`code:fn:${path}#${member}`) ?? fns.find((n) => n.source?.file === path && (n.name === member || n.id.endsWith(`.${member}`)));
      return fn ? [fn.id] : [];
    }
    // a function by name (Class.method or method)
    const name = r.split(".").pop()!;
    let hits = fns.filter((n) => n.name === name && (!r.includes(".") || n.id.endsWith(`#${r}`)));
    if (prefer === "test" && hits.some(isTest)) hits = hits.filter(isTest);
    else if (!prefer && hits.some((n) => !isTest(n))) hits = hits.filter((n) => !isTest(n));
    return hits.length <= 3 ? hits.map((n) => n.id) : [];
  };

  const out = new Map(graph.edges.map((e) => [e.id, e]));
  let added = 0;
  const rel = (relation: string, from: string, to: string) => {
    const id = `rel:${relation}:${from}->${to}`;
    if (out.has(id) || from === to) return;
    out.set(id, { id, from: { node: from }, to: { node: to }, kind: "depends_on", relation } as FlowEdge);
    added++;
  };
  for (const n of reqs) {
    const m = n.metadata ?? {};
    const unresolved: string[] = [];
    const each = (refs: unknown, fn: (ids: string[], ref: string) => void, prefer?: "test") => {
      for (const ref of (refs as string[] | undefined) ?? []) {
        const ids = resolve(ref, prefer);
        if (ids.length) fn(ids, ref);
        else unresolved.push(ref);
      }
    };
    each(m.implemented_by, (ids) => ids.forEach((id) => rel("implements", id, n.id)));
    each(m.verified_by, (ids) => ids.forEach((id) => rel("verifies", id, n.id)), "test");
    each(m.targets, (ids) => ids.forEach((id) => rel("targets", n.id, id)));
    if (unresolved.length) n.metadata = { ...m, unresolved };
  }

  // Markers in test code: @pytest.mark.requirement("..."), @Verifies("..."), docstring "verifies: ..."
  const findReq = (ref: string) => {
    const s = slug(ref);
    return reqs.find((r) => r.id === ref || r.id.endsWith(`/${s}`) || slug(r.name) === s);
  };
  for (const f of fns) {
    const marks: string[] = [];
    for (const d of (f.metadata?.decorators as string[] | undefined) ?? []) {
      const m = d.match(/(?:requirement|verifies|scenario|Requirement|Verifies|Scenario)\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
      if (m) marks.push(m[1]);
    }
    const doc = f.description?.match(/\bverifies:\s*(.+)$/i)?.[1];
    if (doc) marks.push(...doc.split(/,\s*/));
    for (const mark of marks) {
      const r = findReq(mark.trim());
      if (r) rel("verifies", f.id, r.id);
    }
  }

  // Experiments target what they hit.
  for (const n of graph.nodes) {
    if (n.role !== "experiment") continue;
    for (const ref of (n.metadata?.targets as string[] | undefined) ?? []) for (const id of resolve(ref)) rel("targets", n.id, id);
  }
  graph.edges = [...out.values()];
  return added;
}
