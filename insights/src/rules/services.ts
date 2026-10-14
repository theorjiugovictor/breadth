import type { Insight, Step } from "@noodles/schema";
import type { Ctx } from "../context.js";
import type { Rule } from "../rule.js";

/** Two services exchanging many calls within one request. */
export const chattyServices: Rule = {
  id: "chatty-services",
  category: "inefficiency",
  title: "Chatty services",
  description: "Many calls between the same two services within one request, where one batched call may do.",
  run(ctx, opts) {
    const min = opts.minCalls ?? 6;
    const out: Insight[] = [];
    for (const x of ctx.executions) {
      const byId = new Map(x.steps.map((s) => [s.id, s]));
      const pairs = new Map<string, Step[]>();
      for (const s of x.steps) {
        const p = s.parent ? byId.get(s.parent) : undefined;
        if (!p) continue;
        const a = ctx.stepService(p);
        const b = ctx.stepService(s);
        if (!a || !b || a === b) continue;
        const key = `${a}|${b}`;
        pairs.set(key, [...(pairs.get(key) ?? []), s]);
      }
      for (const [key, steps] of pairs) {
        if (steps.length < min) continue;
        const [a, b] = key.split("|");
        out.push({
          id: `chatty-services:${x.id}:${key}`,
          rule: "chatty-services",
          category: "inefficiency",
          severity: "warning",
          confidence: "high",
          title: `${label(ctx, a)} called ${label(ctx, b)} ${steps.length} times in one request`,
          detail: `Seen in "${x.name ?? x.id}". Consider a batch endpoint or moving the loop to the callee.`,
          nodes: ctx.node(a) && ctx.node(b) ? [a, b] : steps.map((s) => s.node),
          execution: x.id,
          steps: steps.map((s) => s.id),
          metadata: { calls: steps.length },
        });
      }
    }
    return out;
  },
};

/** A request that crosses many services. */
export const longHopChain: Rule = {
  id: "long-hop-chain",
  category: "inefficiency",
  title: "Long hop chains",
  description: "A request that passes through many services in sequence; each hop adds latency and a failure point.",
  run(ctx, opts) {
    const min = opts.minServices ?? 4;
    const out: Insight[] = [];
    for (const x of ctx.executions) {
      const byId = new Map(x.steps.map((s) => [s.id, s]));
      let best: { chain: string[]; leaf: Step } | undefined;
      for (const s of x.steps) {
        const chain: string[] = [];
        let cur: Step | undefined = s;
        while (cur) {
          const svc = ctx.stepService(cur);
          if (svc && chain[0] !== svc) chain.unshift(svc);
          cur = cur.parent ? byId.get(cur.parent) : undefined;
        }
        if (!best || chain.length > best.chain.length) best = { chain, leaf: s };
      }
      if (!best || best.chain.length < min) continue;
      const path: string[] = [];
      let cur: Step | undefined = best.leaf;
      while (cur) {
        path.unshift(cur.id);
        cur = cur.parent ? byId.get(cur.parent) : undefined;
      }
      out.push({
        id: `long-hop-chain:${x.id}`,
        rule: "long-hop-chain",
        category: "inefficiency",
        severity: "info",
        confidence: "high",
        title: `Request crosses ${best.chain.length} services`,
        detail: `${best.chain.map((s) => label(ctx, s)).join(" → ")} in "${x.name ?? x.id}". Check whether every hop is needed for this request.`,
        nodes: best.chain.filter((s) => ctx.node(s)),
        execution: x.id,
        steps: path,
        metadata: { services: best.chain.length },
      });
    }
    return out;
  },
};

function label(ctx: Ctx, svc: string) {
  return ctx.node(svc)?.name ?? svc;
}
