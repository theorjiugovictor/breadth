import { describe, expect, it } from "vitest";
import { mergeGraphs, validateGraph, type FlowGraph } from "./index.js";

const base: FlowGraph = {
  version: "1.0",
  nodes: [
    { id: "sys", name: "shop", kind: "system", layer: "code" },
    { id: "code:fn:a", name: "a", kind: "function", layer: "code", parent: "sys", aliases: ["fn:app.a"], inputs: [{ name: "x" }] },
    { id: "code:fn:b", name: "b", kind: "function", layer: "code", parent: "sys" },
  ],
  edges: [{ id: "call:a->b", from: { node: "code:fn:a" }, to: { node: "code:fn:b" }, kind: "call", count: 1 }],
};

describe("validateGraph", () => {
  it("accepts a valid graph", () => {
    expect(validateGraph(base)).toEqual({ valid: true, errors: [] });
  });
  it("rejects unknown kinds", () => {
    const r = validateGraph({ ...base, nodes: [{ id: "x", name: "x", kind: "lambda", layer: "code" }] });
    expect(r.valid).toBe(false);
  });
  it("rejects dangling references and parent cycles", () => {
    const g: FlowGraph = {
      version: "1.0",
      nodes: [
        { id: "a", name: "a", kind: "module", layer: "code", parent: "b" },
        { id: "b", name: "b", kind: "module", layer: "code", parent: "a" },
      ],
      edges: [{ id: "e", from: { node: "a" }, to: { node: "zzz" }, kind: "call" }],
    };
    const r = validateGraph(g);
    expect(r.valid).toBe(false);
    expect(r.errors.join("\n")).toMatch(/unknown target node "zzz"/);
    const r2 = validateGraph({ ...g, edges: [] });
    expect(r2.errors.join()).toMatch(/parent cycle/);
  });
});

describe("mergeGraphs", () => {
  it("unifies nodes by alias and re-points edges and steps", () => {
    const traces: FlowGraph = {
      version: "1.0",
      nodes: [
        { id: "svc:shop", name: "shop", kind: "service", layer: "runtime" },
        { id: "otel:fn:app.a", name: "a", kind: "function", layer: "runtime", aliases: ["fn:app.a"], inputs: [{ name: "x", type: "int" }, { name: "y" }] },
      ],
      edges: [{ id: "call:svc:shop->otel:fn:app.a", from: { node: "svc:shop" }, to: { node: "otel:fn:app.a" }, kind: "call", count: 3, samples: [{ value: 1 }] }],
      executions: [{ id: "otel:t1", steps: [{ id: "s1", node: "otel:fn:app.a", input: { x: 1 } }] }],
    };
    const m = mergeGraphs(base, traces);
    expect(validateGraph(m).valid).toBe(true);
    const a = m.nodes.find((n) => n.id === "code:fn:a")!;
    expect(a.kind).toBe("function");
    expect(a.layer).toBe("code");
    expect(a.inputs).toEqual([{ name: "x", type: "int" }, { name: "y" }]);
    expect(a.aliases).toContain("otel:fn:app.a");
    expect(m.nodes.some((n) => n.id === "otel:fn:app.a")).toBe(false);
    expect(m.edges.find((e) => e.to.node === "code:fn:a")?.id).toBe("call:svc:shop->code:fn:a");
    expect(m.executions?.[0].steps[0].node).toBe("code:fn:a");
  });

  it("dedupes edges by id and sums counts", () => {
    const m = mergeGraphs(base, base);
    expect(m.nodes).toHaveLength(3);
    expect(m.edges).toHaveLength(1);
    expect(m.edges[0].count).toBe(2);
  });
});
