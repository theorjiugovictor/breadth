import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateGraph, type FlowGraph } from "@breadth/schema";
import { codeCollector } from "./index.js";
import { normRoute, parseUrl } from "./build.js";

const fixtures = path.resolve(__dirname, "../../test/fixtures");

const edge = (g: FlowGraph, kind: string, from: string, to: string) =>
  g.edges.find((e) => e.kind === kind && e.from.node === from && e.to.node === to);

describe("code collector: python", async () => {
  const g = await codeCollector.collect(path.join(fixtures, "pyapp"), {});
  const fn = (q: string) => `code:fn:app/${q}`;

  it("produces a valid graph", () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  });

  it("builds the hierarchy system > dir > file > class > method", () => {
    const load = g.nodes.find((n) => n.id === fn("service.py#UserService.load"))!;
    expect(load.parent).toBe(fn("service.py#UserService"));
    expect(g.nodes.find((n) => n.id === fn("service.py#UserService"))!.parent).toBe("code:file:app/service.py");
    expect(g.nodes.find((n) => n.id === "code:file:app/service.py")!.parent).toBe("code:dir:app");
    expect(g.nodes.find((n) => n.id === "code:dir:app")!.parent).toBe("code:repo:pyapp");
  });

  it("extracts params as inputs and return types as outputs", () => {
    const n = g.nodes.find((x) => x.id === fn("db.py#get_user"))!;
    expect(n.inputs).toEqual([{ name: "user_id", type: "int" }]);
    expect(n.outputs).toEqual([{ name: "return", type: "dict" }]);
    expect(n.description).toBe("Load one user, cached.");
    expect(n.aliases).toContain("py:app.db.get_user");
  });

  it("resolves imports, self calls, typed locals, loops and recursion", () => {
    expect(edge(g, "call", fn("service.py#UserService.load"), fn("db.py#get_user"))).toBeTruthy();
    expect(edge(g, "call", fn("service.py#UserService.load"), fn("service.py#UserService.enrich"))).toBeTruthy();
    expect(edge(g, "call", fn("service.py#main"), fn("service.py#UserService.load"))?.loop).toBe(true);
    expect(edge(g, "call", fn("service.py#main"), fn("db.py#save_user"))).toBeTruthy();
    expect(edge(g, "call", fn("service.py#factorial"), fn("service.py#factorial"))).toBeTruthy();
  });

  it("models shared state and datastores with read/write edges", () => {
    const cache = "code:global:app/db.py#CACHE";
    expect(edge(g, "read", cache, fn("db.py#get_user"))).toBeTruthy();
    expect(edge(g, "write", fn("db.py#get_user"), cache)).toBeTruthy();
    expect(edge(g, "read", "store:postgresql", fn("db.py#get_user"))?.label).toBe("SELECT users");
    expect(edge(g, "write", fn("db.py#save_user"), "store:postgresql")?.label).toBe("INSERT users");
    expect(g.nodes.some((n) => n.name === "MAX_ROWS")).toBe(false);
  });

  it("records visibility and whether remote calls are guarded", () => {
    expect(g.nodes.find((n) => n.id === fn("db.py#get_user"))!.metadata?.visibility).toBe("public");
    expect(edge(g, "call", fn("service.py#UserService.enrich"), "ext:http:orders")?.metadata?.guarded).toBe(false);
  });

  it("turns HTTP client calls into external API nodes", () => {
    const e = edge(g, "call", fn("service.py#UserService.enrich"), "ext:http:orders");
    expect(e?.protocol).toBe("http");
    expect(e?.label).toBe("GET /orders");
    expect(g.nodes.find((n) => n.id === "ext:http:orders")!.aliases).toContain("service:orders");
  });
});

describe("code collector: typescript", async () => {
  const g = await codeCollector.collect(path.join(fixtures, "tsapp"), {});
  const fn = (q: string) => `code:fn:src/${q}`;

  it("produces a valid graph and treats manifest dirs as services", () => {
    expect(validateGraph(g).valid).toBe(true);
  });

  it("resolves barrel re-exports, renamed exports and `new`", () => {
    expect(edge(g, "call", fn("server.ts#handler"), fn("lib/math.ts#add"))).toBeTruthy();
    expect(edge(g, "call", fn("server.ts#handler"), fn("lib/repo.ts#Repo"))).toBeTruthy();
    expect(edge(g, "call", fn("server.ts#handler"), fn("lib/repo.ts#Repo.find"))).toBeTruthy();
    expect(edge(g, "call", fn("lib/repo.ts#Repo.find"), fn("lib/repo.ts#Repo.map"))).toBeTruthy();
  });

  it("marks loop callbacks and conditional calls", () => {
    expect(edge(g, "call", fn("server.ts#handler"), fn("lib/math.ts#double"))?.loop).toBe(true);
    expect(edge(g, "call", fn("server.ts#handler"), fn("lib/math.ts#tick"))?.conditional).toBe(true);
  });

  it("finds params with defaults and module state", () => {
    const add = g.nodes.find((n) => n.id === fn("lib/math.ts#add"))!;
    expect(add.inputs).toEqual([{ name: "a", type: "number" }, { name: "b", type: "number", optional: true, default: "0" }]);
    expect(add.description).toBe("Add two numbers.");
    expect(edge(g, "write", fn("lib/math.ts#tick"), "code:global:src/lib/math.ts#counter")).toBeTruthy();
  });

  it("detects express routes, external APIs and databases", () => {
    expect(edge(g, "call", "route:src/server.ts#GET /x", fn("server.ts#handler"))).toBeTruthy();
    expect(edge(g, "call", fn("server.ts#handler"), "ext:http:api.stripe.com")?.label).toBe("POST /v1/charges");
    expect(edge(g, "call", fn("server.ts#handler"), "ext:http:payments")).toBeTruthy();
    expect(edge(g, "read", "store:postgresql", fn("lib/repo.ts#Repo.find"))).toBeTruthy();
  });
});

describe("url helpers", () => {
  it("parses hosts and placeholder service names", () => {
    expect(parseUrl("https://api.x.com:443/v1/a?b=1")).toEqual({ host: "api.x.com", path: "/v1/a" });
    expect(parseUrl("{ORDERS_SERVICE_URL}/orders/{id}")).toEqual({ host: "orders", path: "/orders/{id}" });
    expect(parseUrl("{process.env.PAYMENTS_URL}/pay")).toEqual({ host: "payments", path: "/pay" });
    expect(parseUrl("http://localhost:{port}/x")).toEqual({ host: "localhost", path: "/x" });
    expect(parseUrl("http://127.0.0.1:3000/")).toEqual({ host: "localhost", path: "/" });
    expect(normRoute("/users/:id/")).toBe("/users/{}");
    expect(normRoute("/users/{user_id}")).toBe("/users/{}");
  });
});
