import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCollectors } from "@breadth/collectors";
import { loadWorkspace, scanWorkspace, stageOne } from "./workspace.js";

const root = mkdtempSync(path.join(tmpdir(), "breadth-ws-"));
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });

beforeAll(() => {
  process.env.BREADTH_CACHE = path.join(root, ".cache");
  // orders: serves POST /refunds
  write("orders/requirements.txt", "fastapi\n");
  write("orders/app.py", 'from fastapi import FastAPI\napp = FastAPI()\n\n@app.post("/refunds")\ndef refund():\n    return {}\n');
  // web: calls it over HTTP by service name
  write("web/package.json", '{ "name": "web" }\n');
  write("web/api.js", 'async function refundAll() {\n  return fetch("http://orders:8080/refunds", { method: "POST" });\n}\nmodule.exports = { refundAll };\n');
  // billing: a git repository, cloned by the workspace
  write("billing-src/requirements.txt", "requests\n");
  write("billing-src/billing.py", 'import requests\n\ndef settle():\n    return requests.post("http://orders/refunds")\n');
  git(path.join(root, "billing-src"), "init", "-q");
  git(path.join(root, "billing-src"), "-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
  git(path.join(root, "billing-src"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
});
afterAll(() => {
  delete process.env.BREADTH_CACHE;
});

describe("workspace", () => {
  it("scans repositories from disk and git as one system, matching HTTP calls between them", async () => {
    write("ws/breadth.workspace.json", JSON.stringify({ repos: [{ name: "orders", path: "../orders" }, { name: "web", path: "../web" }, { name: "billing", git: `file://${path.join(root, "billing-src")}` }] }));
    const { graph } = await scanWorkspace(loadWorkspace(path.join(root, "ws/breadth.workspace.json")), {});
    const route = "route:orders/app.py#POST /refunds";
    expect(graph.nodes.find((n) => n.id === route)?.metadata?.service).toBe("orders");
    expect(graph.edges.some((e) => e.from.node === "code:fn:web/api.js#refundAll" && e.to.node === route)).toBe(true);
    expect(graph.edges.some((e) => e.from.node === "code:fn:billing/billing.py#settle" && e.to.node === route)).toBe(true);
    expect(graph.sources?.filter((s) => s.collector === "workspace").map((s) => s.target.split(":")[0])).toEqual(["orders", "web", "billing"]);
  });

  it("merges a graph published by another repository's CI and links its calls", async () => {
    const pub = await runCollectors(stageOne(path.join(root, "web"), "web"), undefined, {});
    writeFileSync(path.join(root, "web.json"), JSON.stringify(pub));
    // scanned alone, web cannot know where /refunds is served
    expect(pub.edges.some((e) => e.to.node.startsWith("ext:http:orders"))).toBe(true);
    write("ws2/breadth.workspace.json", JSON.stringify({ repos: [{ name: "orders", path: "../orders" }, { name: "web", graph: "../web.json" }] }));
    const { graph, warnings } = await scanWorkspace(loadWorkspace(path.join(root, "ws2/breadth.workspace.json")), {});
    expect(warnings).toEqual([]);
    expect(graph.edges.some((e) => e.from.node === "code:fn:web/api.js#refundAll" && e.to.node === "route:orders/app.py#POST /refunds")).toBe(true);
    expect(graph.nodes.some((n) => n.id === "ext:http:orders")).toBe(false);
    expect(graph.nodes.filter((n) => n.id.startsWith("code:repo:")).map((n) => n.id)).toEqual(["code:repo:workspace"]);
  });

  it("warns about a graph not published under its name, and rejects bad files", async () => {
    writeFileSync(path.join(root, "plain.json"), JSON.stringify(await runCollectors(path.join(root, "web"), undefined, {})));
    write("ws3/breadth.workspace.json", JSON.stringify({ repos: [{ name: "orders", path: "../orders" }, { name: "web", graph: "../plain.json" }] }));
    expect((await scanWorkspace(loadWorkspace(path.join(root, "ws3/breadth.workspace.json")), {})).warnings[0]).toMatch(/breadth scan --as web/);
    write("bad.json", JSON.stringify({ repos: [{ name: "a", path: "x", git: "y" }] }));
    expect(() => loadWorkspace(path.join(root, "bad.json"))).toThrow(/exactly one of path, git or graph/);
  });
});
