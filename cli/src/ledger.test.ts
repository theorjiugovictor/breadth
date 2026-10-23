import { describe, expect, it } from "vitest";
import type { FlowGraph } from "@breadth/schema";
import { behaviourUnits, computeDebt, emptyLedger, markReviewed, unitsInDiff } from "./ledger.js";

const g = (extra: { nodes?: object[]; edges?: object[] } = {}): FlowGraph =>
  ({
    version: "1.0",
    nodes: [
      { id: "svc", kind: "service", layer: "code", name: "api" },
      { id: "f", kind: "function", layer: "code", name: "save", parent: "svc", inputs: [{ name: "order" }] },
      { id: "h", kind: "function", layer: "code", name: "helper", parent: "svc" },
      { id: "db", kind: "datastore", layer: "infra", name: "postgres" },
      ...(extra.nodes ?? []),
    ],
    edges: [{ id: "w", kind: "write", from: { node: "f" }, to: { node: "db" }, label: "INSERT orders" }, ...(extra.edges ?? [])],
  }) as FlowGraph;

describe("comprehension ledger", () => {
  it("weighs units by what they do and counts unreviewed behaviour per service", () => {
    const units = behaviourUnits(g());
    expect([...units.values()].map((u) => [u.id, u.weight, u.service])).toEqual([
      ["f", 3, "api"],
      ["h", 1, "api"],
    ]);
    const ledger = emptyLedger();
    expect(computeDebt(units, ledger)).toMatchObject({ units: 2, unreviewed: 2, debt: 100 });
    markReviewed(ledger, [units.get("f")!], "alice");
    expect(computeDebt(units, ledger)).toMatchObject({ unreviewed: 1, debt: 25, byService: [{ service: "api", units: 2, unreviewed: 1, debt: 25 }] });
    expect(ledger.reviewed.f.by).toBe("alice");
  });

  it("puts a unit back to unreviewed when its behaviour changes, not when it gains a caller", () => {
    const ledger = emptyLedger();
    markReviewed(ledger, behaviourUnits(g()).values());
    // helper gains a caller: helper's own behaviour is the same; save now calls something new
    const changed = behaviourUnits(g({ edges: [{ id: "c", kind: "call", from: { node: "f" }, to: { node: "h" } }] }));
    const d = computeDebt(changed, ledger);
    expect(d.open.map((u) => u.id)).toEqual(["f"]);
    expect(unitsInDiff(changed, { added: [], changed: [], edgesAdded: ["c"], edgesRemoved: [] }, g({ edges: [{ id: "c", kind: "call", from: { node: "f" }, to: { node: "h" } }] })).map((u) => u.id).sort()).toEqual(["f", "h"]);
  });
});
