import type { Insight } from "@noodles/schema";
import type { Rule } from "../rule.js";

/** Shared state with several writers. */
export const raceRisk: Rule = {
  id: "race-risk",
  category: "risk",
  title: "Race risk",
  description: "Shared state written from several places. Module-level state is the sharpest case; databases written by several services need clear ownership.",
  run(ctx, opts) {
    const minWriters = opts.minWriters ?? 2;
    const out: Insight[] = [];
    for (const n of ctx.graph.nodes) {
      if (n.kind !== "datastore") continue;
      const writes = (ctx.in.get(n.id) ?? []).filter((e) => e.kind === "write");
      const writers = [...new Set(writes.map((e) => e.from.node))];
      if (n.metadata?.subkind === "global") {
        if (writers.length < minWriters) continue;
        const asyncWriter = writers.some((w) => ctx.node(w)?.metadata?.async);
        out.push({
          id: `race-risk:${n.id}`,
          rule: "race-risk",
          category: "risk",
          severity: asyncWriter ? "warning" : "info",
          confidence: "medium",
          title: `${writers.length} functions write the shared ${n.name}`,
          detail: `${writers.map((w) => ctx.name(w)).join(", ")} all mutate this module-level state${asyncWriter ? ", and at least one is async" : ""}. Under threads, async tasks or several workers this can race or drift between processes.`,
          nodes: [n.id, ...writers],
          edges: writes.map((e) => e.id),
        });
      } else {
        const services = [...new Set(writers.map((w) => ctx.serviceOf(w)).filter(Boolean) as string[])];
        if (services.length < minWriters) continue;
        out.push({
          id: `race-risk:${n.id}`,
          rule: "race-risk",
          category: "risk",
          severity: "info",
          confidence: "low",
          title: `${services.length} services write ${n.name}`,
          detail: `${services.map((s) => ctx.name(s)).join(", ")} all write here. Shared databases need one owner per table, or transactions and constraints that make concurrent writes safe.`,
          nodes: [n.id, ...services],
          edges: writes.map((e) => e.id),
        });
      }
    }
    return out;
  },
};
