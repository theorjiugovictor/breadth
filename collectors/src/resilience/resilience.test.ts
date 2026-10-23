import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateGraph, type FlowGraph } from "@breadth/schema";
import { runCollectors } from "../core/registry.js";
import { evaluateSlos, parseSlos, parseSpec } from "./openspec.js";

const shop = path.resolve(__dirname, "../../../examples/shop");
const rel = (g: FlowGraph, relation: string, from: string, to: string) => g.edges.find((e) => e.relation === relation && e.from.node === from && e.to.node === to);

describe("OpenSpec", () => {
  it("reads success criteria a machine can check", () => {
    expect(parseSlos("**THEN** p95 <= 200 ms and errors <= 1 % after recovery").map((s) => [s.metric, s.op, s.value])).toEqual([
      ["p95_ms", "<=", 200],
      ["error_pct", "<=", 1],
    ]);
    expect(parseSlos("p99 < 1.5 s, availability >= 99.9%, recovers within 2 min, no 5xx").map((s) => [s.metric, s.value])).toEqual([
      ["p99_ms", 1500],
      ["availability_pct", 99.9],
      ["recovery_s", 120],
    ]);
    expect(parseSlos("no 503 and no crash").map((s) => s.metric)).toEqual(["error_pct", "error_pct"]);
  });

  it("judges results deterministically, and never passes on missing data", () => {
    const slos = parseSlos("p95 <= 200 ms and errors <= 1 %");
    expect(evaluateSlos(slos, { p95_ms: 180, error_pct: 0.2 }).verdict).toBe("supports");
    expect(evaluateSlos(slos, { p95_ms: 250, error_pct: 0.2 }).verdict).toBe("contradicts");
    expect(evaluateSlos(slos, { p95_ms: 180 }).verdict).toBe("inconclusive");
    expect(evaluateSlos([], { p95_ms: 1 }).verdict).toBe("inconclusive");
  });

  it("parses requirements, scenarios, references and change deltas", () => {
    const cap = parseSpec(
      "# Cart Specification\n\n## ADDED Requirements\n\n### Requirement: Carts expire\nCarts SHALL expire.\n**Implemented by**: `expire_carts()`, POST /carts/expire\n\n#### Scenario: Old cart\n- **WHEN** a cart is 30 days old\n- **THEN** it is gone and p95 <= 50 ms\nVerified by: tests/test_cart.py::test_old\n",
      "openspec/changes/x/specs/cart/spec.md",
      "cart",
      "x",
    );
    expect(cap.id).toBe("change:x/spec:cart");
    const [r] = cap.requirements;
    expect(r).toMatchObject({ id: "req:cart/carts-expire", delta: "added", implementedBy: ["expire_carts()", "POST /carts/expire"] });
    expect(r.scenarios[0]).toMatchObject({ id: "scenario:cart/carts-expire/old-cart", verifiedBy: ["tests/test_cart.py::test_old"] });
    expect(r.scenarios[0].slos.map((s) => s.metric)).toEqual(["p95_ms"]);
  });
});

describe("resilience collector on the shop", async () => {
  const g = await runCollectors(shop, ["code", "resilience"], { exclude: ["**/generate.mjs", "traces/"] });
  const req = "req:checkout/checkout-survives-a-slow-database";

  it("produces a valid graph that declares its profile", () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
    expect(g.profiles).toEqual(["resilience-v1"]);
  });

  it("links code, routes and tests to requirements", () => {
    expect(rel(g, "implements", "code:fn:services/orders/app/main.py#create_order", req)).toBeTruthy();
    expect(rel(g, "implements", "route:services/orders/app/main.py#POST /orders", req)).toBeTruthy();
    // from "Verified by:" in the spec, and from @pytest.mark.requirement(...) in the test
    expect(rel(g, "verifies", "code:fn:services/orders/tests/test_resilience.py#test_postgres_latency", "scenario:checkout/checkout-survives-a-slow-database/postgres-latency")).toBeTruthy();
    expect(rel(g, "verifies", "code:fn:services/orders/tests/test_resilience.py#test_postgres_latency", req)).toBeTruthy();
    expect(g.nodes.find((n) => n.id === "req:refunds/support-agents-can-refund-many-orders-at-once")?.metadata?.unresolved).toEqual(["refund_orders", "POST /orders/refunds", "POST /refunds"]);
  });

  it("judges runs against the scenario's criteria", () => {
    expect(rel(g, "supports", "evidence:2026-10-20-postgres-latency", req)).toBeTruthy();
    expect(rel(g, "contradicts", "evidence:2026-10-20-postgres-down", req)).toBeTruthy();
    const down = g.nodes.find((n) => n.id === "evidence:2026-10-20-postgres-down")!;
    expect(down.metadata?.checks).toEqual([
      { metric: "error_pct", op: "<=", expected: 5, actual: 7.6, ok: false },
      { metric: "recovery_s", op: "<=", expected: 30, actual: 22, ok: true },
    ]);
    expect(rel(g, "approves", "approval:2026-10-20-postgres-down", "experiment:2026-10-20-postgres-down")).toBeTruthy();
    expect(rel(g, "targets", "experiment:2026-10-20-postgres-down", "route:services/orders/app/main.py#POST /orders")).toBeTruthy();
    expect(g.nodes.find((n) => n.id === "snapshot:source")?.metadata?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
