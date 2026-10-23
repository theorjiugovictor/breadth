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

describe("real-world template shapes", () => {
  it("Spec Kit: ignores template comments and separators, counts tasks per story, keeps open questions", async () => {
    const dir = repo({
      ...app,
      "specs/002-refunds/spec.md": [
        "# Feature Specification: Refunds",
        "",
        "**Feature Branch**: `002-refunds`",
        "**Input**: User description: \"let agents refund orders\"",
        "",
        "## User Scenarios & Testing *(mandatory)*",
        "",
        "<!--",
        "  IMPORTANT: User stories should be PRIORITIZED",
        "-->",
        "",
        "### User Story 1 - Refund one order (Priority: P1)",
        "",
        "An agent refunds a paid order from the order page.",
        "",
        "**Why this priority**: most tickets are refunds.",
        "",
        "**Acceptance Scenarios**:",
        "",
        "1. **Given** a paid order, **When** the agent refunds it, **Then** the customer is credited within 5 s",
        "",
        "---",
        "",
        "### User Story 2 - Refund many orders (Priority: P2)",
        "",
        "Bulk refunds from a list.",
        "",
        "---",
        "",
        "## Requirements *(mandatory)*",
        "",
        "### Functional Requirements",
        "",
        "- **FR-001**: System MUST record who refunded each order",
        "- **FR-002**: System MUST keep refund records for [NEEDS CLARIFICATION: retention period not specified]",
      ].join("\n"),
      "specs/002-refunds/tasks.md": ["- [x] T001 Setup", "- [x] T010 [P] [US1] Refund handler in app.py", "- [ ] T011 [US1] Test", "- [ ] T020 [US2] Bulk handler"].join("\n"),
    });
    const g = await runCollectors(dir, undefined, {});
    const us1 = g.nodes.find((n) => n.id === "req:002-refunds/us1-refund-one-order")!;
    expect(us1.description).toBe("Priority P1. An agent refunds a paid order from the order page.");
    expect(us1.metadata?.tasks).toEqual({ done: 1, total: 2 });
    expect(g.nodes.find((n) => n.id === "req:002-refunds/us2-refund-many-orders")?.metadata?.tasks).toEqual({ done: 0, total: 1 });
    expect(g.nodes.find((n) => n.id === "req:002-refunds/fr-002")?.metadata?.clarify).toEqual(["retention period not specified"]);
    expect(g.nodes.find((n) => n.role === "change")?.metadata?.tasks).toEqual({ done: 2, total: 4 });
  });

  it("Kiro: counts tasks per requirement from _Requirements:_ lines, sub-tasks included", async () => {
    const dir = repo({
      ...app,
      ".kiro/specs/refunds/requirements.md": [
        "# Requirements Document",
        "",
        "## Introduction",
        "",
        "Refunds for support agents.",
        "",
        "## Requirements",
        "",
        "### Requirement 1",
        "",
        "**User Story:** As a support agent, I want to refund an order, so that customers get their money back",
        "",
        "#### Acceptance Criteria",
        "",
        "1. WHEN an agent refunds a paid order THEN the system SHALL credit the customer",
        "2. IF the order is unpaid THEN the system SHALL reject the refund",
        "",
        "### Requirement 2",
        "",
        "**User Story:** As an auditor, I want a log of refunds, so that I can review them",
        "",
        "#### Acceptance Criteria",
        "",
        "1. WHEN a refund completes THE system SHALL record the agent and amount",
      ].join("\n"),
      ".kiro/specs/refunds/tasks.md": [
        "# Implementation Plan",
        "",
        "- [x] 1. Refund endpoint",
        "  - Add the handler",
        "  - _Requirements: 1.1, 1.2_",
        "",
        "- [ ] 2. Audit log",
        "  - [x] 2.1 Table",
        "    - _Requirements: 2.1_",
        "  - [ ] 2.2 Writer",
        "    - _Requirements: 2.1_",
      ].join("\n"),
    });
    const g = await runCollectors(dir, undefined, {});
    const r1 = g.nodes.find((n) => n.id === "req:refunds/requirement-1")!;
    expect(r1.name).toBe("Refund an order");
    expect(g.nodes.filter((n) => n.role === "scenario" && n.parent === r1.id)).toHaveLength(2);
    expect(r1.metadata?.tasks).toEqual({ done: 1, total: 1 });
    expect(g.nodes.find((n) => n.id === "req:refunds/requirement-2")?.metadata?.tasks).toEqual({ done: 1, total: 2 });
  });
});
