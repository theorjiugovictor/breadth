import { describe, expect, it } from "vitest";
import type { FlowGraph } from "@breadth/schema";
import { describeChanges } from "./changes.js";
import { checkSpec } from "./spec.js";

const g = (nodes: object[], edges: object[]): FlowGraph => ({ version: "1.0", nodes, edges }) as unknown as FlowGraph;
const fn = (id: string, file = "app.py") => ({ id, kind: "function", layer: "code", name: id, source: { file } });
const db = { id: "store:pg", kind: "datastore", layer: "infra", name: "postgresql" };
const spec = [
  { id: "change:add-refunds", kind: "artifact", layer: "resilience", role: "change", name: "Add refunds", metadata: { change: "add-refunds", format: "openspec", tasks: { done: 1, total: 2 } } },
  { id: "req:refunds/refund", kind: "artifact", layer: "resilience", role: "requirement", name: "Refund an order", parent: "change:add-refunds", metadata: { change: "add-refunds" } },
];
const impl = { id: "i1", kind: "depends_on", relation: "implements", from: { node: "refund" }, to: { node: "req:refunds/refund" } };

describe("checkSpec", () => {
  const before = g([...spec, fn("refund"), fn("save"), fn("charge", "billing.py"), db], [impl, { id: "c", kind: "call", from: { node: "refund" }, to: { node: "save" } }]);
  const after = g([...spec, fn("refund"), fn("save"), fn("charge", "billing.py"), db], [
    impl,
    { id: "c", kind: "call", from: { node: "refund" }, to: { node: "save" } },
    { id: "w1", kind: "write", from: { node: "save" }, to: { node: "store:pg" } },
    { id: "w2", kind: "write", from: { node: "charge" }, to: { node: "store:pg" } },
  ]);
  const d = describeChanges(before, after);

  it("links by branch and flags what the change's code never reaches", () => {
    const s = checkSpec(before, after, d, { branch: "feature/add-refunds" })!;
    expect(s.changes[0]).toMatchObject({ id: "add-refunds", format: "openspec", tasks: { done: 1, total: 2 }, requirements: { total: 1, implemented: 1 } });
    expect(s.changes[0].reasons[0]).toMatch(/branch/);
    const outside = s.outOfScope.map((i) => d.changes[i].text);
    expect(outside.some((t) => t.startsWith("charge"))).toBe(true);
    expect(outside.some((t) => t.startsWith("save"))).toBe(false);
    expect(s.scoped).toBe(true);
  });

  it("links by an explicit id or a mention in the description", () => {
    expect(checkSpec(before, after, d, { change: "add-refunds" })!.changes[0].reasons).toContain("named with --spec-change");
    expect(checkSpec(before, after, d, { text: "Implements add-refunds." })!.changes[0].reasons).toContain("mentioned in the pull request");
  });

  it("says so once when the repository has specs but nothing links", () => {
    expect(checkSpec(before, after, d, { branch: "fix-typo" })).toEqual({ changes: [], outOfScope: [], noChange: true });
  });

  it("is silent for repositories without specs", () => {
    const strip = (x: FlowGraph) => g(x.nodes.filter((n) => n.kind !== "artifact"), x.edges.filter((e) => !e.relation));
    expect(checkSpec(strip(before), strip(after), describeChanges(strip(before), strip(after)), { branch: "add-refunds" })).toBeUndefined();
  });
});
