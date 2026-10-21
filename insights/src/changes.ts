import { diffGraphs, type BehaviorChange, type FlowEdge, type FlowGraph, type FlowNode, type GraphDiffInfo, type Insight } from "@breadth/schema";
import { sensitivePorts } from "./rules/infra-posture.js";

/**
 * What changed in behaviour between two versions of a graph, in the words a reviewer
 * would use: "save_order now writes to postgresql (INSERT orders)", "new endpoint
 * POST /orders/{id}/cancel", "price_order no longer calls validate_items".
 *
 * A code diff shows lines; this shows effects. It is computed from the graphs alone, so it
 * works for any language a collector understands.
 */

const SEV = { high: 0, medium: 1, low: 2 } as const;

/** Within a severity: what a reviewer most needs to see first. */
const KIND_ORDER = ["internet-exposed", "public", "destroy", "encryption-off", "iam-broad", "safety-off", "removed-safeguard", "removed-in-use", "datastore-write", "external-call", "loop-io", "signature", "endpoint-removed", "service-removed", "endpoint-added", "service-added", "datastore-added", "external-added"];
const order = (k: string) => {
  const i = KIND_ORDER.indexOf(k);
  return i < 0 ? KIND_ORDER.length : i;
};

/** Names of functions that guard something: removing a call to one deserves a close look. */
const SAFEGUARD = /auth|permission|authori[sz]e|verify|validat|check|risk|fraud|sanitiz|escape|guard|acl|csrf|rate.?limit|quota|limit|policy|allowed|can_|is_allowed|ensure/i;

function label(n: FlowNode | undefined, id: string): string {
  if (!n) return id;
  if (n.kind === "function" && n.parent) return n.name;
  return n.name;
}

function where(n: FlowNode | undefined): string {
  return n?.source?.file ? ` (${n.source.file})` : "";
}

/** Shared mutable state in code (module globals) vs a real datastore. */
const isGlobal = (n?: FlowNode) => n?.kind === "datastore" && n.metadata?.subkind === "global";
const isExternalPackage = (n?: FlowNode) => n?.kind === "module" && n.metadata?.external === true;
const isTerraform = (n?: FlowNode) => n?.metadata?.platform === "terraform";
/** Terraform resources that only wire others together: their arrival alone is not news. */
const PLUMBING = /(_attachment|_association|_policy|_policy_document|_rule|_route|_route_table\w*|_subnet\w*|_version|_configuration|_acl|_public_access_block|_ownership_controls|_versioning|_lifecycle\w*|_notification|_permission|_alias|_record|_listener\w*|_target_group\w*)$/;
/** Settings whose change takes a safety net away. */
const SAFETY: Record<string, (was: unknown, now: unknown) => boolean> = {
  deletion_protection: (was, now) => was === true && now !== true,
  skip_final_snapshot: (was, now) => was !== true && now === true,
  backup_retention_period: (was, now) => Number(was) > 0 && Number(now) === 0,
  multi_az: (was, now) => was === true && now !== true,
  publicly_accessible: (was, now) => was !== true && now === true,
};
/** Insight rules whose findings repeat an infrastructure change already listed for the same node. */
const POSTURE_RULES = new Set(["public-data", "unencrypted-storage", "broad-iam"]);
const fmt = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === undefined ? "unset" : String(v));

export interface ChangeReport extends GraphDiffInfo {
  /** Counts by kind, for a one-line summary. */
  counts: {
    functionsAdded: number;
    functionsRemoved: number;
    functionsChanged: number;
    endpointsAdded: number;
    endpointsRemoved: number;
    edgesAdded: number;
    edgesRemoved: number;
  };
  insightsAddedFull: Insight[];
  insightsResolvedFull: Insight[];
}

export function describeChanges(before: FlowGraph, after: FlowGraph, refs: { base?: string; head?: string } = {}): ChangeReport {
  const d = diffGraphs(before, after);
  const a = new Map(before.nodes.map((n) => [n.id, n]));
  const b = new Map(after.nodes.map((n) => [n.id, n]));
  const node = (id: string) => b.get(id) ?? a.get(id);
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));
  const changes: BehaviorChange[] = [];
  const push = (c: BehaviorChange) => changes.push(c);

  const callers = (id: string) => after.edges.filter((e) => e.kind === "call" && e.to.node === id && e.from.node !== id).length;

  const edgeChange = (e: FlowEdge, added: boolean) => {
    const from = node(e.from.node);
    const to = node(e.to.node);
    const f = label(from, e.from.node);
    const t = label(to, e.to.node);
    const how = e.label && e.label !== t ? ` (${e.label})` : "";
    const verb = added ? "now" : "no longer";
    const ids = { nodes: [e.from.node, e.to.node], edges: [e.id] };
    // Permissions (IAM): what a workload is allowed to touch.
    if (e.metadata?.via === "iam") {
      const reads = e.kind === "read" || (e.kind === "event" && from?.kind === "queue");
      const [subject, object] = reads ? [e.to.node, e.from.node] : [e.from.node, e.to.node];
      const what = e.kind === "write" ? "write to" : e.kind === "read" ? "read from" : e.kind === "call" ? "invoke" : reads ? "consume from" : "publish to";
      const writes = !reads && e.kind !== "call";
      return push({
        kind: "iam-access",
        severity: added ? (writes ? "high" : "medium") : "low",
        text: `${label(node(subject), subject)} ${added ? "can now" : "can no longer"} ${what} ${label(node(object), object)} (IAM${e.label ? `: ${e.label}` : ""})`,
        nodes: [subject, object],
        edges: [e.id],
      });
    }
    // Firewall / security group rules.
    if (e.kind === "network" && e.from.node.startsWith("net:")) {
      const src = from?.metadata?.cidr === "0.0.0.0/0" || from?.metadata?.cidr === "::/0" ? "the internet" : f;
      const ports = sensitivePorts(e.label);
      const severity = !added ? "low" : src === "the internet" && (ports.length || to?.kind !== "network_endpoint") ? "high" : "medium";
      return push({
        kind: "internet-exposed",
        severity,
        text: `${t} is ${added ? "now" : "no longer"} reachable from ${src}${how}${added && ports.length ? `: ${ports.join(", ")}` : ""}`,
        nodes: [e.to.node, e.from.node],
        edges: [e.id],
      });
    }
    if (e.kind === "network" && (isTerraform(from) || isTerraform(to)) && from?.kind !== "network_endpoint" && to?.kind !== "network_endpoint") {
      return push({ kind: "network-rule", severity: added ? "medium" : "low", text: `${t} ${added ? "now accepts" : "no longer accepts"} traffic from ${f}${how}`, ...ids });
    }
    if (e.kind === "write" && to?.kind === "datastore") {
      if (isGlobal(to)) return push({ kind: "shared-state-write", severity: "medium", text: `${f} ${verb} modifies shared state ${t}${where(to)}`, ...ids });
      return push({ kind: "datastore-write", severity: "high", text: `${f} ${verb} writes to ${t}${how}`, ...ids });
    }
    if (e.kind === "read" && from?.kind === "datastore") {
      if (isGlobal(from)) return; // reads of module globals are noise for review
      return push({ kind: "datastore-read", severity: "medium", text: `${t} ${verb} reads from ${f}${how}`, nodes: [e.to.node, e.from.node], edges: [e.id] });
    }
    if (e.kind === "call" && to?.kind === "external_api") {
      return push({ kind: "external-call", severity: "high", text: `${f} ${verb} calls the external API ${t}${how}`, ...ids });
    }
    if (e.kind === "event") {
      if (to?.kind === "queue") return push({ kind: "publish", severity: "medium", text: `${f} ${verb} publishes to ${t}${how}`, ...ids });
      if (from?.kind === "queue") return push({ kind: "consume", severity: "medium", text: `${t} ${verb} consumes ${f}`, nodes: [e.to.node, e.from.node], edges: [e.id] });
    }
    if (e.kind === "network" && from && to && from.kind === "service") {
      return push({ kind: "service-call", severity: "medium", text: `service ${f} ${verb} calls ${t}${how}`, ...ids });
    }
    if (e.kind === "call" && to?.kind === "network_endpoint") {
      return push({ kind: "endpoint-call", severity: "medium", text: `${f} ${verb} calls ${t}${how}`, ...ids });
    }
    if (e.kind === "call" && e.loop && added) {
      // A new call inside a loop matters when the callee does I/O.
      const io = after.edges.some((x) => (x.kind === "write" && x.from.node === e.to.node) || (x.kind === "read" && x.to.node === e.to.node && !isGlobal(node(x.from.node))) || (x.kind === "call" && x.from.node === e.to.node && node(x.to.node)?.kind === "external_api"));
      if (io) return push({ kind: "loop-io", severity: "high", text: `${f} now calls ${t} inside a loop, and ${t} does I/O (database or network)`, ...ids });
    }
    if (e.kind === "depends_on" && isExternalPackage(to) && added) {
      return push({ kind: "dependency", severity: "low", text: `${f} now uses the package ${t}`, ...ids });
    }
    if (e.kind === "call" && !added && from && to && from.kind === "function" && to.kind === "function" && b.has(e.from.node) && b.has(e.to.node)) {
      // Both still exist but the call is gone: a removed path. Dropping a check is the classic
      // silent regression in generated code, so those rank first.
      if (SAFEGUARD.test(t)) return push({ kind: "removed-safeguard", severity: "high", text: `${f} no longer calls ${t}: a check was removed`, ...ids });
      return push({ kind: "removed-path", severity: "medium", text: `${f} no longer calls ${t}`, ...ids });
    }
  };

  for (const id of d.edgesAdded) edgeChange(afterEdges.get(id)!, true);
  for (const id of d.edgesRemoved) edgeChange(beforeEdges.get(id)!, false);

  // Calls that moved into (or out of) a loop keep their id.
  for (const [id, e] of afterEdges) {
    const old = beforeEdges.get(id);
    if (old && !!old.loop !== !!e.loop && e.kind === "call") {
      push({
        kind: e.loop ? "loop" : "loop-removed",
        severity: e.loop ? "medium" : "low",
        text: `${label(node(e.from.node), e.from.node)} ${e.loop ? "now calls" : "no longer loops over"} ${label(node(e.to.node), e.to.node)}${e.loop ? " inside a loop" : ""}`,
        nodes: [e.from.node, e.to.node],
        edges: [id],
      });
    }
  }

  // Nodes that matter on their own.
  for (const id of d.added) {
    const n = b.get(id)!;
    if (id.startsWith("net:")) continue; // address ranges: listed with the rule that lets them in
    if (n.kind === "network_endpoint" && isTerraform(n)) push({ kind: "infra-added", severity: PLUMBING.test(String(n.metadata?.type)) ? "low" : "medium", text: `new network entry point ${n.name} (${String(n.metadata?.type)})`, nodes: [id] });
    else if (n.kind === "network_endpoint") push({ kind: "endpoint-added", severity: "high", text: `new endpoint ${n.name}${n.metadata?.service ? ` in ${n.metadata.service}` : ""}`, nodes: [id] });
    else if (n.kind === "service") push({ kind: "service-added", severity: "high", text: `new service ${n.name}`, nodes: [id] });
    else if (n.kind === "datastore" && !isGlobal(n)) push({ kind: "datastore-added", severity: "high", text: `new datastore ${n.name}`, nodes: [id] });
    else if (n.kind === "external_api") push({ kind: "external-added", severity: "high", text: `new third-party dependency ${n.name}`, nodes: [id] });
    else if (n.kind === "queue") push({ kind: "queue-added", severity: "medium", text: `new queue or topic ${n.name}`, nodes: [id] });
    else if (n.kind === "infra_resource") push({ kind: "infra-added", severity: PLUMBING.test(String(n.metadata?.type ?? "")) ? "low" : "medium", text: `new infrastructure ${n.name}${n.metadata?.type ? ` (${n.metadata.type})` : ""}`, nodes: [id] });
    else if (isGlobal(n)) push({ kind: "shared-state-added", severity: "low", text: `new shared state ${n.name}${where(n)}`, nodes: [id] });
  }
  for (const id of d.removed) {
    const n = a.get(id)!;
    if (id.startsWith("net:")) continue;
    if (n.kind === "network_endpoint" && isTerraform(n)) push({ kind: "infra-removed", severity: "medium", text: `network entry point ${n.name} (${String(n.metadata?.type)}) removed`, nodes: [id] });
    else if (n.kind === "network_endpoint") push({ kind: "endpoint-removed", severity: "high", text: `endpoint ${n.name} removed`, nodes: [id] });
    else if (n.kind === "service") push({ kind: "service-removed", severity: "high", text: `service ${n.name} removed`, nodes: [id] });
    else if (n.kind === "datastore" && isTerraform(n)) push({ kind: "destroy", severity: "high", text: `${n.name} (${String(n.metadata?.type)}) is removed from Terraform: applying destroys it and the data in it`, nodes: [id] });
    else if (n.kind === "datastore" && !isGlobal(n)) push({ kind: "datastore-removed", severity: "medium", text: `datastore ${n.name} removed`, nodes: [id] });
    else if (n.kind === "queue" && isTerraform(n)) push({ kind: "queue-removed", severity: "medium", text: `queue or topic ${n.name} is removed from Terraform: applying deletes it and any messages in it`, nodes: [id] });
    else if (n.kind === "infra_resource") push({ kind: "infra-removed", severity: "medium", text: `infrastructure ${n.name} removed`, nodes: [id] });
    else if (n.kind === "function" && before.edges.some((e) => e.kind === "call" && e.to.node === id && b.has(e.from.node) && !d.changed.includes(e.from.node))) {
      // Removed while a caller that did not change still calls it: likely a dangling reference.
      push({ kind: "removed-in-use", severity: "high", text: `${n.name} was removed, but code that did not change still calls it`, nodes: [id] });
    }
  }
  // Infrastructure whose settings changed.
  const posture = new Set<string>();
  for (const id of d.changed) {
    const was = a.get(id)!;
    const now = b.get(id)!;
    if (!isTerraform(now)) continue;
    const wm = was.metadata ?? {};
    const nm = now.metadata ?? {};
    const type = nm.type ? ` (${String(nm.type)})` : "";
    if (nm.public === true && wm.public !== true) {
      posture.add(id);
      push({ kind: "public", severity: "high", text: `${now.name} is now public: ${String(nm.public_reason ?? "")}`.replace(/: $/, ""), nodes: [id] });
    } else if (wm.public === true && nm.public !== true) push({ kind: "public-removed", severity: "low", text: `${now.name} is no longer public`, nodes: [id] });
    if (wm.encrypted === true && nm.encrypted === false) {
      posture.add(id);
      push({ kind: "encryption-off", severity: "high", text: `encryption at rest is turned off for ${now.name}${type}`, nodes: [id] });
    }
    const wasBroad = new Set((wm.iam_broad as string[] | undefined) ?? []);
    const newBroad = ((nm.iam_broad as string[] | undefined) ?? []).filter((x) => !wasBroad.has(x));
    if (newBroad.length) {
      posture.add(id);
      push({ kind: "iam-broad", severity: "high", text: `${now.name} is now allowed ${newBroad.join("; ")}`, nodes: [id] });
    }
    if (was.name !== now.name && now.kind === "datastore") {
      push({ kind: "destroy", severity: "high", text: `${was.name} is renamed to ${now.name}${type}: for most data stores Terraform creates a new one and destroys the old one with its data`, nodes: [id] });
    }
    const ws = (wm.settings as Record<string, unknown> | undefined) ?? {};
    const ns = (nm.settings as Record<string, unknown> | undefined) ?? {};
    const diffs: string[] = [];
    for (const k of [...new Set([...Object.keys(ws), ...Object.keys(ns)])]) {
      if (JSON.stringify(ws[k]) === JSON.stringify(ns[k])) continue;
      if (SAFETY[k]?.(ws[k], ns[k])) push({ kind: "safety-off", severity: "high", text: `${now.name}: ${k} ${fmt(ws[k])} → ${fmt(ns[k])}`, nodes: [id] });
      else diffs.push(`${k} ${fmt(ws[k])} → ${fmt(ns[k])}`);
    }
    if (diffs.length) push({ kind: "infra-settings", severity: "medium", text: `${now.name}${type}: ${diffs.join(", ")}`, nodes: [id] });
  }
  // What applying a plan does (when a plan was given): replacing or destroying is where data is lost.
  for (const n of after.nodes) {
    const action = n.metadata?.plan_action;
    if ((action !== "replace" && action !== "delete") || a.get(n.id)?.metadata?.plan_action === action) continue;
    const reason = (n.metadata?.plan_reason as string[] | undefined)?.length ? ` because ${(n.metadata!.plan_reason as string[]).join(", ")} changed` : "";
    const data = n.kind === "datastore" || n.kind === "queue" ? ": the data in it is lost unless restored from a backup" : "";
    push({ kind: "destroy", severity: "high", text: `applying the plan ${action === "replace" ? "replaces" : "destroys"} ${n.name}${reason}${data}`, nodes: [n.id] });
  }

  for (const id of d.changed) {
    const was = a.get(id)!;
    const now = b.get(id)!;
    if (now.kind !== "function") continue;
    const sig = (n: FlowNode) => (n.inputs ?? []).map((p) => p.name).join(", ");
    if (sig(was) !== sig(now)) {
      const users = callers(id);
      push({
        kind: "signature",
        severity: users ? "high" : "low",
        text: `${now.name}(${sig(was)}) → ${now.name}(${sig(now)})${users ? `, called from ${users} place${users === 1 ? "" : "s"}` : ""}`,
        nodes: [id],
      });
    }
  }

  // New findings are behaviour changes too.
  const loops = new Set(changes.filter((c) => c.kind === "loop-io").map((c) => c.nodes.join(">")));
  for (const i of d.insightsAdded) {
    // An N+1 finding repeats a "calls X inside a loop" change already listed.
    if (i.rule === "n-plus-one" && i.nodes.length >= 2 && loops.has(`${i.nodes[0]}>${i.nodes[1]}`)) continue;
    if (POSTURE_RULES.has(i.rule) && posture.has(i.nodes[0])) continue;
    // "X is reachable from the internet" is already listed from the rule that opened it.
    if (i.rule === "internet-exposed" && changes.some((c) => c.kind === "internet-exposed" && c.nodes[0] === i.nodes[0])) continue;
    push({ kind: `insight:${i.rule}`, severity: i.severity === "critical" ? "high" : i.severity === "warning" ? "medium" : "low", text: `new finding: ${i.title}`, nodes: i.nodes, edges: i.edges });
  }

  // De-duplicate (a write can surface as both an edge and a new datastore) and rank.
  const seen = new Set<string>();
  const ranked = changes
    .filter((c) => (seen.has(c.text) ? false : (seen.add(c.text), true)))
    .sort((x, y) => SEV[x.severity] - SEV[y.severity] || order(x.kind) - order(y.kind));

  const fn = (ids: string[], g: Map<string, FlowNode>) => ids.filter((id) => g.get(id)?.kind === "function").length;
  const ep = (ids: string[], g: Map<string, FlowNode>) => ids.filter((id) => g.get(id)?.kind === "network_endpoint").length;
  return {
    ...refs,
    added: d.added,
    removed: d.removed,
    changed: d.changed,
    edgesAdded: d.edgesAdded,
    edgesRemoved: d.edgesRemoved,
    insightsAdded: d.insightsAdded.map((i) => i.id),
    insightsResolved: d.insightsResolved.map((i) => i.id),
    changes: ranked,
    counts: {
      functionsAdded: fn(d.added, b),
      functionsRemoved: fn(d.removed, a),
      functionsChanged: fn(d.changed, b),
      endpointsAdded: ep(d.added, b),
      endpointsRemoved: ep(d.removed, a),
      edgesAdded: d.edgesAdded.length,
      edgesRemoved: d.edgesRemoved.length,
    },
    insightsAddedFull: d.insightsAdded,
    insightsResolvedFull: d.insightsResolved,
  };
}

/**
 * One graph holding both versions: the new graph plus what was removed, each element
 * marked with metadata.diff ("added" | "removed" | "changed"). The canvas draws it.
 */
export function diffGraph(before: FlowGraph, after: FlowGraph, report: ChangeReport): FlowGraph {
  const added = new Set(report.added);
  const changed = new Set(report.changed);
  const edgesAdded = new Set(report.edgesAdded);
  const ids = new Set(after.nodes.map((n) => n.id));
  const mark = <T extends { metadata?: Record<string, unknown> }>(x: T, diff: string): T => ({ ...x, metadata: { ...x.metadata, diff } });
  const nodes = after.nodes.map((n) => (added.has(n.id) ? mark(n, "added") : changed.has(n.id) ? mark(n, "changed") : n));
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]));
  for (const id of report.removed) {
    const n = beforeById.get(id)!;
    // Keep removed nodes where they were; if their parent is gone too, it is also kept.
    nodes.push(mark({ ...n, parent: n.parent && (ids.has(n.parent) || report.removed.includes(n.parent)) ? n.parent : undefined }, "removed"));
  }
  const edges = after.edges.map((e) => (edgesAdded.has(e.id) ? mark(e, "added") : e));
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  for (const id of report.edgesRemoved) edges.push(mark(beforeEdges.get(id)!, "removed"));
  const { counts: _c, insightsAddedFull: _a, insightsResolvedFull: _r, ...info } = report;
  return { ...after, nodes, edges, diff: info };
}

/** The graph as it was before or after: drops elements marked removed (for rules and layout that need one version). */
export function withoutRemoved(g: FlowGraph): FlowGraph {
  if (!g.diff) return g;
  return {
    ...g,
    nodes: g.nodes.filter((n) => n.metadata?.diff !== "removed"),
    edges: g.edges.filter((e) => e.metadata?.diff !== "removed"),
  };
}
