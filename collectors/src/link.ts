import { edgeId, type FlowEdge, type FlowGraph, type FlowNode } from "@breadth/schema";
import { cleanResourceName } from "./code/cloud.js";

/**
 * Connect what code touches with the infrastructure that provides it, after all collectors
 * are merged. The code collector names AWS resources the way the code does
 * (`cloud:aws:s3:shop-receipts`, or `cloud:aws:s3:env:RECEIPTS_BUCKET` when the name comes from
 * the environment); Terraform knows the same resources by address. A match moves the code's
 * reads and writes onto the Terraform node:
 *
 * - by name: Bucket="shop-receipts" and aws_s3_bucket { bucket = "shop-receipts" }
 * - through the environment: os.environ["RECEIPTS_BUCKET"] in a service whose Kubernetes
 *   Deployment, Lambda function or ECS task sets RECEIPTS_BUCKET (to the name, or in Terraform
 *   to a reference such as aws_s3_bucket.receipts.bucket)
 *
 * Pure and browser-safe. Returns how many code nodes were linked.
 */
export function linkCodeToInfra(graph: FlowGraph): number {
  const code = graph.nodes.filter((n) => n.id.startsWith("cloud:aws:"));
  if (!code.length) return 0;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const byRef = new Map<string, string>();
  for (const n of graph.nodes) {
    const ref = n.metadata?.aws_ref;
    if (typeof ref === "string" && !byRef.has(ref)) byRef.set(ref, n.id);
  }
  if (!byRef.size) return 0;

  const serviceOf = (id: string): FlowNode | undefined => {
    const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      if (cur.kind === "service") return cur;
      seen.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return undefined;
  };
  /** The resource an environment variable names, as seen by one workload. */
  const fromEnv = (holder: FlowNode | undefined, name: string, service: string): string | undefined => {
    const refs = holder?.metadata?.env_refs as Record<string, string> | undefined;
    if (refs?.[name] && byId.has(refs[name])) return refs[name];
    const value = (holder?.metadata?.env as Record<string, string> | undefined)?.[name];
    return value ? byRef.get(`${service}:${cleanResourceName(service, value)}`) : undefined;
  };
  const holders = graph.nodes.filter((n) => n.metadata?.env || n.metadata?.env_refs);

  const target = new Map<string, { to: string; env?: string }>();
  for (const c of code) {
    const service = String(c.metadata?.service ?? "");
    const name = c.metadata?.resource as string | undefined;
    const env = c.metadata?.env as string | undefined;
    if (name) {
      const to = byRef.get(`${service}:${name}`);
      if (to) target.set(c.id, { to });
      continue;
    }
    if (!env) continue;
    // The workloads whose code uses it: their own environment decides.
    const users = graph.edges.filter((e) => e.from.node === c.id || e.to.node === c.id).map((e) => (e.from.node === c.id ? e.to.node : e.from.node));
    const found = new Set(users.map((u) => fromEnv(serviceOf(u), env, service)).filter((x): x is string => !!x));
    // Otherwise the variable set anywhere, if everyone agrees on it.
    if (!found.size) for (const h of holders) {
      const t = fromEnv(h, env, service);
      if (t) found.add(t);
    }
    if (found.size === 1) target.set(c.id, { to: [...found][0], env });
  }
  if (!target.size) return 0;

  const edges = new Map<string, FlowEdge>();
  for (const e of graph.edges) {
    const f = target.get(e.from.node);
    const t = target.get(e.to.node);
    if (!f && !t) {
      if (!edges.has(e.id)) edges.set(e.id, e);
      continue;
    }
    const from = { ...e.from, node: f?.to ?? e.from.node };
    const to = { ...e.to, node: t?.to ?? e.to.node };
    const id = edgeId(e.kind, from, to);
    const env = (f ?? t)!.env;
    const prev = edges.get(id);
    if (prev) {
      const labels = new Set([...(prev.label?.split(", ") ?? []), ...(e.label?.split(", ") ?? [])]);
      prev.label = [...labels].join(", ") || undefined;
      if (e.loop) prev.loop = true;
      continue;
    }
    edges.set(id, { ...e, id, from, to, metadata: { ...e.metadata, ...(env ? { via_env: env } : {}) } });
  }
  graph.edges = [...edges.values()];
  graph.nodes = graph.nodes.filter((n) => !target.has(n.id));
  // Keep the code's name for the resource findable (search, aliases).
  for (const [from, { to }] of target) {
    const n = byId.get(to)!;
    n.aliases = [...new Set([...(n.aliases ?? []), from])].sort();
  }
  for (const i of graph.insights ?? []) i.nodes = i.nodes.map((id) => target.get(id)?.to ?? id);
  return target.size;
}
