import type { Span } from "@breadth/collectors";
import { getJson, secret, type Fetch, type LiveSource, type LiveStat, type Measure } from "./types.js";

/**
 * Datadog APM through the Spans API v2 (read only):
 *   traces   POST /api/v2/spans/events/search     -> spans, grouped into traces by trace_id
 *   stats    POST /api/v2/spans/analytics/aggregate -> count, p95 of @duration, errors per service + resource
 *   measure  the same aggregate over a window      -> p95_ms, error_pct, throughput_rps for evidence
 *
 * Needs an API key and an application key (with apm_read), named by environment variable.
 */
export interface DatadogSettings {
  /** datadoghq.com (default), datadoghq.eu, us3.datadoghq.com, us5.datadoghq.com, ap1.datadoghq.com, ddog-gov.com */
  site?: string;
  apiKeyEnv?: string;
  appKeyEnv?: string;
  /** env tag to filter on, e.g. prod */
  env?: string;
  /** extra span query, e.g. "team:payments" */
  query?: string;
  /** what counts as a request into a service (default: @span.kind:server) */
  serverQuery?: string;
}

export function datadogSource(s: DatadogSettings, fetchImpl: Fetch = fetch as unknown as Fetch): LiveSource {
  const site = s.site ?? "datadoghq.com";
  const base = `https://api.${site.replace(/^api\./, "")}`;
  const apiKeyEnv = s.apiKeyEnv ?? "DD_API_KEY";
  const appKeyEnv = s.appKeyEnv ?? "DD_APP_KEY";
  const headers = () => ({
    "content-type": "application/json",
    "DD-API-KEY": secret(apiKeyEnv, "datadog")!,
    "DD-APPLICATION-KEY": secret(appKeyEnv, "datadog (application key)")!,
  });
  const filter = (services: string[] | undefined, extra?: string) =>
    [s.env ? `env:${s.env}` : "", services?.length ? `service:(${services.join(" OR ")})` : "", s.query ?? "", extra ?? ""].filter(Boolean).join(" ") || "*";
  const iso = (ms: number) => new Date(ms).toISOString();

  async function aggregate(from: number, to: number, query: string, groupBy: string[]): Promise<{ by: Record<string, string>; c: Record<string, number> }[]> {
    const body = {
      data: {
        type: "aggregate_request",
        attributes: {
          filter: { from: iso(from), to: iso(to), query },
          compute: [
            { aggregation: "count", type: "total" },
            { aggregation: "pc95", metric: "@duration", type: "total" },
            { aggregation: "pc50", metric: "@duration", type: "total" },
            { aggregation: "pc99", metric: "@duration", type: "total" },
          ],
          group_by: groupBy.map((facet) => ({ facet, limit: 200 })),
        },
      },
    };
    const out = await getJson(fetchImpl, `${base}/api/v2/spans/analytics/aggregate`, { method: "POST", headers: headers(), body: JSON.stringify(body) }, "datadog");
    // buckets: data[] (spans API) or data.buckets[] (logs-style); compute or computes
    const buckets = (Array.isArray(out?.data) ? out.data : (out?.data?.buckets ?? [])) as any[];
    return buckets.map((b) => {
      const a = b.attributes ?? b;
      return { by: a.by ?? {}, c: a.compute ?? a.computes ?? {} };
    });
  }

  return {
    name: "datadog",
    describe: `Datadog (${site}${s.env ? `, env ${s.env}` : ""})`,

    async traces(q) {
      const spans: Span[] = [];
      let cursor: string | undefined;
      while (spans.length < q.limit) {
        const body = {
          data: {
            type: "search_request",
            attributes: { filter: { from: iso(q.from), to: iso(q.to), query: filter(q.services) }, sort: "-timestamp", page: { limit: Math.min(1000, q.limit - spans.length), ...(cursor ? { cursor } : {}) } },
          },
        };
        const out = await getJson(fetchImpl, `${base}/api/v2/spans/events/search`, { method: "POST", headers: headers(), body: JSON.stringify(body) }, "datadog");
        for (const d of (out?.data ?? []) as any[]) spans.push(toSpan(d.attributes ?? {}));
        cursor = out?.meta?.page?.after;
        if (!cursor || !(out?.data ?? []).length) break;
      }
      return spans;
    },

    async stats(q) {
      const window = (q.to - q.from) / 60_000;
      const server = s.serverQuery ?? "@span.kind:server";
      const all = await aggregate(q.from, q.to, filter(q.services, server), ["service", "resource_name"]);
      const errs = await aggregate(q.from, q.to, filter(q.services, `${server} status:error`), ["service", "resource_name"]);
      const errCount = new Map(errs.map((b) => [`${b.by.service}|${b.by.resource_name}`, Number(b.c.c0 ?? 0)]));
      return all.map((b): LiveStat => {
        const count = Number(b.c.c0 ?? 0);
        return {
          service: String(b.by.service),
          endpoint: b.by.resource_name ? String(b.by.resource_name) : undefined,
          rpm: count / window,
          p95_ms: b.c.c1 !== undefined ? Number(b.c.c1) / 1e6 : undefined,
          error_pct: count ? ((errCount.get(`${b.by.service}|${b.by.resource_name}`) ?? 0) / count) * 100 : undefined,
        };
      });
    },

    async measure(q) {
      const server = s.serverQuery ?? "@span.kind:server";
      const scope = `${server}${q.endpoint ? ` resource_name:"${q.endpoint.replace(/"/g, '\\"')}"` : ""}`;
      const [all] = await aggregate(q.from, q.to, filter([q.service], scope), []);
      const [errs] = await aggregate(q.from, q.to, filter([q.service], `${scope} status:error`), []);
      const count = Number(all?.c.c0 ?? 0);
      if (!count) return {};
      const errorPct = (Number(errs?.c.c0 ?? 0) / count) * 100;
      const ms = (v: unknown) => (v === undefined ? undefined : Number(v) / 1e6);
      const out: Partial<Record<Measure, number>> = { error_pct: errorPct, availability_pct: 100 - errorPct, throughput_rps: count / ((q.to - q.from) / 1000) };
      if (ms(all.c.c1) !== undefined) out.p95_ms = ms(all.c.c1);
      if (ms(all.c.c2) !== undefined) out.p50_ms = ms(all.c.c2);
      if (ms(all.c.c3) !== undefined) out.p99_ms = ms(all.c.c3);
      return out;
    },
  };
}

const KIND: Record<string, Span["kind"]> = { server: "server", client: "client", producer: "producer", consumer: "consumer", internal: "internal" };

/** A Datadog span event -> the importer's span (attributes renamed to OTel conventions where they differ). */
export function toSpan(a: any): Span {
  const custom = (a.custom ?? {}) as Record<string, any>;
  const flat: Record<string, unknown> = {};
  const walk = (o: Record<string, any>, prefix: string) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, `${prefix}${k}.`);
      else flat[`${prefix}${k}`] = v;
    }
  };
  walk(custom, "");
  walk(a.attributes ?? {}, "");
  const type = String(a.type ?? "");
  const kind = KIND[String(flat["span.kind"] ?? "")] ?? (type === "web" ? "server" : /^(http|db|sql|cache|redis|mongodb|cassandra|elasticsearch|grpc)$/.test(type) ? "client" : "internal");
  // Datadog names: http.method / http.status_code / db.type / out.host ; OTel: http.request.method, db.system, server.address
  const attrs: Record<string, unknown> = { ...flat };
  if (flat["http.method"] && !flat["http.request.method"]) attrs["http.request.method"] = flat["http.method"];
  if (flat["http.status_code"] && !flat["http.response.status_code"]) attrs["http.response.status_code"] = Number(flat["http.status_code"]);
  if (!attrs["db.system"] && (flat["db.type"] || /^(sql|db|redis|mongodb|cassandra|elasticsearch)$/.test(type))) attrs["db.system"] = flat["db.type"] ?? (type === "sql" || type === "db" ? "sql" : type);
  if (flat["out.host"] && !flat["server.address"]) attrs["server.address"] = flat["out.host"];
  if (flat["peer.service"] && !flat["server.address"]) attrs["server.address"] = flat["peer.service"];
  const isError = a.status === "error" || flat["error"] === true || flat["error"] === 1 || !!flat["error.message"] || !!flat["error.type"];
  const start = Date.parse(a.start_timestamp ?? "") || 0;
  const end = Date.parse(a.end_timestamp ?? "") || start + Number(flat["duration"] ?? 0) / 1e6;
  return {
    traceId: String(a.trace_id ?? ""),
    spanId: String(a.span_id ?? ""),
    parentSpanId: a.parent_id && a.parent_id !== "0" ? String(a.parent_id) : undefined,
    name: String(a.resource_name ?? flat["operation_name"] ?? a.name ?? "span"),
    kind,
    service: String(a.service ?? "unknown_service"),
    start,
    end,
    attrs,
    status: isError ? "error" : "unset",
    error: isError ? String(flat["error.message"] ?? flat["error.type"] ?? "error") : undefined,
  };
}
