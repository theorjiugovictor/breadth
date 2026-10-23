import type { Insight } from "@breadth/schema";
import type { Rule } from "../rule.js";

/** Owners whose actions are maintained by the platform itself. */
const FIRST_PARTY = /^(actions|github)\//;

/** Known-dangerous CI configurations, from the cicd collector's workflow and job nodes. */
export const ciRisk: Rule = {
  id: "ci-risk",
  category: "risk",
  title: "Risky CI configuration",
  description: "GitHub Actions setups that hand secrets or write access to code from outside: pull_request_target jobs that check out the pull request's code, write-all permissions, third-party actions not pinned to a commit.",
  run(ctx) {
    const out: Insight[] = [];
    for (const wf of ctx.graph.nodes) {
      if (wf.metadata?.platform !== "github-actions" || wf.parent) continue;
      const triggers = (wf.inputs ?? []).map((p) => p.name);
      const jobs = ctx.graph.nodes.filter((n) => n.parent === wf.id);
      if (triggers.includes("pull_request_target")) {
        for (const j of jobs) {
          const ref = String(j.metadata?.checkout_ref ?? "");
          if (!/pull_request\.head|head_ref|refs\/pull/.test(ref)) continue;
          out.push({
            id: `ci-risk:prt:${j.id}`,
            rule: "ci-risk",
            category: "risk",
            severity: "critical",
            confidence: "high",
            title: `${j.name} runs pull request code with the repository's secrets`,
            detail: `${wf.name} is triggered by pull_request_target, which runs with write access and secrets, and this job checks out the pull request's own code (${ref}). Anyone who opens a pull request can run code with those permissions. Use pull_request, or keep the untrusted checkout away from secrets and write tokens.`,
            nodes: [j.id, wf.id],
          });
        }
      }
      const perms = [wf.metadata?.permissions, ...jobs.map((j) => j.metadata?.permissions)];
      if (perms.some((p) => p === "write-all")) {
        out.push({ id: `ci-risk:perms:${wf.id}`, rule: "ci-risk", category: "risk", severity: "warning", confidence: "high", title: `${wf.name} grants every permission to its token`, detail: "permissions: write-all lets any step change code, releases and settings. List only the scopes the jobs need.", nodes: [wf.id] });
      }
      const unpinned = [...new Set(jobs.flatMap((j) => (j.metadata?.uses as string[] | undefined) ?? []))].filter((u) => !u.startsWith("./") && !u.startsWith("docker://") && !FIRST_PARTY.test(u) && !/@[0-9a-f]{40}$/.test(u));
      if (unpinned.length) {
        out.push({
          id: `ci-risk:unpinned:${wf.id}`,
          rule: "ci-risk",
          category: "risk",
          severity: "info",
          confidence: "medium",
          title: `${wf.name} uses ${unpinned.length} third-party action${unpinned.length === 1 ? "" : "s"} by tag`,
          detail: `${unpinned.join(", ")}: a tag can be moved to different code. Pin to a full commit SHA to run exactly what was reviewed.`,
          nodes: [wf.id],
          metadata: { actions: unpinned },
        });
      }
    }
    return out;
  },
};
