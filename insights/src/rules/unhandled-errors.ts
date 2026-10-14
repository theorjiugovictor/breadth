import type { Insight, Step } from "@breadth/schema";
import type { Rule } from "../rule.js";

/**
 * Errors that travel all the way to the entry point at runtime, and remote calls made with no
 * try/except or .catch() around them in the code.
 */
export const unhandledErrors: Rule = {
  id: "unhandled-errors",
  category: "risk",
  title: "Unhandled errors",
  description: "Failures that propagate to the caller of the whole request, and HTTP calls to other services or APIs with no local error handling.",
  run(ctx) {
    const out: Insight[] = [];

    // runtime: an error that reached the root of the request
    for (const x of ctx.executions) {
      const byId = new Map(x.steps.map((s) => [s.id, s]));
      const children = new Map<string, Step[]>();
      for (const s of x.steps) if (s.parent) children.set(s.parent, [...(children.get(s.parent) ?? []), s]);
      const roots = x.steps.filter((s) => !s.parent || !byId.has(s.parent));
      for (const root of roots) {
        if (root.status !== "error") continue;
        // follow the error down to where it started
        let origin = root;
        for (;;) {
          const next = (children.get(origin.id) ?? []).find((c) => c.status === "error");
          if (!next) break;
          origin = next;
        }
        const chain: Step[] = [];
        let cur: Step | undefined = origin;
        while (cur) {
          chain.unshift(cur);
          cur = cur.parent ? byId.get(cur.parent) : undefined;
        }
        out.push({
          id: `unhandled-errors:run:${x.id}:${origin.node}`,
          rule: "unhandled-errors",
          category: "risk",
          severity: "warning",
          confidence: "medium",
          title: `Error in ${ctx.name(origin.node)} reached ${ctx.name(root.node)}`,
          detail: `"${origin.error ?? "error"}" propagated through ${chain.length - 1} step${chain.length === 2 ? "" : "s"} to the entry point in "${x.name ?? x.id}". If this is an expected outcome, map it to a response deliberately; otherwise handle or retry closer to where it happens.`,
          nodes: [origin.node, ...chain.slice(0, -1).reverse().map((s) => s.node)].filter((n, i, a) => a.indexOf(n) === i),
          edges: chain.map((s) => s.via).filter(Boolean) as string[],
          execution: x.id,
          steps: chain.map((s) => s.id),
        });
      }
    }

    // static: remote HTTP calls without error handling around them
    for (const e of ctx.graph.edges) {
      if (e.kind !== "call" || e.protocol !== "http" || e.metadata?.guarded !== false) continue;
      const target = ctx.node(e.to.node);
      if (!target || !e.from.node.startsWith("code:")) continue;
      const remote = target.kind === "external_api" || (target.kind === "network_endpoint" && ctx.serviceOf(e.to.node) !== ctx.serviceOf(e.from.node));
      if (!remote) continue;
      out.push({
        id: `unhandled-errors:${e.id}`,
        rule: "unhandled-errors",
        category: "risk",
        severity: "info",
        confidence: "low",
        title: `${ctx.name(e.from.node)} calls ${target.name} with no error handling`,
        detail: `No try/except or .catch() around ${e.label ? `"${e.label}"` : "this call"}. Timeouts and 5xx responses will surface as unhandled exceptions unless a caller catches them.`,
        nodes: [e.from.node, e.to.node],
        edges: [e.id],
      });
    }
    return out;
  },
};
