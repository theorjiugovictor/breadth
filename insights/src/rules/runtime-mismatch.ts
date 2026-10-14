import type { Insight } from "@noodles/schema";
import type { Rule } from "../rule.js";

/**
 * Calls observed at runtime that the static code map does not contain: dynamic dispatch,
 * reflection, monkey patching, generated code, or code that was not scanned.
 */
export const runtimeMismatch: Rule = {
  id: "static-runtime-mismatch",
  category: "risk",
  title: "Static vs runtime mismatch",
  description: "Paths production takes that the code map says do not exist (getattr, dynamic imports, DI containers, code outside the scan).",
  run(ctx) {
    const out: Insight[] = [];
    if (!ctx.executions.length) return out;
    const stepsByEdge = new Map<string, { execution: string; step: string }>();
    for (const x of ctx.executions) for (const s of x.steps) if (s.via && !stepsByEdge.has(s.via)) stepsByEdge.set(s.via, { execution: x.id, step: s.id });
    for (const e of ctx.graph.edges) {
      if (e.kind !== "call" || !ctx.traversed.has(e.id)) continue;
      if (!e.from.node.startsWith("code:fn:") || !e.to.node.startsWith("code:fn:")) continue;
      // static edges carry the call-site lines from the code collector
      if (Array.isArray(e.metadata?.lines)) continue;
      const seen = stepsByEdge.get(e.id);
      out.push({
        id: `static-runtime-mismatch:${e.id}`,
        rule: "static-runtime-mismatch",
        category: "risk",
        severity: "info",
        confidence: "high",
        title: `${ctx.name(e.from.node)} calls ${ctx.name(e.to.node)} at runtime, but not in the code map`,
        detail: `Seen in ${e.count ?? 1} span${(e.count ?? 1) === 1 ? "" : "s"}, with no matching call in the source. Likely dynamic dispatch (getattr, a registry, dependency injection); such paths are easy to miss in reviews and refactors.`,
        nodes: [e.from.node, e.to.node],
        edges: [e.id],
        execution: seen?.execution,
        steps: seen ? [seen.step] : undefined,
      });
    }
    return out;
  },
};
