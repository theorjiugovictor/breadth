import { mkdtempSync, cpSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCollectors } from "@breadth/collectors";
import { runInsights } from "@breadth/insights";
import type { FlowGraph } from "@breadth/schema";
import { parseTime, recordEvidence } from "./evidence.js";
import { trafficOf } from "./diff.js";
import { applyLiveStats } from "./sources/apply.js";

const shop = path.resolve(__dirname, "../../examples/shop");
const opts = { exclude: ["**/generate.mjs", "traces/"] };

describe("evidence", () => {
  it("parses times", () => {
    const now = Date.parse("2026-10-23T10:00:00Z");
    expect(parseTime("15m", now)).toBe(now - 900_000);
    expect(parseTime("-2h", now)).toBe(now - 7_200_000);
    expect(parseTime("now", now)).toBe(now);
    expect(parseTime("2026-10-23T09:00:00Z")).toBe(Date.parse("2026-10-23T09:00:00Z"));
  });

  it("measures, judges and records a run that goes stale when the service changes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "breadth-ev-"));
    try {
      const root = path.join(dir, "shop");
      cpSync(shop, root, { recursive: true });
      const graph = await runCollectors(root, ["code", "resilience"], opts);
      const source = { name: "fake", describe: "fake", measure: async () => ({ p95_ms: 260, error_pct: 0.5 }) };
      const r = await recordEvidence({ graph, root, scenario: "Postgres latency", service: "orders", endpoint: "POST /orders", from: 1, to: 60_001, source, results: { error_pct: 2 }, id: "t1" });
      // explicit results win over measured ones: 2 % errors breaks "errors <= 1 %"
      expect(r.verdict).toBe("contradicts");
      expect(r.checks).toEqual([
        { metric: "p95_ms", op: "<=", expected: 300, actual: 260, ok: true },
        { metric: "error_pct", op: "<=", expected: 1, actual: 2, ok: false },
      ]);
      const saved = JSON.parse(readFileSync(r.file, "utf8"));
      expect(saved).toMatchObject({ kind: "breadth.run", id: "t1", scenario: "scenario:checkout/checkout-survives-a-slow-database/postgres-latency", service: "orders", measured_by: "fake" });
      expect(saved.fingerprint).toMatch(/^[0-9a-z]+$/);
      expect(saved.snapshot.digest).toMatch(/^sha256:/);
      const fresh = await runCollectors(root, ["code", "resilience"], opts);
      const titles = (g: FlowGraph) => runInsights(g, { rules: ["evidence-status"] }).map((i) => i.title);
      expect(titles(fresh).some((t) => t.includes("older behaviour"))).toBe(false);
      expect(titles(fresh)).toContain('"Checkout survives a slow database" is contradicted by run t1');
      await expect(recordEvidence({ graph, root, scenario: "nope", service: "orders", from: 0, to: 1, results: {} })).rejects.toThrow('no scenario "nope"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("live traffic on the graph", async () => {
  const g = await runCollectors(shop, ["code"], opts);
  applyLiveStats(g, [{ service: "orders", endpoint: "POST /orders", rpm: 1200, p95_ms: 180, error_pct: 3.1 }], "datadog", "1h");

  it("finds the traffic behind a changed function through the endpoints that call it", () => {
    expect(trafficOf(g, "route:services/orders/app/main.py#POST /orders")).toEqual({ text: "1.2k req/min, p95 180 ms, 3.1% errors" });
    // create_order handles POST /orders; save_order is called by it
    const viaHandler = trafficOf(g, "code:fn:services/orders/app/main.py#create_order");
    expect(viaHandler?.text).toBe("1.2k req/min, p95 180 ms, 3.1% errors");
    expect(viaHandler?.via).toBe("POST /orders");
  });

  it("flags endpoints of a service with traffic that got none", () => {
    const titles = runInsights(g, { rules: ["unexercised"] }).map((i) => i.title);
    expect(titles).toContain("GET /orders/{order_id} got no traffic in the last 1h");
    expect(titles.some((t) => t.startsWith("POST /orders "))).toBe(false);
  });
});
