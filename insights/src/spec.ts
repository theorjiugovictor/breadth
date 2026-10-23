import type { BehaviorChange, FlowGraph, FlowNode, GraphDiffInfo, SpecCheck } from "@breadth/schema";

/**
 * A pull request checked against the spec change it implements (OpenSpec change, Spec Kit
 * feature, Kiro spec), deterministically: which change it is, how far along it is, and which
 * behaviour changes fall outside everything that change says it touches.
 *
 * Only for repositories that keep specs: with no change nodes in the graph this returns
 * undefined and nothing about specs appears anywhere.
 */

export interface SpecHints {
  /** Git branch of the pull request (Spec Kit names branches after the feature). */
  branch?: string;
  /** PR title and description (a change id mentioned there links it). */
  text?: string;
  /** Explicit change id (--spec-change). */
  change?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function checkSpec(before: FlowGraph, after: FlowGraph, d: Pick<GraphDiffInfo, "added" | "changed" | "removed" | "edgesAdded" | "edgesRemoved" | "changes">, hints: SpecHints = {}): SpecCheck | undefined {
  const changes = after.nodes.filter((n) => n.role === "change" && !n.metadata?.archived);
  if (!changes.length) return undefined;
  const byId = new Map(after.nodes.map((n) => [n.id, n]));
  const beforeIds = new Map(before.nodes.map((n) => [n.id, n]));
  const changeOf = (n: FlowNode | undefined): string | undefined => {
    const seen = new Set<string>();
    let cur = n;
    while (cur && !seen.has(cur.id)) {
      if (cur.role === "change") return cur.id;
      if (cur.metadata?.change && (cur.role === "requirement" || cur.role === "capability" || cur.role === "scenario")) return `change:${String(cur.metadata.change)}`;
      seen.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return undefined;
  };
  const requirementsOf = (cid: string) => after.nodes.filter((n) => n.role === "requirement" && changeOf(n) === cid);

  // 1. Which change(s) this PR implements, and why we think so.
  const reasons = new Map<string, Set<string>>();
  const because = (cid: string, why: string) => {
    if (!byId.has(cid)) return;
    if (!reasons.has(cid)) reasons.set(cid, new Set());
    reasons.get(cid)!.add(why);
  };
  if (hints.change) for (const c of changes) if (c.id === `change:${hints.change}` || norm(String(c.metadata?.change)) === norm(hints.change)) because(c.id, "named with --spec-change");
  for (const id of [...d.added, ...d.changed]) {
    const n = byId.get(id);
    if (!n || n.kind !== "artifact") continue;
    const cid = changeOf(n);
    if (cid) because(cid, d.added.includes(id) && n.role === "change" ? "the pull request adds it" : "the pull request edits it");
  }
  const edgeIds = new Set(d.edgesAdded);
  for (const e of after.edges) if (edgeIds.has(e.id) && e.relation === "implements") {
    const cid = changeOf(byId.get(e.to.node));
    if (cid) because(cid, "code in the pull request implements its requirements");
  }
  if (hints.branch) {
    const b = norm(hints.branch.replace(/^refs\/heads\//, ""));
    for (const c of changes) {
      const id = norm(String(c.metadata?.change ?? ""));
      const branch = c.metadata?.branch ? norm(String(c.metadata.branch)) : undefined;
      if (id && (b === id || b.endsWith(`-${id}`) || b.endsWith(`/${id}`) || b.includes(id) || branch === b)) because(c.id, `branch ${hints.branch}`);
    }
  }
  if (hints.text) for (const c of changes) if (c.metadata?.change && new RegExp(`(^|[^a-z0-9-])${String(c.metadata.change).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9-]|$)`, "i").test(hints.text)) because(c.id, "mentioned in the pull request");

  const interesting = d.changes.filter((c) => c.severity !== "low" && !c.kind.startsWith("insight:") && !["implements", "verifies", "requirement-added"].includes(c.kind));
  if (!reasons.size) {
    // The repository keeps specs, but this change has none: say so once, only when it does something.
    return interesting.length ? { changes: [], outOfScope: [], noChange: true } : undefined;
  }

  // 2. Scope: what the change's requirements are implemented by or target, widened to their files and services.
  const fileOf = (n: FlowNode | undefined): string | undefined => n?.source?.file;
  const serviceOf = (n: FlowNode | undefined): string | undefined => {
    const seen = new Set<string>();
    let cur = n;
    while (cur && !seen.has(cur.id)) {
      if (cur.kind === "service") return cur.id;
      seen.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return undefined;
  };
  const scopeNodes = new Set<string>();
  const out: SpecCheck["changes"] = [];
  for (const [cid, why] of reasons) {
    const c = byId.get(cid)!;
    const reqs = requirementsOf(cid);
    const implemented = reqs.filter((r) => after.edges.some((e) => e.relation === "implements" && e.to.node === r.id));
    const newly = implemented.filter((r) => !before.edges.some((e) => e.relation === "implements" && e.to.node === r.id));
    for (const r of reqs) {
      for (const e of after.edges) {
        if (e.relation === "implements" && e.to.node === r.id) scopeNodes.add(e.from.node);
        if (e.relation === "targets" && (e.from.node === r.id || byId.get(e.from.node)?.parent === r.id)) scopeNodes.add(e.to.node);
      }
    }
    const tasks = c.metadata?.tasks as { done: number; total: number } | undefined;
    const missing = reqs.flatMap((r) => ((r.metadata?.unresolved as string[] | undefined) ?? []).map((x) => `${x} (for "${r.name}")`));
    out.push({
      id: String(c.metadata?.change ?? cid),
      title: c.name,
      format: c.metadata?.format as string | undefined,
      reasons: [...why],
      tasks,
      requirements: { total: reqs.length, implemented: implemented.length, newlyImplemented: newly.map((r) => r.name) },
      missing,
      complete: !!tasks?.total && tasks.done === tasks.total && implemented.length === reqs.length && !missing.length,
    });
  }
  // Scope follows behaviour, not files: what the spec names, what that calls (a few hops), and
  // new things added inside a named file or service. An edit to an existing function the spec's
  // code never reaches (charge() next to the new handler) stays outside.
  const scopeFiles = new Set([...scopeNodes].map((id) => fileOf(byId.get(id))).filter(Boolean) as string[]);
  const scopeServices = new Set([...scopeNodes].map((id) => serviceOf(byId.get(id)) ?? (byId.get(id)?.kind === "service" ? id : undefined)).filter(Boolean) as string[]);
  const calls = new Map<string, string[]>();
  for (const e of after.edges) if (e.kind === "call" && !e.relation) calls.set(e.from.node, [...(calls.get(e.from.node) ?? []), e.to.node]);
  const reach = new Set(scopeNodes);
  let frontier = [...scopeNodes];
  for (let hop = 0; hop < 4 && frontier.length; hop++) {
    const next: string[] = [];
    for (const id of frontier) for (const t of calls.get(id) ?? []) if (!reach.has(t)) (reach.add(t), next.push(t));
    frontier = next;
  }
  const added = new Set(d.added);
  const inScope = (c: BehaviorChange) =>
    c.nodes.some((id) => {
      const n = byId.get(id) ?? beforeIds.get(id);
      if (!n) return false;
      if (n.kind === "artifact" || reach.has(id)) return true;
      if (!added.has(id)) return false;
      const f = fileOf(n);
      const s = serviceOf(byId.get(id));
      return (!!f && scopeFiles.has(f)) || (!!s && scopeServices.has(s));
    });
  const outOfScope = scopeNodes.size ? d.changes.map((c, i) => (interesting.includes(c) && !inScope(c) ? i : -1)).filter((i) => i >= 0) : [];
  return { changes: out, outOfScope, scoped: scopeNodes.size > 0 };
}
