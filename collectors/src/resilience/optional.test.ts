import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCollectors } from "../core/registry.js";
import { resilienceCollector } from "./index.js";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "breadth-sdd-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
  return dir;
}
const app = { "app.py": "def refund_orders(ids):\n    return ids\n" };

describe("specs are optional", () => {
  it("adds nothing to a repository that keeps no specs", async () => {
    const dir = repo({ ...app, "specs/test_login.spec.ts": "it('logs in', () => {})\n", "specs/login/spec.md": "# Login tests\n\n- it works\n" });
    expect(await resilienceCollector.detect!(dir)).toBe(false);
    const g = await runCollectors(dir, undefined, {});
    expect(g.nodes.filter((n) => n.kind === "artifact")).toEqual([]);
    expect(g.profiles ?? []).not.toContain("resilience-v1");
  });
});

describe("Spec Kit and Kiro", () => {
  it("reads a Spec Kit feature and links its code", async () => {
    const dir = repo({
      ...app,
      ".specify/memory/constitution.md": "# Constitution\n",
      "specs/001-bulk-refunds/spec.md": [
        "# Feature Specification: Bulk refunds",
        "",
        "**Feature Branch**: `001-bulk-refunds`",
        "",
        "## User Scenarios & Testing",
        "",
        "### User Story 1 - Refund many orders (Priority: P1)",
        "",
        "An agent refunds a list of orders.",
        "Implemented by: refund_orders",
        "",
        "1. **Given** ten paid orders, **When** the agent refunds them, **Then** p95 <= 2 s",
        "",
        "## Requirements",
        "",
        "### Functional Requirements",
        "",
        "- **FR-001**: System MUST report each order's outcome",
      ].join("\n"),
      "specs/001-bulk-refunds/tasks.md": "- [x] T001 handler\n- [ ] T002 tests\n",
    });
    const g = await runCollectors(dir, undefined, {});
    const change = g.nodes.find((n) => n.role === "change")!;
    expect(change.metadata).toMatchObject({ format: "spec-kit", branch: "001-bulk-refunds", tasks: { done: 1, total: 2 } });
    const reqs = g.nodes.filter((n) => n.role === "requirement").map((n) => n.name);
    expect(reqs).toEqual(expect.arrayContaining(["Refund many orders", expect.stringMatching(/^FR-001/)]));
    expect(g.edges.some((e) => e.relation === "implements" && e.from.node.endsWith("#refund_orders"))).toBe(true);
    const sc = g.nodes.find((n) => n.role === "scenario")!;
    expect((sc.metadata?.slos as { metric: string }[]).map((s) => s.metric)).toEqual(["p95_ms"]);
  });

  it("reads a Kiro spec with EARS criteria", async () => {
    const dir = repo({
      ...app,
      ".kiro/specs/bulk-refunds/requirements.md": [
        "# Requirements Document",
        "",
        "## Introduction",
        "",
        "Refund many orders at once.",
        "",
        "### Requirement 1",
        "",
        "**User Story:** As a support agent, I want to refund many orders at once, so that I save time.",
        "Implemented by: refund_orders",
        "",
        "#### Acceptance Criteria",
        "",
        "1. WHEN an agent submits a list THEN the system SHALL respond with p95 under 2 s",
      ].join("\n"),
      ".kiro/specs/bulk-refunds/tasks.md": "- [x] 1. Handler\n",
    });
    const g = await runCollectors(dir, undefined, {});
    expect(g.nodes.find((n) => n.role === "change")?.metadata).toMatchObject({ format: "kiro", tasks: { done: 1, total: 1 } });
    expect(g.nodes.find((n) => n.role === "requirement")?.name).toBe("Refund many orders at once");
    expect(g.edges.some((e) => e.relation === "implements" && e.from.node.endsWith("#refund_orders"))).toBe(true);
  });
});
