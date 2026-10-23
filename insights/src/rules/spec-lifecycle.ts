import type { FlowNode, Insight } from "@breadth/schema";
import type { Ctx } from "../context.js";
import type { Rule } from "../rule.js";

/** The change a requirement belongs to: its parent chain, or the change id it records. */
export function changeOf(ctx: Ctx, n: FlowNode | undefined): string | undefined {
  const seen = new Set<string>();
  for (let cur = n; cur && !seen.has(cur.id); cur = cur.parent ? ctx.node(cur.parent) : undefined) {
    if (cur.role === "change") return cur.id;
    if (cur.metadata?.change && cur.role !== "evidence") return `change:${String(cur.metadata.change)}`;
    seen.add(cur.id);
  }
  return undefined;
}

/**
 * Spec changes against the code (OpenSpec changes, Spec Kit features, Kiro specs): every task
 * ticked while the code its requirements name does not exist, and changes that are finished but
 * still open. Nothing for repositories without specs.
 */
export const specLifecycle: Rule = {
  id: "spec-lifecycle",
  category: "risk",
  title: "Spec change lifecycle",
  description: "With spec changes collected (OpenSpec, Spec Kit, Kiro): changes whose tasks are all ticked although code their requirements name (Implemented by:) does not exist, and OpenSpec changes that are complete (tasks done, every requirement implemented) but not archived, and changes being built while requirements are still marked NEEDS CLARIFICATION. Requirements that name no code are not judged.",
  run(ctx) {
    const out: Insight[] = [];
    const changes = ctx.graph.nodes.filter((n) => n.role === "change" && !n.metadata?.archived);
    if (!changes.length) return out;
    const reqs = ctx.graph.nodes.filter((n) => n.role === "requirement");
    const implemented = (r: FlowNode) => (ctx.in.get(r.id) ?? []).some((e) => e.relation === "implements");
    for (const c of changes) {
      const tasks = c.metadata?.tasks as { done: number; total: number } | undefined;
      const own = reqs.filter((r) => changeOf(ctx, r) === c.id);
      const missing = own.flatMap((r) => ((r.metadata?.unresolved as string[] | undefined) ?? []).map((x) => ({ r, x })));
      const done = !!tasks?.total && tasks.done === tasks.total;
      const open = own.filter((r) => (r.metadata?.clarify as string[] | undefined)?.length);
      const started = !!tasks?.done || own.some((r) => implemented(r));
      if (open.length && started) {
        out.push({
          id: `spec-lifecycle:questions:${c.id}`,
          rule: "spec-lifecycle",
          category: "risk",
          severity: "warning",
          confidence: "high",
          title: `"${c.name}" is being built with ${open.length} requirement(s) still marked NEEDS CLARIFICATION`,
          detail: open.slice(0, 5).map((r) => `${r.name.slice(0, 80)}: ${(r.metadata!.clarify as string[]).join("; ")}`).join("\n"),
          nodes: [c.id, ...open.map((r) => r.id)],
        });
      }
      if (done && missing.length) {
        out.push({
          id: `spec-lifecycle:ticked:${c.id}`,
          rule: "spec-lifecycle",
          category: "risk",
          severity: "warning",
          confidence: "high",
          title: `Every task of "${c.name}" is ticked, but ${missing.length === 1 ? "code it names does" : `${missing.length} things it names do`} not exist`,
          detail: `${missing.slice(0, 6).map(({ r, x }) => `${x} (for "${r.name}")`).join(", ")}. Renamed, not built, or the tasks were ticked early.`,
          nodes: [c.id, ...new Set(missing.map(({ r }) => r.id))],
        });
      } else if (done && own.length && own.every(implemented) && !open.length && c.metadata?.format === "openspec") {
        out.push({
          id: `spec-lifecycle:archive:${c.id}`,
          rule: "spec-lifecycle",
          category: "risk",
          severity: "info",
          confidence: "medium",
          title: `"${c.name}" is complete and can be archived`,
          detail: `All ${tasks!.total} tasks are done and every requirement has code. Archive it (openspec archive ${String(c.metadata?.change ?? c.id)}) so its requirements move into the current specs.`,
          nodes: [c.id],
        });
      }
    }
    return out;
  },
};
