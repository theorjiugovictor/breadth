import type { Insight } from "@noodles/schema";
import type { Rule } from "../rule.js";

const USE = new Set(["read", "write", "event", "call", "data", "network"]);

/** Declared datastores and queues that nothing reads from or writes to. */
export const orphanInfra: Rule = {
  id: "orphan-infra",
  category: "redundancy",
  title: "Orphan infrastructure",
  description: "Provisioned datastores and queues with no reader, writer or traffic in any collected layer. Often forgotten spend, sometimes used by something not collected yet.",
  run(ctx) {
    const out: Insight[] = [];
    for (const n of ctx.graph.nodes) {
      const platform = n.metadata?.platform;
      if (platform !== "terraform" && platform !== "kubernetes") continue;
      if (n.kind !== "datastore" && n.kind !== "queue") continue;
      const touching = [...(ctx.in.get(n.id) ?? []), ...(ctx.out.get(n.id) ?? [])];
      // children (topics in a broker) count as use of the parent
      const childIds = ctx.graph.nodes.filter((c) => c.parent === n.id).map((c) => c.id);
      const childUse = childIds.some((c) => [...(ctx.in.get(c) ?? []), ...(ctx.out.get(c) ?? [])].some((e) => USE.has(e.kind)));
      if (touching.some((e) => USE.has(e.kind)) || childUse || ctx.seen.has(n.id)) continue;
      out.push({
        id: `orphan-infra:${n.id}`,
        rule: "orphan-infra",
        category: "redundancy",
        severity: "info",
        confidence: "medium",
        title: `Nothing uses ${n.name}`,
        detail: `${String(n.metadata?.type ?? n.kind)} has no reads, writes or traffic in code, traces or network rules. If it is really unused, removing it saves cost and attack surface.`,
        nodes: [n.id],
        metadata: { type: n.metadata?.type, resource: n.source?.resource_ref },
      });
    }
    return out;
  },
};
