import { describe, expect, it } from "vitest";
import { EDGE_KINDS, LAYERS, type FlowGraph } from "@breadth/schema";
import { buildIndex, defaultFocus, ROOT } from "./model";
import { computeView, MORE_ID } from "./view";

const all = { layers: new Set(LAYERS), edgeKinds: new Set(EDGE_KINDS) };

const g: FlowGraph = {
  version: "1.0",
  nodes: [
    { id: "sys", name: "sys", kind: "system", layer: "code" },
    { id: "a", name: "a", kind: "service", layer: "code", parent: "sys" },
    { id: "b", name: "b", kind: "service", layer: "code", parent: "sys" },
    { id: "a.f", name: "f", kind: "function", layer: "code", parent: "a" },
    { id: "a.g", name: "g", kind: "function", layer: "code", parent: "a" },
    { id: "b.h", name: "h", kind: "function", layer: "code", parent: "b" },
    { id: "db", name: "db", kind: "datastore", layer: "runtime" },
  ],
  edges: [
    { id: "1", from: { node: "a.f" }, to: { node: "a.g" }, kind: "call", count: 2 },
    { id: "2", from: { node: "a.g" }, to: { node: "b.h" }, kind: "call", count: 1, protocol: "http" },
    { id: "3", from: { node: "a.f" }, to: { node: "b.h" }, kind: "call", count: 3 },
    { id: "4", from: { node: "db" }, to: { node: "b.h" }, kind: "read" },
    { id: "5", from: { node: "b.h" }, to: { node: "b.h" }, kind: "call", loop: true },
  ],
};

describe("computeView", () => {
  const idx = buildIndex(g);

  it("opens the only container when its siblings are leaves", () => {
    expect(defaultFocus(idx)).toBe("sys");
  });

  it("lifts edges to visible ancestors and folds them", () => {
    const v = computeView(idx, "sys", all);
    expect(v.nodes.map((n) => [n.id, n.ghost])).toEqual([["a", false], ["b", false], ["db", true]]);
    const ab = v.edges.find((e) => e.source === "a" && e.target === "b")!;
    expect(ab.count).toBe(4);
    expect(ab.folded).toBe(2);
    expect(ab.protocols).toEqual(["http"]);
    // a.f -> a.g is internal to a, and recursion inside b is hidden at this level
    expect(v.edges.some((e) => e.source === e.target)).toBe(false);
  });

  it("shows context nodes as ghosts when drilled in, and recursion as a self edge", () => {
    const v = computeView(idx, "b", all);
    expect(v.nodes.find((n) => n.id === "a")?.ghost).toBe(true);
    expect(v.edges.find((e) => e.source === "b.h" && e.target === "b.h")?.loop).toBe(true);
    expect(v.repOf("a.g")).toBe("a");
  });

  it("applies layer and edge filters", () => {
    const v = computeView(idx, "b", { layers: new Set(["code"]), edgeKinds: new Set(["call"]) });
    expect(v.nodes.some((n) => n.id === "db")).toBe(false);
  });

  it("caps the number of rendered nodes", () => {
    const big: FlowGraph = { version: "1.0", nodes: [], edges: [] };
    for (let i = 0; i < 300; i++) big.nodes.push({ id: `n${i}`, name: `n${i}`, kind: "function", layer: "code" });
    for (let i = 1; i < 300; i++) big.edges.push({ id: `e${i}`, from: { node: "n0" }, to: { node: `n${i}` }, kind: "call" });
    const v = computeView(buildIndex(big), ROOT, all);
    expect(v.nodes.length).toBeLessThanOrEqual(150);
    expect(v.nodes.find((n) => n.id === MORE_ID)?.more).toBe(151);
    expect(v.repOf("n299")).toBe(MORE_ID);
  });
});
