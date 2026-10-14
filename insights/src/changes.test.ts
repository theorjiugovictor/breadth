import { describe, expect, it } from "vitest";
import type { FlowGraph } from "@breadth/schema";
import { describeChanges, diffGraph, withoutRemoved } from "./changes.js";

const fn = (id: string, name: string, inputs: string[] = []) => ({ id, kind: "function", layer: "code", name, parent: "f", source: { file: "a.py" }, inputs: inputs.map((n) => ({ name: n })) });
const g = (nodes: object[], edges: object[]): FlowGraph =>
  ({ version: "1.0", nodes: [{ id: "f", kind: "module", layer: "code", name: "a.py" }, ...nodes], edges }) as unknown as FlowGraph;

const db = { id: "store:pg", kind: "datastore", layer: "infra", name: "postgresql" };
const stripe = { id: "ext:http:api.stripe.com", kind: "external_api", layer: "network", name: "api.stripe.com" };

describe("describeChanges", () => {
  const before = g([fn("save", "save"), fn("charge", "charge", ["amount"]), fn("main", "main"), fn("old", "old"), db, stripe], [
    { id: "c1", kind: "call", from: { node: "main" }, to: { node: "charge" } },
    { id: "c2", kind: "call", from: { node: "main" }, to: { node: "old" } },
  ]);
  const after = g(
    [fn("save", "save"), fn("charge", "charge", ["amount", "currency"]), fn("main", "main"), db, stripe, { id: "ep", kind: "network_endpoint", layer: "network", name: "POST /refund" }],
    [
      { id: "c1", kind: "call", from: { node: "main" }, to: { node: "charge" }, loop: true },
      { id: "w1", kind: "write", from: { node: "save" }, to: { node: "store:pg" }, label: "UPDATE orders" },
      { id: "x1", kind: "call", from: { node: "charge" }, to: { node: "ext:http:api.stripe.com" }, label: "POST /v1/refunds" },
    ],
  );
  const r = describeChanges(before, after, { base: "main", head: "pr" });
  const texts = r.changes.map((c) => c.text);

  it("names the behaviour, not the lines", () => {
    expect(texts).toContain("save now writes to postgresql (UPDATE orders)");
    expect(texts).toContain("charge now calls the external API api.stripe.com (POST /v1/refunds)");
    expect(texts).toContain("new endpoint POST /refund");
    expect(texts).toContain("main now calls charge inside a loop");
    expect(texts.some((t) => t.startsWith("charge(amount) → charge(amount, currency), called from 1 place"))).toBe(true);
  });

  it("ranks what needs attention first and counts the rest", () => {
    expect(r.changes[0].severity).toBe("high");
    expect(r.counts).toMatchObject({ functionsRemoved: 1, endpointsAdded: 1, edgesAdded: 2, edgesRemoved: 1 });
    expect(r.base).toBe("main");
  });

  it("reports nothing when only positions moved", () => {
    const moved = structuredClone(before);
    moved.nodes[1].source = { file: "a.py", line: 99 };
    expect(describeChanges(before, moved).changes).toEqual([]);
  });

  it("builds one graph that holds both versions", () => {
    const d = diffGraph(before, after, r);
    expect(d.diff?.changes.length).toBe(r.changes.length);
    expect(d.nodes.find((n) => n.id === "old")?.metadata?.diff).toBe("removed");
    expect(d.nodes.find((n) => n.id === "ep")?.metadata?.diff).toBe("added");
    expect(d.edges.find((e) => e.id === "c2")?.metadata?.diff).toBe("removed");
    expect(withoutRemoved(d).nodes.some((n) => n.id === "old")).toBe(false);
  });
});
