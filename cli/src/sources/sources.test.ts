import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCollectors } from "@breadth/collectors";
import { datadogSource } from "./datadog.js";
import { lokiSource, prometheusSource } from "./prometheus.js";
import { honeycombSource } from "./honeycomb.js";
import { fromJaeger, jaegerSource, tempoSource } from "./traces.js";
import { applyLiveStats, liveText, type LiveInfo } from "./apply.js";
import { createSource, pullLive } from "./index.js";
import { endpointKey, parseDuration, type Fetch } from "./types.js";

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: any };

/** A fetch that records requests and answers from a routing function (recorded responses). */
function fakeFetch(answer: (c: Call) => unknown): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f: Fetch = async (url, init) => {
    const c = { url, method: init?.method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const out = answer(c);
    return { ok: out !== 404, status: out === 404 ? 404 : 200, json: async () => out, text: async () => JSON.stringify(out) };
  };
  return { fetch: f, calls };
}

const T0 = Date.parse("2026-10-23T10:00:00Z");
afterEach(() => {
  delete process.env.DD_API_KEY;
  delete process.env.DD_APP_KEY;
  delete process.env.PROM_TOKEN;
});

describe("helpers", () => {
  it("parses durations and compares endpoint names across conventions", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(endpointKey("post /orders/:id")).toBe(endpointKey("POST /orders/{order_id}"));
    expect(endpointKey("GET /a/<int:x>?y=1")).toBe("GET /a/{}");
    expect(liveText({ rpm: 1234, p95_ms: 181.2, error_pct: 3.1 } as LiveInfo)).toBe("1.2k req/min, p95 181 ms, 3.1% errors");
  });
});

describe("datadog", () => {
  const span = (trace: string, id: string, parent: string, service: string, resource: string, type: string, custom: object, start: number, ms: number, status = "ok") => ({
    type: "spans",
    attributes: { trace_id: trace, span_id: id, parent_id: parent, service, resource_name: resource, type, custom, status, start_timestamp: new Date(start).toISOString(), end_timestamp: new Date(start + ms).toISOString() },
  });

  it("needs its keys from the environment, never from config", async () => {
    const src = datadogSource({ env: "prod" }, fakeFetch(() => ({})).fetch);
    await expect(src.traces!({ from: T0, to: T0 + 1, limit: 10 })).rejects.toThrow("set the DD_API_KEY environment variable");
  });

  it("reads spans, pages through them, and renames Datadog attributes to OTel conventions", async () => {
    process.env.DD_API_KEY = "k";
    process.env.DD_APP_KEY = "a";
    const { fetch, calls } = fakeFetch((c) =>
      !c.body.data.attributes.page.cursor
        ? { data: [span("1", "10", "0", "orders", "POST /orders", "web", { "span.kind": "server", http: { method: "POST", status_code: "500" }, error: { message: "boom" } }, T0, 40, "error")], meta: { page: { after: "next" } } }
        : { data: [span("1", "11", "10", "orders", "INSERT orders", "sql", { db: { type: "postgresql" } }, T0 + 5, 8)] },
    );
    const spans = await datadogSource({ site: "datadoghq.eu", env: "prod" }, fetch).traces!({ from: T0, to: T0 + 60_000, services: ["orders"], limit: 100 });
    expect(calls[0].url).toBe("https://api.datadoghq.eu/api/v2/spans/events/search");
    expect(calls[0].headers).toMatchObject({ "DD-API-KEY": "k", "DD-APPLICATION-KEY": "a" });
    expect(calls[0].body.data.attributes.filter.query).toBe("env:prod service:(orders)");
    expect(calls[1].body.data.attributes.page.cursor).toBe("next");
    expect(spans[0]).toMatchObject({ name: "POST /orders", kind: "server", service: "orders", status: "error", error: "boom", end: T0 + 40 });
    expect(spans[0].attrs).toMatchObject({ "http.request.method": "POST", "http.response.status_code": 500 });
    expect(spans[1]).toMatchObject({ parentSpanId: "10", kind: "client" });
    expect(spans[1].attrs["db.system"]).toBe("postgresql");
  });

  it("aggregates rate, p95 and errors per endpoint, and measures a window", async () => {
    process.env.DD_API_KEY = "k";
    process.env.DD_APP_KEY = "a";
    const { fetch, calls } = fakeFetch((c) => {
      const q = c.body.data.attributes.filter.query as string;
      const groups = c.body.data.attributes.group_by.length;
      if (!groups) return { data: [{ attributes: { by: {}, compute: q.includes("status:error") ? { c0: 3 } : { c0: 600, c1: 180e6, c2: 40e6, c3: 400e6 } } }] };
      return { data: [{ attributes: { by: { service: "orders", resource_name: "POST /orders" }, compute: q.includes("status:error") ? { c0: 30 } : { c0: 1200, c1: 210e6 } } }] };
    });
    const src = datadogSource({ env: "prod" }, fetch);
    const stats = await src.stats!({ from: T0, to: T0 + 60 * 60_000 });
    expect(stats).toEqual([{ service: "orders", endpoint: "POST /orders", rpm: 20, p95_ms: 210, error_pct: 2.5 }]);
    expect(calls[0].body.data.attributes.compute[1]).toEqual({ aggregation: "pc95", metric: "@duration", type: "total" });
    const m = await src.measure!({ from: T0, to: T0 + 60_000, service: "orders", endpoint: "POST /orders" });
    expect(m).toEqual({ error_pct: 0.5, availability_pct: 99.5, throughput_rps: 10, p95_ms: 180, p50_ms: 40, p99_ms: 400 });
    expect(calls.at(-1)!.body.data.attributes.filter.query).toBe('env:prod service:(orders) @span.kind:server resource_name:"POST /orders" status:error');
  });
});

describe("prometheus", () => {
  it("runs the span-metrics queries with the token and turns them into stats and measurements", async () => {
    process.env.PROM_TOKEN = "t";
    const { fetch, calls } = fakeFetch((c) => {
      const q = decodeURIComponent(c.url.split("query=")[1].split("&")[0]);
      const v = q.startsWith("histogram_quantile(0.95") ? "120" : q.startsWith("histogram_quantile") ? "50" : q.includes("STATUS_CODE_ERROR") ? "6" : "600";
      return { status: "success", data: { result: [{ metric: { service_name: "orders", span_name: "POST /orders" }, value: [T0 / 1000, v] }] } };
    });
    const src = prometheusSource({ url: "https://prom.example/", tokenEnv: "PROM_TOKEN" }, fetch);
    expect(await src.stats!({ from: T0, to: T0 + 600_000 })).toEqual([{ service: "orders", endpoint: "POST /orders", rpm: 60, p95_ms: 120, error_pct: 1 }]);
    expect(calls[0].headers).toMatchObject({ authorization: "Bearer t" });
    expect(decodeURIComponent(calls[0].url)).toContain("increase(traces_span_metrics_calls_total{span_kind=\"SPAN_KIND_SERVER\"}[600s])");
    const m = await src.measure!({ from: T0, to: T0 + 60_000, service: "orders", endpoint: "POST /orders" });
    expect(m).toMatchObject({ error_pct: 1, throughput_rps: 10, p95_ms: 120 });
    expect(decodeURIComponent(calls.at(-1)!.url)).toContain('service_name="orders",span_name="POST /orders"');
  });
});

describe("honeycomb and loki", () => {
  it("runs Honeycomb queries, polls the result, and reads stats and measurements", async () => {
    process.env.HONEYCOMB_API_KEY = "hk";
    let polls = 0;
    const { fetch, calls } = fakeFetch((c) => {
      if (c.url.endsWith("/1/queries/__all__")) return { id: c.body.filters.some((f: any) => f.column === "error") ? "qe" : "qa" };
      if (c.url.endsWith("/1/query_results/__all__")) return { id: c.body.query_id === "qe" ? "re" : "ra", complete: false };
      polls++;
      return c.url.endsWith("/re")
        ? { complete: true, data: { results: [{ data: { "service.name": "orders", name: "POST /orders", COUNT: 6 } }] } }
        : { complete: true, data: { results: [{ data: { "service.name": "orders", name: "POST /orders", COUNT: 600, "P95(duration_ms)": 140, "P50(duration_ms)": 40, "P99(duration_ms)": 300 } }] } };
    });
    const src = honeycombSource({}, fetch, 1);
    expect(await src.stats!({ from: T0, to: T0 + 600_000 })).toEqual([{ service: "orders", endpoint: "POST /orders", rpm: 60, p95_ms: 140, error_pct: 1 }]);
    expect(calls[0].headers).toMatchObject({ "X-Honeycomb-Team": "hk" });
    expect(calls[0].body).toMatchObject({ breakdowns: ["service.name", "name"], start_time: T0 / 1000, filters: [{ column: "span.kind", op: "=", value: "server" }] });
    expect(polls).toBe(2);
    const m = await src.measure!({ from: T0, to: T0 + 60_000, service: "orders", endpoint: "POST /orders", run: { attr: "breadth.run_id", value: "r1" } });
    expect(m).toMatchObject({ p95_ms: 140, p50_ms: 40, p99_ms: 300, error_pct: 1, throughput_rps: 10 });
    expect(calls.find((c) => c.url.endsWith("/1/queries/__all__") && c.body.breakdowns.length === 0)!.body.filters).toEqual(
      expect.arrayContaining([{ column: "service.name", op: "=", value: "orders" }, { column: "name", op: "=", value: "POST /orders" }, { column: "breadth.run_id", op: "=", value: "r1" }]),
    );
    delete process.env.HONEYCOMB_API_KEY;
  });

  it("reads request logs from Loki with LogQL", async () => {
    const vector = (metric: object, v: number) => ({ status: "success", data: { resultType: "vector", result: [{ metric, value: [T0 / 1000, String(v)] }] } });
    const { fetch, calls } = fakeFetch((c) => {
      const q = decodeURIComponent(c.url);
      const m = { service_name: "orders", method: "POST", route: "/orders" };
      return q.includes("status >= 500") ? vector(m, 3) : q.includes("quantile_over_time(0.95") ? vector(m, 210) : vector(m, 300);
    });
    const src = lokiSource({ url: "http://loki:3100", runLabel: "run_id" }, fetch);
    expect(await src.stats!({ from: T0, to: T0 + 300_000 })).toEqual([{ service: "orders", endpoint: "POST /orders", rpm: 60, p95_ms: 210, error_pct: 1 }]);
    expect(calls[0].url).toContain("/loki/api/v1/query?query=");
    expect(decodeURIComponent(calls[0].url)).toContain('sum by (service_name, method, route) (count_over_time({service_name=~".+"} | json | status != "" [300s]))');
    await src.measure!({ from: T0, to: T0 + 60_000, service: "orders", endpoint: "POST /orders", run: { attr: "breadth.run_id", value: "r1" } });
    expect(decodeURIComponent(calls.at(-1)!.url)).toContain('{service_name=~".+",service_name="orders"} | json | duration_ms != "" | method="POST" | route="/orders" | run_id="r1" | unwrap duration_ms [60s])');
  });
});

describe("tempo and jaeger", () => {
  it("searches Tempo and reads each trace as OTLP", async () => {
    const otlp = { batches: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "orders" } }] }, scopeSpans: [{ spans: [{ traceId: "ab", spanId: "01", name: "POST /orders", kind: 2, startTimeUnixNano: "1000000", endTimeUnixNano: "2000000" }] }] }] };
    const { fetch, calls } = fakeFetch((c) => (c.url.includes("/api/search") ? { traces: [{ traceID: "ab" }] } : otlp));
    const spans = await tempoSource({ url: "http://tempo:3200", orgId: "t1" }, fetch).traces!({ from: T0, to: T0 + 60_000, services: ["orders"], limit: 10 });
    expect(decodeURIComponent(calls[0].url)).toContain('q={ resource.service.name = "orders" }');
    expect(calls[0].headers).toMatchObject({ "X-Scope-OrgID": "t1" });
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ service: "orders", kind: "server" });
  });

  it("reads Jaeger traces", async () => {
    const trace = {
      traceID: "t",
      processes: { p1: { serviceName: "orders" } },
      spans: [
        { traceID: "t", spanID: "a", operationName: "POST /orders", processID: "p1", startTime: 1_000_000, duration: 30_000, tags: [{ key: "span.kind", value: "server" }] },
        { traceID: "t", spanID: "b", operationName: "SELECT", processID: "p1", startTime: 1_005_000, duration: 2_000, references: [{ refType: "CHILD_OF", spanID: "a" }], tags: [{ key: "span.kind", value: "client" }, { key: "error", value: true }] },
      ],
    };
    expect(fromJaeger(trace).map((s) => [s.spanId, s.parentSpanId, s.kind, s.status, s.end - s.start])).toEqual([
      ["a", undefined, "server", "unset", 30],
      ["b", "a", "client", "error", 2],
    ]);
    const { fetch, calls } = fakeFetch((c) => (c.url.endsWith("/api/services") ? { data: ["orders", "jaeger-query"] } : { data: [trace] }));
    expect(await jaegerSource({ url: "http://jaeger:16686" }, fetch).traces!({ from: T0, to: T0 + 1000, limit: 5 })).toHaveLength(2);
    expect(calls[1].url).toContain("service=orders&start=");
  });
});

describe("evidence scoped to the experiment's own requests (--run-id)", () => {
  const run = { attr: "breadth.run_id", value: "chaos-42" };
  const span = (trace: string, id: string, ms: number, extra: Record<string, unknown> = {}, status = "unset") =>
    ({ traceId: trace, spanId: id, name: "POST /orders", kind: "server", service: "orders", start: T0 + 1000, end: T0 + 1000 + ms, attrs: { "http.request.method": "POST", "http.route": "/orders", ...extra }, status }) as any;

  it("measures from spans: only traces carrying the run id count", async () => {
    const { measureFromSpans } = await import("./measure.js");
    const spans = [
      span("a", "1", 100, { "breadth.run_id": "chaos-42" }),
      span("b", "2", 300, {}, "error"),
      // the run id sits on the load generator's root span; the server span is in the same trace
      { ...span("c", "3", 50), kind: "client", service: "k6", attrs: { "breadth.run_id": "chaos-42" } },
      span("c", "4", 200),
      span("d", "5", 5000), // someone else's traffic in the same window
    ];
    const m = measureFromSpans(spans, { from: T0, to: T0 + 10_000, service: "orders", endpoint: "POST /orders", run });
    expect(m).toMatchObject({ p50_ms: 100, p95_ms: 200, error_pct: 0, throughput_rps: 0.2 });
    expect(measureFromSpans(spans, { from: T0, to: T0 + 10_000, service: "orders" }).error_pct).toBe(25);
  });

  it("asks each backend for only the run's spans", async () => {
    process.env.DD_API_KEY = "k";
    process.env.DD_APP_KEY = "a";
    const dd = fakeFetch(() => ({ data: [{ attributes: { by: {}, compute: { c0: 10, c1: 9e7 } } }] }));
    await datadogSource({}, dd.fetch).measure!({ from: T0, to: T0 + 60_000, service: "orders", run });
    expect(dd.calls[0].body.data.attributes.filter.query).toContain('@breadth.run_id:"chaos-42"');

    const tempo = fakeFetch((c) => (c.url.includes("/api/search") ? { traces: [] } : {}));
    await tempoSource({ url: "http://tempo:3200" }, tempo.fetch).measure!({ from: T0, to: T0 + 60_000, service: "orders", run });
    expect(decodeURIComponent(tempo.calls[0].url)).toContain('{ resource.service.name = "orders" } && { .breadth.run_id = "chaos-42" }');

    const jaeger = fakeFetch(() => ({ data: [] }));
    await jaegerSource({ url: "http://jaeger:16686" }, jaeger.fetch).measure!({ from: T0, to: T0 + 60_000, service: "orders", run });
    expect(decodeURIComponent(jaeger.calls[0].url)).toContain('tags={"breadth.run_id":"chaos-42"}');

    const prom = fakeFetch(() => ({ status: "success", data: { result: [] } }));
    await expect(prometheusSource({ url: "http://prom:9090" }, prom.fetch).measure!({ from: T0, to: T0 + 60_000, service: "orders", run })).rejects.toThrow(/runLabel/);
    await prometheusSource({ url: "http://prom:9090", runLabel: "run_id" }, prom.fetch).measure!({ from: T0, to: T0 + 60_000, service: "orders", run });
    expect(decodeURIComponent(prom.calls[0].url)).toContain('service_name="orders",run_id="chaos-42"');
  });
});

describe("pull into a graph", () => {
  it("adds Datadog traces as executions and traffic on the shop's endpoints", async () => {
    process.env.DD_API_KEY = "k";
    process.env.DD_APP_KEY = "a";
    const shop = path.resolve(__dirname, "../../../examples/shop");
    const base = await runCollectors(shop, ["code"], { exclude: ["**/generate.mjs", "traces/"] });
    const { fetch } = fakeFetch((c) =>
      c.url.endsWith("/events/search")
        ? { data: [{ attributes: { trace_id: "9", span_id: "1", parent_id: "0", service: "orders", resource_name: "POST /orders", type: "web", custom: { "span.kind": "server", http: { method: "POST", route: "/orders" } }, start_timestamp: new Date(T0).toISOString(), end_timestamp: new Date(T0 + 20).toISOString() } }] }
        : { data: [{ attributes: { by: { service: "orders", resource_name: "POST /orders" }, compute: c.body.data.attributes.filter.query.includes("status:error") ? { c0: 12 } : { c0: 6000, c1: 95e6 } } }] },
    );
    const r = await pullLive(base, [createSource("datadog", { datadog: { env: "prod" } }, fetch)], { since: 3_600_000, until: T0 + 3_600_000, traces: true, stats: true, limit: 50, window: "1h" });
    expect(r.traces).toBe(1);
    expect(r.graph.executions?.[0].name).toBe("orders: POST /orders");
    const route = r.graph.nodes.find((n) => n.id === "route:services/orders/app/main.py#POST /orders")!;
    expect(route.metadata?.live).toMatchObject({ rpm: 100, p95_ms: 95, error_pct: 0.2, source: "datadog", window: "1h" });
    expect(applyLiveStats(r.graph, [{ service: "nope", endpoint: "GET /nowhere", rpm: 1 }], "x", "1h")).toBe(0);
  });
});
