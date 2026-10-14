import type { FlowNode, Insight } from "@breadth/schema";
import type { Ctx } from "../context.js";
import type { Rule } from "../rule.js";

const ENTRY_NAMES = /^(main|__main__|constructor|__init__|__call__|setUp|tearDown|setup|teardown|handler|default|run|start|cli|app|lambda_handler|get|post|put|patch|delete|render)$/;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e)\/|(\.|_)(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$|conftest\.py$/;
const USES = new Set(["call", "event", "network", "data", "deploy"]);

/**
 * Functions nothing calls. Entry points, framework hooks, callbacks passed as values and tests
 * are skipped; public/exported functions are reported with low confidence, since they may be
 * used outside the scanned code. When traces exist, a function never seen at runtime in a
 * service that was traced counts as more evidence.
 */
export const deadCode: Rule = {
  id: "dead-code",
  category: "redundancy",
  title: "Dead code",
  description: "Functions with no callers in the collected graph. Code reached by reflection, cron jobs, other repositories or frameworks can look dead; treat these as leads.",
  run(ctx: Ctx) {
    const out: Insight[] = [];
    const lowByFile = new Map<string, FlowNode[]>();
    // services with runtime coverage
    const traced = new Set<string>();
    for (const id of ctx.seen) {
      const s = ctx.serviceOf(id);
      if (s) traced.add(s);
    }
    for (const n of ctx.graph.nodes) {
      if (n.kind !== "function" || !n.id.startsWith("code:fn:")) continue;
      const m = n.metadata ?? {};
      // nested helpers and closures are usually returned or passed along; leave them to linters
      if (n.parent && ctx.node(n.parent)?.kind === "function") continue;
      if (m.referenced || m.nameCalled || (Array.isArray(m.decorators) && m.decorators.length) || ENTRY_NAMES.test(n.name) || /^__\w+__$/.test(n.name)) continue;
      if (n.source?.file && TEST_FILE.test(n.source.file)) continue;
      if (/^test/i.test(n.name) || /^[A-Z]/.test(n.name)) continue; // tests, React components / constructors
      const callers = (ctx.in.get(n.id) ?? []).filter((e) => USES.has(e.kind) && e.from.node !== n.id);
      if (callers.length || ctx.seen.has(n.id)) continue;

      const svc = ctx.serviceOf(n.id);
      const neverSeen = !!svc && traced.has(svc) && ctx.executions.length > 0;
      const internal = m.visibility === "internal";
      const confidence = internal ? (neverSeen ? "high" : "medium") : neverSeen ? "medium" : "low";
      if (confidence === "low") {
        const file = n.parent ?? "";
        lowByFile.set(file, [...(lowByFile.get(file) ?? []), n]);
        continue;
      }
      out.push({
        id: `dead-code:${n.id}`,
        rule: "dead-code",
        category: "redundancy",
        severity: "info",
        confidence,
        title: `${n.name} is never called`,
        detail: `No calls to ${n.name} in the scanned code${neverSeen ? `, and it never ran in ${ctx.executions.length} recorded run${ctx.executions.length === 1 ? "" : "s"} of its service` : ""}.${internal ? "" : " It is public, so check other callers before removing it."}`,
        nodes: [n.id],
        metadata: { visibility: m.visibility, neverSeenAtRuntime: neverSeen },
      });
    }
    for (const [file, fns] of lowByFile) {
      if (!fns.length) continue;
      const names = fns.map((f) => f.name);
      out.push({
        id: `dead-code:public:${file}`,
        rule: "dead-code",
        category: "redundancy",
        severity: "info",
        confidence: "low",
        title: fns.length === 1 ? `${names[0]} has no callers in this repo` : `${fns.length} public functions in ${ctx.name(file)} have no callers here`,
        detail: `${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""}. They are public, so other packages or frameworks may call them.`,
        nodes: fns.map((f) => f.id),
      });
    }
    return out;
  },
};
