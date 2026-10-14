import type { Insight } from "@noodles/schema";
import type { Ctx } from "../context.js";
import type { Rule } from "../rule.js";

/**
 * N+1 queries. Statically: a call inside a loop to something that reads a datastore, or a read
 * issued inside a loop. At runtime: the same datastore query or external call repeated many times
 * within one request.
 */
export const nPlusOne: Rule = {
  id: "n-plus-one",
  category: "inefficiency",
  title: "N+1 queries",
  description: "A datastore read (or remote call) that runs once per item of a loop instead of once per batch.",
  run(ctx: Ctx, opts) {
    const minRuntime = opts.minRepeats ?? 3;
    const out: Insight[] = [];
    const seen = new Set<string>();

    // static: read edges issued inside a loop
    for (const e of ctx.graph.edges) {
      if (e.kind === "read" && e.loop && ctx.isStore(e.from.node) && !ctx.isInMemory(e.from.node)) {
        const id = `n-plus-one:${e.to.node}:${e.from.node}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          rule: "n-plus-one",
          category: "inefficiency",
          severity: "warning",
          confidence: "medium",
          title: `${ctx.name(e.to.node)} queries ${ctx.name(e.from.node)} inside a loop`,
          detail: `Each loop iteration issues its own read${e.label ? ` (${e.label})` : ""}. Fetch all rows in one query (WHERE … IN, a join, or a batch API).`,
          nodes: [e.to.node, e.from.node],
          edges: [e.id],
        });
      }
    }
    // static: loop calls into something that reads a datastore
    for (const e of ctx.graph.edges) {
      if (e.kind !== "call" || !e.loop) continue;
      for (const [store, path] of ctx.readsFrom(e.to.node)) {
        const id = `n-plus-one:${e.from.node}:${store}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id,
          rule: "n-plus-one",
          category: "inefficiency",
          severity: "warning",
          confidence: "medium",
          title: `${ctx.name(e.from.node)} calls ${ctx.name(e.to.node)} in a loop, which reads ${ctx.name(store)}`,
          detail: `${ctx.name(e.to.node)} hits ${ctx.name(store)} on every iteration${path.nodes.length > 1 ? ` (via ${path.nodes.slice(1).map((n) => ctx.name(n)).join(" → ")})` : ""}. Load what the loop needs up front, or give ${ctx.name(e.to.node)} a batch variant.`,
          nodes: [e.from.node, ...path.nodes, store],
          edges: [e.id, ...path.edges],
        });
      }
    }

    // runtime: the same query / remote call repeated within one request
    for (const x of ctx.executions) {
      const byKey = new Map<string, typeof x.steps>();
      for (const s of x.steps) {
        if (!ctx.isStore(s.node) && !ctx.isExternal(s.node)) continue;
        const key = `${s.node}|${(s.metadata?.span as string | undefined) ?? ""}`;
        const list = byKey.get(key) ?? [];
        list.push(s);
        byKey.set(key, list);
      }
      const byId = new Map(x.steps.map((s) => [s.id, s]));
      for (const [key, steps] of byKey) {
        if (steps.length < minRuntime) continue;
        const [node, span] = key.split("|");
        // the step that issues all of them: nearest common ancestor
        const chains = steps.map((s) => {
          const chain: string[] = [];
          let p = s.parent ? byId.get(s.parent) : undefined;
          while (p) {
            chain.unshift(p.id);
            p = p.parent ? byId.get(p.parent) : undefined;
          }
          return chain;
        });
        let common: string | undefined;
        for (let i = 0; i < chains[0].length && chains.every((c) => c[i] === chains[0][i]); i++) common = chains[0][i];
        const owner = common ? byId.get(common)!.node : undefined;
        out.push({
          id: `n-plus-one:run:${x.id}:${node}:${span}`,
          rule: "n-plus-one",
          category: "inefficiency",
          severity: "warning",
          confidence: "high",
          title: `${span || ctx.name(node)} ran ${steps.length} times in one request`,
          detail: `Observed in "${x.name ?? x.id}"${owner ? `, all issued under ${ctx.name(owner)}` : ""}. One batched call would replace ${steps.length} round trips.`,
          nodes: owner ? [owner, node] : [node],
          execution: x.id,
          // replay starts at the step that issues the queries
          steps: [...(common ? [common] : []), ...steps.map((s) => s.id)],
          metadata: { repeats: steps.length },
        });
      }
    }
    return out;
  },
};
