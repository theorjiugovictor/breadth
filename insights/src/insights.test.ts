import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { mergeGraphs, validateGraph, type FlowGraph } from "@noodles/schema";
import { codeCollector, importOtlp, infraCollector, linkTracesToCode } from "@noodles/collectors";
import { expectedKinds, runInsights, sensitiveFields } from "./index.js";

const shop = path.resolve(__dirname, "../../examples/shop");

describe("insights on the shop demo", () => {
  let g: FlowGraph;
  beforeAll(async () => {
    const opts = { exclude: ["**/generate.mjs", "traces/"] };
    const base = mergeGraphs(await codeCollector.collect(shop, opts), await infraCollector.collect(shop, opts));
    const traces = importOtlp(readFileSync(path.join(shop, "traces/checkout.otlp.json"), "utf8"));
    g = mergeGraphs(base, linkTracesToCode(traces, base));
  }, 60_000);

  const find = (rule: string, text?: string) => runInsights(g, { rules: [rule] }).filter((i) => !text || i.title.includes(text));

  it("results validate as part of the graph", () => {
    const insights = runInsights(g);
    expect(validateGraph({ ...g, insights })).toEqual({ valid: true, errors: [] });
    expect(new Set(insights.map((i) => i.id)).size).toBe(insights.length);
  });

  it("finds the N+1 price lookup statically, with the call path", () => {
    const [i] = find("n-plus-one", "calls get_price in a loop");
    expect(i.nodes).toEqual([
      "code:fn:services/orders/app/pricing.py#price_order",
      "code:fn:services/orders/app/pricing.py#get_price",
      "code:fn:services/orders/app/repository.py#price_for",
      "store:postgresql",
    ]);
    expect(i.edges?.length).toBe(3);
  });

  it("finds the N+1 at runtime under its issuing step", () => {
    const [i] = find("n-plus-one", "ran 3 times");
    expect(i.nodes[0]).toBe("code:fn:services/orders/app/pricing.py#price_order");
    expect(i.steps).toHaveLength(4);
    expect(i.execution).toBeDefined();
  });

  it("does not treat in-memory globals as N+1 reads", () => {
    expect(find("n-plus-one").some((i) => i.nodes.some((n) => n.includes("PRICE_CACHE")))).toBe(false);
  });

  it("finds repeated validation with identical input", () => {
    const [i] = find("repeated-work");
    expect(i.nodes).toEqual(["code:fn:services/gateway/src/routes/checkout.ts#validateCart"]);
    expect(i.metadata?.runs).toBe(2);
  });

  it("flags shared state with two writers and personal data sent to third parties", () => {
    expect(find("race-risk")[0].nodes[0]).toBe("code:global:services/orders/app/pricing.py#PRICE_CACHE");
    const exposure = find("data-exposure");
    expect(exposure.map((i) => i.nodes[0]).sort()).toEqual(["ext:http:api.sendgrid.com", "ext:http:api.stripe.com"]);
    expect(exposure.find((i) => i.nodes[0] === "ext:http:api.stripe.com")?.metadata?.fields).toEqual(["receipt_email"]);
  });

  it("finds unused infrastructure but not the database or Kafka", () => {
    const ids = find("orphan-infra").map((i) => i.nodes[0]).sort();
    expect(ids).toEqual(["tf:aws_s3_bucket.invoices_legacy", "tf:aws_sqs_queue.invoice_jobs"]);
  });

  it("finds dead code but not entry points, callbacks or code reached at runtime", () => {
    const names = find("dead-code").map((i) => i.title);
    expect(names).toEqual(expect.arrayContaining(["legacy_discount is never called", "check_lines is never called"]));
    expect(names.join()).not.toMatch(/create_order|record|handleOrderCreated|checkout/);
  });

  it("finds the getattr() call that only exists at runtime", () => {
    const [i] = find("static-runtime-mismatch");
    expect(i.nodes).toEqual(["code:fn:services/payments/app/main.py#charge", "code:fn:services/payments/app/audit.py#record"]);
  });

  it("traces the declined payment back to where it started", () => {
    const [i] = find("unhandled-errors", "reached");
    expect(i.title).toBe("Error in charge reached POST /checkout");
    expect(i.nodes[0]).toBe("code:fn:services/payments/app/main.py#charge");
    expect(i.steps!.length).toBeGreaterThan(5);
    const unguarded = find("unhandled-errors", "no error handling").map((x) => x.nodes[1]);
    expect(unguarded).toContain("ext:http:api.stripe.com");
  });

  it("suggests running the independent lookups concurrently, once", () => {
    const r = find("missed-parallelism");
    expect(r.map((i) => i.title)).toEqual(["fetch_customer and price_order could run concurrently"]);
    expect(r[0].metadata?.savingMs).toBe(8);
  });

  it("catches the amount sent as a string", () => {
    const [i] = find("contract-drift");
    expect(i.title).toBe("risk_score received amount as string, declared float");
  });

  it("finds the copy-pasted validation in two services", () => {
    const [i] = find("duplicate-logic");
    expect(i.nodes.sort()).toEqual(["code:fn:services/orders/app/pricing.py#validate_items", "code:fn:services/payments/app/fraud.py#check_lines"]);
    expect(i.confidence).toBe("high");
  });

  it("does not report chatty services or long chains for a normal checkout", () => {
    expect(find("chatty-services")).toEqual([]);
    expect(find("long-hop-chain")).toEqual([]);
  });
});

describe("runtime service rules", () => {
  const svc = (id: string) => ({ id, name: id, kind: "service" as const, layer: "runtime" as const });
  const fn = (id: string, parent: string) => ({ id, name: id, kind: "function" as const, layer: "runtime" as const, parent });
  const g: FlowGraph = {
    version: "1.0",
    nodes: [svc("a"), svc("b"), svc("c"), svc("d"), fn("a.f", "a"), fn("b.g", "b"), fn("c.h", "c"), fn("d.i", "d")],
    edges: [],
    executions: [
      {
        id: "x1",
        steps: [
          { id: "1", node: "a.f" },
          ...Array.from({ length: 7 }, (_, k) => ({ id: `g${k}`, node: "b.g", parent: "1", input: { k } })),
          { id: "h", node: "c.h", parent: "g0" },
          { id: "i", node: "d.i", parent: "h" },
        ],
      },
    ],
  };
  it("detects chatty pairs and long hop chains", () => {
    const r = runInsights(g, { rules: ["chatty-services", "long-hop-chain"] });
    expect(r.find((i) => i.rule === "chatty-services")?.metadata?.calls).toBe(7);
    expect(r.find((i) => i.rule === "long-hop-chain")?.nodes).toEqual(["a", "b", "c", "d"]);
  });
  it("honours thresholds", () => {
    expect(runInsights(g, { rules: ["chatty-services"], thresholds: { "chatty-services": { minCalls: 8 } } })).toEqual([]);
  });
});

describe("expectedKinds", () => {
  it("maps common annotations and refuses to guess classes", () => {
    expect([...expectedKinds("float")!]).toEqual(["number"]);
    expect([...expectedKinds("str | None")!].sort()).toEqual(["null", "string"]);
    expect([...expectedKinds("Optional[int]")!].sort()).toEqual(["null", "number"]);
    expect([...expectedKinds("string[]")!]).toEqual(["array"]);
    expect(expectedKinds("OrderRequest")).toBeUndefined();
  });
});

describe("sensitiveFields", () => {
  it("recognises secrets, personal fields, emails and card numbers", () => {
    const f = sensitiveFields({ password: "x", user: { email: "a@b.co", note: "hi" }, pay: "4242 4242 4242 4242", to: "x@y.io" });
    expect(Object.fromEntries(f)).toEqual({ password: "critical", "user.email": "warning", pay: "critical", to: "warning" });
    expect(sensitiveFields({ id: "42", amount: 10 }).size).toBe(0);
  });
});
