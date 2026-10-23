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

describe("code collector: go", async () => {
  const g = await codeCollector.collect(path.join(fixtures, "goapp"), {});
  const fn = (p: string) => `code:fn:${p}`;

  it("produces a valid graph", () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  });

  it("resolves calls across packages and across files of one package", () => {
    expect(edge(g, "call", fn("cmd/api/main.go#createOrder"), fn("internal/store/store.go#Store.Save"))?.loop).toBe(true);
    // Load is declared in load.go, on the Store type declared in store.go
    expect(edge(g, "call", fn("cmd/api/main.go#getOrder"), fn("internal/store/load.go#Store.Load"))).toBeTruthy();
    expect(edge(g, "call", fn("internal/store/store.go#Store.Save"), fn("internal/store/store.go#Store.archive"))).toBeTruthy();
  });

  it("finds net/http routes, SQL, HTTP calls, Kafka and AWS", () => {
    expect(edge(g, "call", "route:cmd/api/main.go#POST /orders", fn("cmd/api/main.go#createOrder"))).toBeTruthy();
    expect(g.nodes.find((n) => n.id === "route:cmd/api/main.go#GET /orders/{}")?.name).toBe("GET /orders/{id}");
    expect(edge(g, "write", fn("internal/store/store.go#Store.Save"), "store:sql")?.label).toBe("INSERT orders");
    expect(edge(g, "read", "store:sql", fn("internal/store/load.go#Store.Load"))?.label).toBe("SELECT orders");
    expect(edge(g, "call", fn("cmd/api/main.go#getOrder"), "ext:http:api.example.com")).toBeTruthy();
    expect(edge(g, "event", fn("internal/store/store.go#Store.Save"), "queue:kafka")).toBeTruthy();
    expect(edge(g, "write", fn("internal/store/store.go#Store.archive"), "cloud:aws:s3:env:ARCHIVE_BUCKET")?.label).toBe("s3:PutObject");
  });

  it("marks exported names and reads doc comments", () => {
    const save = g.nodes.find((n) => n.id === fn("internal/store/store.go#Store.Save"))!;
    expect(save.description).toBe("Save writes an order and announces it.");
    expect(save.inputs?.map((p) => p.name)).toEqual(["ctx", "id"]);
  });
});

describe("code collector: java", async () => {
  const g = await codeCollector.collect(path.join(fixtures, "javaapp"), {});
  const base = "src/main/java/com/shop/orders";
  const fn = (q: string) => `code:fn:${base}/${q}`;

  it("links AWS SDK v2 calls to the resource their request builder names", () => {
    const store = (q: string) => fn(`ReceiptStore.java#ReceiptStore.${q}`);
    expect(edge(g, "write", store("save"), "cloud:aws:s3:shop-receipts")?.label).toBe("s3:PutObject");
    expect(edge(g, "read", "cloud:aws:s3:shop-receipts", store("load"))?.label).toBe("s3:GetObject");
    expect(edge(g, "event", store("announce"), "cloud:aws:sqs:env:RECEIPTS_QUEUE_URL")?.label).toBe("sqs:SendMessage");
    expect(edge(g, "write", store("index"), "cloud:aws:dynamodb:receipts")?.label).toBe("dynamodb:PutItem");
    // making a client is not a write
    expect(g.nodes.some((n) => n.id === "store:aws")).toBe(false);
  });

  it("produces a valid graph", () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
  });

  it("finds Spring routes with the controller's prefix", () => {
    const routes = g.nodes.filter((n) => n.kind === "network_endpoint").map((n) => n.name).sort();
    expect(routes).toEqual(["DELETE /api/orders/{id}", "GET /api/orders/{id}", "POST /api/orders"]);
    expect(edge(g, "call", `route:${base}/OrderController.java#POST /api/orders`, fn("OrderController.java#OrderController.create"))).toBeTruthy();
  });

  it("follows injected fields, JPA repositories, JdbcTemplate and Kafka", () => {
    expect(edge(g, "call", fn("OrderController.java#OrderController.create"), fn("PriceService.java#PriceService.priceOf"))?.loop).toBe(true);
    expect(edge(g, "write", fn("OrderController.java#OrderController.create"), "store:sql")).toBeTruthy();
    expect(edge(g, "read", "store:sql", fn("PriceService.java#PriceService.priceOf"))?.label).toBe("SELECT products");
    expect(edge(g, "event", fn("OrderController.java#OrderController.create"), "queue:kafka:order-created")).toBeTruthy();
    expect(edge(g, "call", fn("OrderController.java#OrderController.delete"), fn("OrderController.java#OrderController.audit"))).toBeTruthy();
  });
});

describe("code collector: gRPC between services", async () => {
  const g = await codeCollector.collect(path.join(fixtures, "grpcapp"), {});
  const ep = (m: string) => g.nodes.find((n) => n.id === `grpc:shop.${m}`);

  it("makes one endpoint per rpc, served by its handler in any language", () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
    expect(ep("CartService/AddItem")?.metadata).toMatchObject({ protocol: "grpc", service: "cart", grpc_service: "shop.CartService" });
    expect(edge(g, "call", "grpc:shop.CartService/AddItem", "code:fn:cart/server.go#cartServer.AddItem")).toBeTruthy();
    expect(edge(g, "call", "grpc:shop.CheckoutService/PlaceOrder", "code:fn:checkout/server.py#Checkout.PlaceOrder")).toBeTruthy();
    expect(edge(g, "call", "grpc:shop.AdService/GetAds", "code:fn:ads/src/main/java/shop/AdServer.java#AdServer.AdServiceImpl.getAds")).toBeTruthy();
  });

  it("links stub calls across services to the endpoint", () => {
    expect(edge(g, "call", "code:fn:checkout/server.py#Checkout.PlaceOrder", "grpc:shop.CartService/GetCart")?.protocol).toBe("grpc");
    expect(edge(g, "call", "code:fn:web/client.js#addToCart", "grpc:shop.CartService/AddItem")).toBeTruthy();
    expect(edge(g, "call", "code:fn:web/client.js#showAds", "grpc:shop.AdService/GetAds")).toBeTruthy();
  });

  it("leaves out rpcs nothing serves or calls, and health checks", () => {
    expect(ep("CartService/WatchCart")).toBeUndefined();
    expect(g.nodes.some((n) => /Check$/.test(n.id) && n.id.startsWith("grpc:"))).toBe(false);
  });
});
