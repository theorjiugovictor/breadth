import type { Insight, InsightCategory } from "@noodles/schema";
import type { Ctx } from "./context.js";

export interface RuleOptions {
  /** Thresholds, overridable per rule id: { "chatty-services": { minCalls: 10 } }. */
  [rule: string]: Record<string, number> | undefined;
}

export interface Rule {
  id: string;
  category: InsightCategory;
  title: string;
  /** One sentence on what the rule looks for and its blind spots. */
  description: string;
  run(ctx: Ctx, opts: Record<string, number>): Insight[];
}
