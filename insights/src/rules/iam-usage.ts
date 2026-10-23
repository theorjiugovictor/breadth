import type { FlowEdge, Insight } from "@breadth/schema";
import type { Rule } from "../rule.js";

type Access = { read: boolean; write: boolean };

/** IAM action prefix for a Terraform resource type, to check wildcard grants (s3:* on *). */
const IAM_SERVICE: Record<string, string> = {
  aws_s3_bucket: "s3",
  aws_dynamodb_table: "dynamodb",
  aws_sqs_queue: "sqs",
  aws_sns_topic: "sns",
  aws_kinesis_stream: "kinesis",
};

/**
 * Compares what each service's IAM role allows with what its code does, per data store or
 * queue, once code and Terraform are linked (same name, or a name passed in the environment):
 * code that writes where its role cannot (fails at runtime), and grants the code never uses
 * (least privilege).
 */
export const iamUsage: Rule = {
  id: "iam-usage",
  category: "risk",
  title: "IAM does not match the code",
  description: "Per data store and queue: a service whose code reads or writes it without its IAM role allowing that (an AccessDenied waiting to happen), or a role that allows access the service's code never uses. Needs code and Terraform in one graph, with the role linked to the service (Lambda, ECS, or Kubernetes through EKS Pod Identity / IRSA).",
  run(ctx) {
    const out: Insight[] = [];
    const isCode = (id: string) => ctx.node(id)?.layer === "code";
    // Services with code in the graph (otherwise "never uses" means "not collected").
    const withCode = new Set<string>();
    for (const n of ctx.graph.nodes) if (n.layer === "code" && n.kind === "function") {
      const s = ctx.serviceOf(n.id);
      if (s) withCode.add(s);
    }
    for (const r of ctx.graph.nodes) {
      // Only where IAM is what grants access (not database logins, not brokers with their own auth).
      if (r.metadata?.platform !== "terraform" || (r.kind !== "datastore" && r.kind !== "queue") || !IAM_SERVICE[String(r.metadata.type)]) continue;
      const scope = new Set([r.id, ...ctx.graph.nodes.filter((c) => c.parent === r.id).map((c) => c.id)]);
      const code = new Map<string, Access>();
      const iam = new Map<string, Access & { edges: string[] }>();
      const mark = <T extends Access>(m: Map<string, T>, svc: string, mode: keyof Access, init: T) => {
        if (!m.has(svc)) m.set(svc, init);
        m.get(svc)![mode] = true;
      };
      const touching: FlowEdge[] = [...scope].flatMap((id) => [...(ctx.in.get(id) ?? []), ...(ctx.out.get(id) ?? [])]);
      for (const e of touching) {
        const inside = scope.has(e.to.node) ? e.to.node : e.from.node;
        const other = inside === e.to.node ? e.from.node : e.to.node;
        if (scope.has(other)) continue;
        const writes = e.kind === "write" || (e.kind === "event" && e.to.node === inside) || e.kind === "call";
        const reads = e.kind === "read" || (e.kind === "event" && e.from.node === inside);
        if (!writes && !reads) continue;
        const mode: keyof Access = writes ? "write" : "read";
        if (e.metadata?.via === "iam") {
          const svc = ctx.serviceOf(other) ?? other;
          mark(iam, svc, mode, { read: false, write: false, edges: [] });
          iam.get(svc)!.edges.push(e.id);
        } else if (isCode(other)) {
          const svc = ctx.serviceOf(other);
          if (svc) mark(code, svc, mode, { read: false, write: false });
        }
      }
      const prefix = IAM_SERVICE[String(r.metadata.type)];
      for (const [svc, used] of code) {
        const roles = (ctx.node(svc)?.metadata?.iam_roles as string[] | undefined) ?? [];
        if (!roles.length) continue; // we do not know what it runs as
        const broad = roles.flatMap((id) => (ctx.node(id)?.metadata?.iam_broad as string[] | undefined) ?? []);
        const wildcard = broad.some((b) => b.startsWith("* on *") || b.startsWith("everything except") || (prefix && b.startsWith(`${prefix}:* on *`)));
        const granted = iam.get(svc);
        for (const mode of ["write", "read"] as const) {
          if (!used[mode] || granted?.[mode] || wildcard) continue;
          out.push({
            id: `iam-usage:missing:${svc}:${r.id}:${mode}`,
            rule: "iam-usage",
            category: "risk",
            severity: "warning",
            confidence: "medium",
            title: `${ctx.name(svc)} ${mode === "write" ? "writes to" : "reads from"} ${r.name}, but its IAM role does not allow it`,
            detail: `The code of ${ctx.name(svc)} ${mode === "write" ? "writes to" : "reads from"} ${r.name}, and none of the policies of ${roles.map((id) => ctx.name(id)).join(", ")} grants that. Expect AccessDenied at runtime, unless the permission comes from somewhere not collected (a resource policy, another account).`,
            nodes: [svc, r.id, ...roles],
          });
        }
      }
      for (const [svc, granted] of iam) {
        if (!withCode.has(svc)) continue;
        const used = code.get(svc);
        for (const mode of ["write", "read"] as const) {
          if (!granted[mode] || used?.[mode]) continue;
          out.push({
            id: `iam-usage:unused:${svc}:${r.id}:${mode}`,
            rule: "iam-usage",
            category: "risk",
            severity: "info",
            confidence: "low",
            title: `${ctx.name(svc)} may ${mode === "write" ? "write to" : "read from"} ${r.name}, but its code never does`,
            detail: `IAM allows ${ctx.name(svc)} to ${mode} ${r.name}, and no code in it does. If nothing else running as this role needs it, remove the grant: it only widens what a compromised ${ctx.name(svc)} can do.`,
            nodes: [svc, r.id],
            edges: granted.edges,
          });
        }
      }
    }
    return out;
  },
};

