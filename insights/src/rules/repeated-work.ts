import type { Insight } from "@noodles/schema";
import { stableJson, type Ctx } from "../context.js";
import type { Rule } from "../rule.js";

/** The same node called more than once with identical input within one execution. */
export const repeatedWork: Rule = {
  id: "repeated-work",
  category: "inefficiency",
  title: "Repeated work",
  description: "The same function or call made several times with identical input in one request: a caching or deduplication opportunity.",
  run(ctx: Ctx, opts) {
    const min = opts.minRepeats ?? 2;
    // node -> occurrences (one per execution where the same input repeated)
    const found = new Map<string, { execution: string; name: string; steps: string[]; wasted: number }[]>();
    for (const x of ctx.executions) {
      const groups = new Map<string, typeof x.steps>();
      for (const s of x.steps) {
        if (s.input === undefined || s.input === null) continue;
        const n = ctx.node(s.node);
        if (!n || n.kind === "network_endpoint" || n.kind === "service" || n.kind === "queue") continue;
        const key = `${s.node}|${stableJson(s.input)}`;
        const list = groups.get(key) ?? [];
        list.push(s);
        groups.set(key, list);
      }
      for (const [key, steps] of groups) {
        if (steps.length < min) continue;
        const node = key.split("|")[0];
        const wasted = steps.slice(1).reduce((t, s) => t + (s.end !== undefined && s.start !== undefined ? s.end - s.start : 0), 0);
        found.set(node, [...(found.get(node) ?? []), { execution: x.id, name: x.name ?? x.id, steps: steps.map((s) => s.id), wasted }]);
      }
    }
    const out: Insight[] = [];
    for (const [node, hits] of found) {
      const first = hits[0];
      const repeats = Math.max(...hits.map((h) => h.steps.length));
      const ms = hits.reduce((t, h) => t + h.wasted, 0) / hits.length;
      out.push({
        id: `repeated-work:${node}`,
        rule: "repeated-work",
        category: "inefficiency",
        severity: "info",
        confidence: "high",
        title: `${ctx.name(node)} runs ${repeats} times with the same input`,
        detail: `Seen in ${hits.length === 1 ? `"${first.name}"` : `${hits.length} runs`}${ms ? `; the repeats cost ${ms.toFixed(1)} ms per request` : ""}. Reuse the first result or cache it.`,
        nodes: [node],
        execution: first.execution,
        steps: first.steps,
        metadata: { repeats, runs: hits.length },
      });
    }
    return out;
  },
};
