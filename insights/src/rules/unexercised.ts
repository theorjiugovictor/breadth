import type { Insight } from "@breadth/schema";
import type { Rule } from "../rule.js";

/**
 * With live traffic on the graph (breadth pull, watch --live): endpoints in code that received
 * no requests while their service did. Dead in practice, not just in theory: a candidate for
 * removal, or a feature nobody found. Only judged for services the backend reported on.
 */
export const unexercised: Rule = {
  id: "unexercised",
  category: "redundancy",
  title: "No traffic",
  description: "With live traffic pulled from an observability backend: endpoints in code that got no requests in the window while their service did.",
  run(ctx) {
    const out: Insight[] = [];
    const services = ctx.graph.nodes.filter((n) => n.kind === "service" && (n.metadata?.live as { rpm?: number } | undefined)?.rpm);
    if (!services.length) return out;
    for (const svc of services) {
      const live = svc.metadata!.live as { source: string; window: string };
      for (const r of ctx.graph.nodes) {
        if (r.kind !== "network_endpoint" || !r.id.startsWith("route:") || r.metadata?.live) continue;
        if (ctx.serviceOf(r.id) !== svc.id && r.metadata?.service !== svc.name) continue;
        out.push({
          id: `unexercised:${r.id}`,
          rule: "unexercised",
          category: "redundancy",
          severity: "info",
          confidence: "medium",
          title: `${r.name} got no traffic in the last ${live.window}`,
          detail: `${svc.name} served requests in that window (${live.source}), but none reached ${r.name}. Unused, behind a flag, or only called rarely: check before relying on it, or remove it.`,
          nodes: [r.id, svc.id],
        });
      }
    }
    return out;
  },
};
