import { describe, expect, it } from "vitest";
import { isSpecKit, parseKiro, parseSpecKit } from "./formats.js";
import { parseSlos } from "./openspec.js";

const SPEC_KIT = `# Feature Specification: Bulk refunds

**Feature Branch**: \`003-bulk-refunds\`
**Input**: User description: "support agents refund many orders at once"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Refund a batch of orders (Priority: P1)

An agent selects orders and refunds them in one go.

**Why this priority**: incidents create hundreds of refunds.

**Acceptance Scenarios**:

1. **Given** 50 paid orders, **When** the agent refunds them, **Then** every order is refunded once and p95 under 2 s
2. **Given** an already refunded order, **When** it is in the batch, **Then** it is skipped

Implemented by: refund_orders, POST /orders/refunds

### Edge Cases

- What happens when Stripe is down?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST refund each order at most once
- **FR-002**: System MUST report the outcome of each order
  Verified by: tests/test_refunds.py::test_outcomes

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Batch refunds finish with less than 1% errors
`;

const KIRO = `# Requirements Document

## Introduction

Support agents refund many orders at once.

## Requirements

### Requirement 1

**User Story:** As a support agent, I want to refund many orders at once, so that incidents are cleaned up quickly

#### Acceptance Criteria

1. WHEN an agent submits 50 orders THEN the system SHALL refund each one and answer with p95 below 2 s
2. IF an order was refunded already THEN the system SHALL skip it

Implemented by: refund_orders
`;

describe("spec formats", () => {
  it("reads natural criteria phrasing", () => {
    expect(parseSlos("p95 under 2 s and less than 1% errors, 99.9% availability").map((s) => [s.metric, s.op, s.value])).toEqual([
      ["p95_ms", "<", 2000],
      ["error_pct", "<", 1],
      ["availability_pct", ">=", 99.9],
    ]);
  });

  it("reads Spec Kit: user stories, functional requirements, success criteria, tasks and the branch", () => {
    expect(isSpecKit(SPEC_KIT)).toBe(true);
    expect(isSpecKit("# Login spec\n\ndescribe('login', ...)")).toBe(false);
    const { change, capability } = parseSpecKit("003-bulk-refunds", "specs/003-bulk-refunds/spec.md", SPEC_KIT, "- [X] T001 model\n- [ ] T002 [US1] endpoint\n");
    expect(change).toMatchObject({ id: "003-bulk-refunds", title: "Bulk refunds", format: "spec-kit", branch: "003-bulk-refunds", tasks: { done: 1, total: 2 } });
    const ids = capability.requirements.map((r) => r.id);
    expect(ids).toEqual(["req:003-bulk-refunds/us1-refund-a-batch-of-orders", "req:003-bulk-refunds/fr-001", "req:003-bulk-refunds/fr-002", "req:003-bulk-refunds/success-criteria"]);
    const [story, , fr2, sc] = capability.requirements;
    expect(story.implementedBy).toEqual(["refund_orders", "POST /orders/refunds"]);
    expect(story.scenarios).toHaveLength(2);
    expect(story.scenarios[0].slos.map((s) => s.metric)).toEqual(["p95_ms"]);
    expect(fr2.verifiedBy).toEqual(["tests/test_refunds.py::test_outcomes"]);
    expect(sc.scenarios[0].slos).toMatchObject([{ metric: "error_pct", op: "<", value: 1 }]);
  });

  it("reads Kiro: requirements named by their user story, EARS acceptance criteria", () => {
    const { change, capability } = parseKiro("bulk-refunds", ".kiro/specs/bulk-refunds/requirements.md", KIRO, "- [x] 1. Endpoint\n- [ ] 2. Receipts\n");
    expect(change).toMatchObject({ id: "bulk-refunds", format: "kiro", tasks: { done: 1, total: 2 } });
    const [r] = capability.requirements;
    expect(r).toMatchObject({ id: "req:bulk-refunds/requirement-1", name: "Refund many orders at once", implementedBy: ["refund_orders"] });
    expect(r.scenarios.map((s) => s.slos.map((x) => x.metric))).toEqual([["p95_ms"], []]);
  });
});
