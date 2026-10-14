import { describe, expect, it } from "vitest";
import { diffGraphs, isEmptyDiff } from "./diff.js";
import type { FlowGraph } from "./types.js";

const base = (): FlowGraph =>
  ({
    version: "1",
    nodes: [
      { id: "a.py", kind: "module", layer: "code", name: "a.py" },
      { id: "a.py::f", kind: "function", layer: "code", name: "f", parent: "a.py", source: { file: "a.py", line: 1 }, inputs: [{ name: "x" }] },
      { id: "a.py::g", kind: "function", layer: "code", name: "g", parent: "a.py", source: { file: "a.py", line: 5 } },
    ],
    edges: [{ id: "e1", kind: "call", from: { node: "a.py::f" }, to: { node: "a.py::g" } }],
    executions: [],
  }) as unknown as FlowGraph;

describe("diffGraphs", () => {
  it("ignores moved line numbers", () => {
    const after = base();
    after.nodes[1].source = { file: "a.py", line: 9 };
    expect(isEmptyDiff(diffGraphs(base(), after))).toBe(true);
  });

  it("reports added, removed and changed nodes and edges", () => {
    const after = base();
    after.nodes = after.nodes.filter((n) => n.id !== "a.py::g");
    after.nodes[1].inputs = [{ name: "x" }, { name: "y" }];
    after.nodes.push({ id: "a.py::h", kind: "function", layer: "code", name: "h", parent: "a.py" } as never);
    after.edges = [{ id: "e2", kind: "call", from: { node: "a.py::f" }, to: { node: "a.py::h" } } as never];
    after.insights = [{ id: "i1", rule: "r", title: "t", severity: "info", nodes: ["a.py::h"] } as never];
    const d = diffGraphs(base(), after);
    expect(d.added).toEqual(["a.py::h"]);
    expect(d.removed).toEqual(["a.py::g"]);
    expect(d.changed).toEqual(["a.py::f"]);
    expect(d.edgesAdded).toEqual(["e2"]);
    expect(d.edgesRemoved).toEqual(["e1"]);
    expect(d.insightsAdded.map((i) => i.id)).toEqual(["i1"]);
    expect(isEmptyDiff(d)).toBe(false);
  });
});
