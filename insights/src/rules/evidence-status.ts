import type { FlowNode, Insight } from "@breadth/schema";
import type { Ctx } from "../context.js";
import type { Rule } from "../rule.js";
import { behaviourUnits, serviceFingerprint } from "../units.js";

/** Evidence whose recorded behaviour fingerprint no longer matches the service it is about. */
export function staleEvidence(ctx: Ctx): Set<string> {
  const evidence = ctx.graph.nodes.filter((n) => n.role === "evidence" && typeof n.metadata?.fingerprint === "string" && n.metadata?.service);
  if (!evidence.length) return new Set();
  const units = behaviourUnits(ctx.graph);
  return new Set(evidence.filter((e) => serviceFingerprint(units, String(e.metadata!.service)) !== e.metadata!.fingerprint).map((e) => e.id));
}

/**
 * Requirements against what backs them (resilience-v1): evidence that contradicts them,
 * evidence gathered on behaviour that has changed since, requirements nothing verifies, and
 * spec references that point at nothing.
 */
export const evidenceStatus: Rule = {
  id: "evidence-status",
  category: "risk",
  title: "Requirement evidence",
  description: "With OpenSpec requirements and run records collected: requirements that evidence contradicts, evidence recorded on behaviour that has changed since (stale), requirements with no test and no evidence, and Implemented by / Verified by references that match nothing.",
  run(ctx) {
    const out: Insight[] = [];
    const reqs = ctx.graph.nodes.filter((n) => n.role === "requirement");
    if (!reqs.length) return out;
    const stale = staleEvidence(ctx);
    const evidenceFor = (r: FlowNode) => (ctx.in.get(r.id) ?? []).filter((e) => e.relation === "supports" || e.relation === "contradicts").map((e) => ctx.node(e.from.node)!).filter(Boolean);
    const scenariosOf = (r: FlowNode) => ctx.graph.nodes.filter((n) => n.role === "scenario" && n.parent === r.id);
    const verified = (id: string) => (ctx.in.get(id) ?? []).some((e) => e.relation === "verifies");
    for (const r of reqs) {
      const ev = evidenceFor(r);
      for (const e of ev) {
        const why = ((e.metadata?.checks as { metric: string; op: string; expected: number; actual?: number; ok?: boolean }[] | undefined) ?? []).filter((c) => c.ok === false).map((c) => `${c.metric} ${c.actual} (wanted ${c.op} ${c.expected})`);
        if (stale.has(e.id)) {
          out.push({
            id: `evidence-status:stale:${e.id}`,
            rule: "evidence-status",
            category: "risk",
            severity: "warning",
            confidence: "high",
            title: `Evidence for "${r.name}" is about older behaviour of ${String(e.metadata?.service)}`,
            detail: `Run ${String(e.metadata?.run)} (${String(e.metadata?.verdict)}) was recorded when ${String(e.metadata?.service)} behaved differently: its calls, data access or endpoints changed since. Run the scenario again before relying on it.`,
            nodes: [e.id, r.id],
          });
        } else if (e.metadata?.verdict === "contradicts") {
          out.push({
            id: `evidence-status:contradicted:${e.id}`,
            rule: "evidence-status",
            category: "risk",
            severity: "critical",
            confidence: "high",
            title: `"${r.name}" is contradicted by run ${String(e.metadata?.run)}`,
            detail: `${e.name}${why.length ? `: ${why.join("; ")}` : ""}.`,
            nodes: [r.id, e.id],
          });
        }
      }
      const tested = verified(r.id) || scenariosOf(r).some((s) => verified(s.id));
      if (!tested && !ev.length) {
        out.push({
          id: `evidence-status:unverified:${r.id}`,
          rule: "evidence-status",
          category: "risk",
          severity: "info",
          confidence: "medium",
          title: `Nothing verifies "${r.name}"`,
          detail: "No test is linked to it or its scenarios (Verified by:, @pytest.mark.requirement, @Verifies) and no run produced evidence for it.",
          nodes: [r.id],
        });
      }
      for (const n of [r, ...scenariosOf(r)]) {
        const unresolved = n.metadata?.unresolved as string[] | undefined;
        if (!unresolved?.length) continue;
        out.push({
          id: `evidence-status:unresolved:${n.id}`,
          rule: "evidence-status",
          category: "risk",
          severity: "info",
          confidence: "high",
          title: `"${n.name}" refers to ${unresolved.join(", ")}, which ${unresolved.length === 1 ? "does" : "do"} not exist`,
          detail: "Not found in the collected code, routes or services: renamed, removed, or not built yet.",
          nodes: [n.id],
        });
      }
    }
    return out;
  },
};

