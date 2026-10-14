import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeGraphs, validateGraph } from "@breadth/schema";
import { codeCollector } from "../code/index.js";
import { importOtlp, linkTracesToCode, parseOtlp } from "./index.js";

const shop = path.resolve(__dirname, "../../../examples/shop");
const otlp = readFileSync(path.join(shop, "traces/checkout.otlp.json"), "utf8");

describe("otel importer", () => {
  const g = importOtlp(otlp);

  it("parses spans with resource service names and nanosecond times", () => {
    const spans = parseOtlp(otlp);
    expect(spans.length).toBe(61);
    const root = spans.find((s) => s.name === "POST /checkout")!;
    expect(root.service).toBe("gateway");
    expect(root.kind).toBe("server");
    expect(root.end - root.start).toBeCloseTo(148, 3);
  });

  it("produces a valid graph with services, endpoints, datastores, topics and external APIs", () => {
    expect(validateGraph(g)).toEqual({ valid: true, errors: [] });
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["svc:gateway", "svc:orders", "svc:payments", "svc:notifier", "store:postgresql", "queue:kafka:order-created", "ext:http:api.stripe.com"]));
    const ep = g.nodes.find((n) => n.id === "op:orders:POST /orders")!;
    expect(ep.kind).toBe("network_endpoint");
    expect(ep.aliases).toContain("route:orders:POST /orders");
  });

  it("collapses client hops into service-to-service edges with protocols", () => {
    const e = g.edges.find((x) => x.from.node === "op:gateway:OrdersClient.createOrder" && x.to.node === "op:orders:POST /orders")!;
    expect(e.protocol).toBe("http");
    expect(e.label).toBe("POST");
    expect(g.edges.find((x) => x.kind === "write" && x.to.node === "store:postgresql")?.label).toBe("INSERT orders");
    expect(g.edges.find((x) => x.kind === "event" && x.from.node === "queue:kafka:order-created")).toBeTruthy();
  });

  it("records one execution per trace with real inputs and outputs", () => {
    expect(g.executions).toHaveLength(2);
    const [ok, declined] = g.executions!;
    expect(ok.status).toBe("ok");
    expect(declined.status).toBe("error");
    const price = ok.steps.filter((s) => s.node === "op:orders:get_price");
    expect(price).toHaveLength(3);
    expect(price[0].input).toEqual({ sku: "sku-1" });
    expect(price[0].output).toBe(12.5);
    const db = ok.steps.find((s) => s.node === "store:postgresql" && s.metadata?.span === "INSERT shop.orders")!;
    expect(db.input).toEqual({ params: ["5f3b2c1d", "cus_42", 53.1, "paid"] });
  });

  it("links trace operations to static code and merges cleanly", async () => {
    const code = await codeCollector.collect(shop, { exclude: ["infra/", "traces/"] });
    const merged = mergeGraphs(code, linkTracesToCode(g, code));
    expect(validateGraph(merged)).toEqual({ valid: true, errors: [] });
    const steps = merged.executions![0].steps;
    expect(steps.find((s) => s.metadata?.span === "create_order")?.node).toBe("code:fn:services/orders/app/main.py#create_order");
    // payments' `charge` and orders' `charge` share a name: the service name disambiguates.
    expect(steps.filter((s) => s.metadata?.span === "charge").map((s) => s.node)).toEqual([
      "code:fn:services/orders/app/payments.py#charge",
      "code:fn:services/payments/app/main.py#charge",
    ]);
    expect(steps.find((s) => s.metadata?.span === "POST /orders")?.node).toBe("route:services/orders/app/main.py#POST /orders");
    expect(merged.nodes.some((n) => n.id.startsWith("op:") || n.id.startsWith("svc:"))).toBe(false);
    const edgeIds = new Set(merged.edges.map((e) => e.id));
    for (const s of steps) if (s.via) expect(edgeIds.has(s.via)).toBe(true);
  });
});
