import type { FlowNode, Insight } from "@noodles/schema";
import type { Ctx } from "../context.js";
import type { Rule } from "../rule.js";

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e|docs?_src|examples?|benchmarks?|fixtures?)\/|(\.|_)(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$|conftest\.py$/;
const BANDS = 4;
const ROWS = 4;

/** "a and b", qualified with the class / file when the plain names are the same. */
function pairName(a: FlowNode, b: FlowNode): string {
  if (a.name !== b.name) return `${a.name} and ${b.name}`;
  const qa = String(a.metadata?.qualifiedName ?? a.name);
  const qb = String(b.metadata?.qualifiedName ?? b.name);
  if (qa !== qb) return `${qa} and ${qb}`;
  const fa = a.source?.file?.split("/").slice(-2).join("/") ?? "?";
  const fb = b.source?.file?.split("/").slice(-2).join("/") ?? "?";
  return `${a.name} in ${fa} and ${fb}`;
}

function similarity(a: number[], b: number[]): number {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/**
 * Functions with the same (or nearly the same) syntax structure, ignoring names, literals and
 * comments: copy-pasted logic that will drift apart when one copy is fixed.
 */
export const duplicateLogic: Rule = {
  id: "duplicate-logic",
  category: "redundancy",
  title: "Duplicate logic",
  description: "Functions whose bodies have identical or nearly identical structure (names and literals ignored). Tests, docs and examples are skipped.",
  run(ctx: Ctx, opts) {
    const minSimilarity = opts.minSimilarity ?? 0.8;
    const fns = ctx.graph.nodes.filter(
      (n) => n.kind === "function" && typeof n.metadata?.shape === "string" && typeof n.metadata?.sig === "string" && !TEST_FILE.test(n.source?.file ?? ""),
    );
    const lang = (n: FlowNode) => String(n.metadata?.language ?? "").replace("tsx", "typescript").replace("javascript", "typescript");

    // union-find over exact matches and LSH candidate pairs
    const parent = new Map(fns.map((n) => [n.id, n.id]));
    const find = (x: string): string => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)!)!);
        x = parent.get(x)!;
      }
      return x;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));
    const exactPairs = new Set<string>();

    const byShape = new Map<string, FlowNode[]>();
    for (const n of fns) {
      const key = `${lang(n)}|${n.metadata!.shape}`;
      byShape.set(key, [...(byShape.get(key) ?? []), n]);
    }
    for (const group of byShape.values()) {
      for (let i = 1; i < group.length; i++) {
        union(group[0].id, group[i].id);
        exactPairs.add(group[0].id);
        exactPairs.add(group[i].id);
      }
    }

    const sigs = new Map(fns.map((n) => [n.id, String(n.metadata!.sig).split(".").map((x) => parseInt(x, 36))]));
    const sizes = new Map(fns.map((n) => [n.id, Number(n.metadata!.size)]));
    const nearSim = new Map<string, number>();
    for (let b = 0; b < BANDS; b++) {
      const buckets = new Map<string, FlowNode[]>();
      for (const n of fns) {
        const key = `${lang(n)}|${sigs.get(n.id)!.slice(b * ROWS, (b + 1) * ROWS).join(",")}`;
        buckets.set(key, [...(buckets.get(key) ?? []), n]);
      }
      for (const bucket of buckets.values()) {
        if (bucket.length < 2 || bucket.length > 50) continue; // huge buckets are boilerplate
        for (let i = 0; i < bucket.length; i++) {
          for (let j = i + 1; j < bucket.length; j++) {
            const a = bucket[i].id;
            const c = bucket[j].id;
            const ratio = sizes.get(a)! / sizes.get(c)!;
            if (ratio < 0.7 || ratio > 1.43) continue;
            const sim = similarity(sigs.get(a)!, sigs.get(c)!);
            if (sim < minSimilarity) continue;
            union(a, c);
            nearSim.set(find(a), Math.min(nearSim.get(find(a)) ?? 1, sim));
          }
        }
      }
    }

    const clusters = new Map<string, FlowNode[]>();
    for (const n of fns) {
      const r = find(n.id);
      clusters.set(r, [...(clusters.get(r) ?? []), n]);
    }
    const out: Insight[] = [];
    for (const [root, members] of clusters) {
      if (members.length < 2) continue;
      // the same function scanned twice (e.g. vendored copies) still counts: different ids
      const exact = members.every((m) => exactPairs.has(m.id)) && new Set(members.map((m) => m.metadata!.shape)).size === 1;
      const sizesInGroup = members.map((m) => sizes.get(m.id)!);
      const lines = members.reduce((t, m) => t + Math.max(1, (m.source?.endLine ?? 0) - (m.source?.line ?? 0) + 1), 0);
      const sameParams = new Set(members.map((m) => (m.inputs ?? []).length)).size === 1;
      out.push({
        id: `duplicate-logic:${members.map((m) => m.id).sort().join("|")}`,
        rule: "duplicate-logic",
        category: "redundancy",
        severity: "info",
        confidence: exact ? "high" : "medium",
        title: `${members.length === 2 ? pairName(members[0], members[1]) : `${members.length} functions`} ${exact ? "have identical structure" : "are nearly identical"}`,
        detail: `${members.map((m) => `${m.name} (${m.source?.file ?? "?"})`).slice(0, 5).join(", ")}${members.length > 5 ? ", …" : ""}. ${
          exact ? "Same syntax tree once names and literals are ignored" : `About ${Math.round((nearSim.get(root) ?? minSimilarity) * 100)}% structural overlap`
        }${sameParams ? ", same number of parameters" : ""}, ${lines} lines in total. A shared helper keeps fixes in one place.`,
        nodes: members.map((m) => m.id),
        metadata: { sizes: sizesInGroup, exact },
      });
    }
    return out;
  },
};
