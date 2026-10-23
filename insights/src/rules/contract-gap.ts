import type { Insight } from "@breadth/schema";
import type { Rule } from "../rule.js";

/**
 * AsyncAPI contracts compared with the code: a declared consumer of a topic nothing publishes
 * (it waits forever), and a topic code publishes that no contract declares (consumers have
 * nothing to build against). Only when contracts were collected.
 */
export const contractGap: Rule = {
  id: "contract-gap",
  category: "risk",
  title: "Message contract and code disagree",
  description: "With AsyncAPI documents collected: topics a contract says an application receives but no collected code publishes, and topics code publishes that no contract declares.",
  run(ctx) {
    const out: Insight[] = [];
    // contract nodes merge into the services they describe; their edges keep the mark
    if (!ctx.graph.edges.some((e) => e.metadata?.contract)) return out;
    const fromContract = (e: { metadata?: Record<string, unknown> }) => !!e.metadata?.contract;
    for (const t of ctx.graph.nodes) {
      if (t.kind !== "queue" || !t.metadata?.topic) continue;
      const ins = ctx.in.get(t.id) ?? [];
      const outs = ctx.out.get(t.id) ?? [];
      const publishers = ins.filter((e) => e.kind === "event" && !fromContract(e));
      const declared = !!t.metadata?.declared_in || [...ins, ...outs].some(fromContract);
      const contractReceivers = outs.filter((e) => e.kind === "event" && fromContract(e));
      if (contractReceivers.length && !publishers.length && !ins.some((e) => e.kind === "event" && fromContract(e))) {
        const who = contractReceivers.map((e) => ctx.name(e.to.node));
        out.push({
          id: `contract-gap:unpublished:${t.id}`,
          rule: "contract-gap",
          category: "risk",
          severity: "info",
          confidence: "medium",
          title: `${who.join(", ")} expect${who.length === 1 ? "s" : ""} ${t.name}, but nothing publishes it`,
          detail: `The contract (${String(contractReceivers[0].metadata?.contract)}) says ${who.join(", ")} receive${who.length === 1 ? "s" : ""} ${t.name}; no collected code or contract sends to it. A planned feature, a producer outside this repository, or a dead subscription.`,
          nodes: [t.id, ...contractReceivers.map((e) => e.to.node)],
        });
      }
      if (!declared && publishers.length) {
        out.push({
          id: `contract-gap:undeclared:${t.id}`,
          rule: "contract-gap",
          category: "risk",
          severity: "info",
          confidence: "medium",
          title: `${t.name} is published but no contract declares it`,
          detail: `${publishers.map((e) => ctx.name(e.from.node)).join(", ")} send${publishers.length === 1 ? "s" : ""} to ${t.name}, and none of the AsyncAPI documents mention it. Consumers have no schema to build against.`,
          nodes: [t.id, ...publishers.map((e) => e.from.node)],
        });
      }
    }
    return out;
  },
};
