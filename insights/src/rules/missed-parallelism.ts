import type { Insight, Step } from "@breadth/schema";
import { duration, stepChildren, type Ctx } from "../context.js";
import type { Rule } from "../rule.js";

/** Values in a payload that could carry a dependency (ids, totals, emails…). */
function tokens(v: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6 || v === null || v === undefined) return out;
  if (typeof v === "string") {
    if (v.length >= 3) out.add(v);
  } else if (typeof v === "number") {
    if (!Number.isInteger(v) || Math.abs(v) > 9) out.add(String(v));
  } else if (Array.isArray(v)) v.slice(0, 50).forEach((x) => tokens(x, out, depth + 1));
  else if (typeof v === "object") Object.values(v as object).forEach((x) => tokens(x, out, depth + 1));
  return out;
}

function dependsOn(later: Step, earlier: Step): boolean | undefined {
  if (earlier.output === undefined || earlier.output === null) return undefined;
  const produced = tokens(earlier.output);
  if (!produced.size) return false;
  const consumed = tokens(later.input);
  for (const t of produced) if (consumed.has(t)) return true;
  return false;
}

/**
 * Sibling calls that ran one after another although neither uses the other's result.
 * A data dependency is the only thing visible in traces; ordering rules in the code
 * (check before charge) are not, so these are suggestions to review.
 */
export const missedParallelism: Rule = {
  id: "missed-parallelism",
  category: "inefficiency",
  title: "Missed parallelism",
  description: "Back-to-back calls under the same parent with no data flowing between them; running them concurrently would shorten the request.",
  run(ctx: Ctx, opts) {
    const minMs = opts.minStepMs ?? 2;
    const minSaving = opts.minSavingMs ?? 3;
    const out: Insight[] = [];
    for (const x of ctx.executions) {
      const kids = stepChildren(x);
      for (const [parentId, list] of kids) {
        const steps = list.filter((s) => s.start !== undefined && s.end !== undefined && duration(s) >= minMs).sort((a, b) => a.start! - b.start!);
        // grow groups of sequential, mutually independent steps
        let group: Step[] = [];
        const flush = () => {
          const distinct = new Set(group.map((s) => s.node));
          if (group.length >= 2 && distinct.size >= 2) {
            const total = group.reduce((t, s) => t + duration(s), 0);
            const longest = Math.max(...group.map(duration));
            const saving = total - longest;
            if (saving >= minSaving) {
              const parent = x.steps.find((s) => s.id === parentId);
              out.push({
                id: `missed-parallelism:${[...distinct].sort().join("+")}`,
                rule: "missed-parallelism",
                category: "inefficiency",
                severity: "info",
                confidence: "medium",
                title: `${group.map((s) => ctx.name(s.node)).join(" and ")} could run concurrently`,
                detail: `They ran one after another${parent ? ` inside ${ctx.name(parent.node)}` : ""} and neither uses the other's output. Running them together would save about ${saving.toFixed(1)} ms of ${total.toFixed(1)} ms in "${x.name ?? x.id}". Check that their order does not matter.`,
                nodes: [...(parent ? [parent.node] : []), ...distinct],
                execution: x.id,
                steps: group.map((s) => s.id),
                metadata: { savingMs: Math.round(saving * 10) / 10 },
              });
            }
          }
          group = [];
        };
        for (const s of steps) {
          const last = group[group.length - 1];
          const sequential = !last || s.start! >= last.end!;
          const deps = group.map((g) => dependsOn(s, g));
          // unknown (no recorded output) counts as a possible dependency
          if (sequential && deps.every((d) => d === false)) {
            group.push(s);
          } else {
            flush();
            group = [s];
          }
        }
        flush();
      }
    }
    return out;
  },
};
