import type { FlowGraph, Insight, Severity } from "@breadth/schema";
import { Ctx } from "./context.js";
import type { Rule, RuleOptions } from "./rule.js";
import { dataExposure } from "./rules/data-exposure.js";
import { nPlusOne } from "./rules/n-plus-one.js";
import { orphanInfra } from "./rules/orphan-infra.js";
import { raceRisk } from "./rules/race-risk.js";
import { repeatedWork } from "./rules/repeated-work.js";
import { chattyServices, longHopChain } from "./rules/services.js";
import { deadCode } from "./rules/dead-code.js";
import { runtimeMismatch } from "./rules/runtime-mismatch.js";
import { unhandledErrors } from "./rules/unhandled-errors.js";
import { missedParallelism } from "./rules/missed-parallelism.js";
import { contractDrift } from "./rules/contract-drift.js";
import { duplicateLogic } from "./rules/duplicate-logic.js";
import { broadIam, internetExposed, publicData, unencryptedStorage } from "./rules/infra-posture.js";
import { iamUsage } from "./rules/iam-usage.js";
import { ciRisk } from "./rules/ci-risk.js";
import { contractGap } from "./rules/contract-gap.js";
import { evidenceStatus } from "./rules/evidence-status.js";
import { unexercised } from "./rules/unexercised.js";

export type { Rule, RuleOptions } from "./rule.js";
export { Ctx } from "./context.js";
export { sensitiveFields } from "./rules/data-exposure.js";
export { expectedKinds } from "./rules/contract-drift.js";
export { describeChanges, diffGraph, withoutRemoved, type ChangeReport } from "./changes.js";
export { behaviourUnits, serviceFingerprint, type Unit } from "./units.js";
export { staleEvidence } from "./rules/evidence-status.js";
export { checkSpec, type SpecHints } from "./spec.js";

export const RULES: Rule[] = [
  nPlusOne,
  repeatedWork,
  missedParallelism,
  chattyServices,
  longHopChain,
  deadCode,
  duplicateLogic,
  orphanInfra,
  internetExposed,
  publicData,
  unencryptedStorage,
  broadIam,
  iamUsage,
  ciRisk,
  contractGap,
  evidenceStatus,
  unexercised,
  raceRisk,
  dataExposure,
  contractDrift,
  unhandledErrors,
  runtimeMismatch,
];

export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export interface InsightOptions {
  /** Only run these rule ids. */
  rules?: string[];
  /** Per-rule thresholds. */
  thresholds?: RuleOptions;
}

/** Run every rule over a graph. Pure; safe in Node and the browser. */
export function runInsights(graph: FlowGraph, opts: InsightOptions = {}): Insight[] {
  const ctx = new Ctx(graph);
  const out = new Map<string, Insight>();
  for (const rule of RULES) {
    if (opts.rules && !opts.rules.includes(rule.id)) continue;
    let found: Insight[];
    try {
      found = rule.run(ctx, opts.thresholds?.[rule.id] ?? {});
    } catch (err) {
      // A broken rule must never break the canvas.
      console.warn(`breadth insights: rule ${rule.id} failed: ${(err as Error).message}`);
      continue;
    }
    for (const i of found) {
      const nodes = [...new Set(i.nodes)].filter((n) => ctx.nodes.has(n));
      if (!nodes.length || out.has(i.id)) continue;
      out.set(i.id, { ...i, nodes });
    }
  }
  const conf = { high: 0, medium: 1, low: 2 } as const;
  return [...out.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      conf[a.confidence ?? "medium"] - conf[b.confidence ?? "medium"] ||
      a.rule.localeCompare(b.rule) ||
      a.title.localeCompare(b.title),
  );
}
