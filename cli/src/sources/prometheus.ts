import { getJson, secret, SourceError, type Fetch, type LiveSource, type LiveStat, type Measure } from "./types.js";

/**
 * Prometheus (or Mimir, Thanos, VictoriaMetrics, Grafana Cloud): stats and evidence measurements
 * from PromQL. The default queries read OpenTelemetry span metrics (the Collector's spanmetrics
 * connector); override them for other metric names. In queries, $range is the window
 * ("3600s") and $service / $endpoint are filled in for measure().
 *
 * Loki answers LogQL metric queries in the same shape, so it shares this adapter with defaults
 * for structured (JSON) request logs.
 */
export interface PrometheusSettings {
  url: string;
  /** Bearer token, by environment variable */
  tokenEnv?: string;
  /** Basic auth "user:password", by environment variable (Grafana Cloud) */
  basicAuthEnv?: string;
  /** X-Scope-OrgID for multi-tenant Mimir / Cortex */
  orgId?: string;
  serviceLabel?: string;
  endpointLabel?: string;
  queries?: Partial<Record<"requests" | "errors" | "p95_ms" | "p50_ms" | "p99_ms", string>>;
  /** Label holding the experiment's run id (a spanmetrics dimension), for breadth evidence --run-id. */
  runLabel?: string;
}

const SERVER = 'span_kind="SPAN_KIND_SERVER"';
type QueryName = "requests" | "errors" | "p95_ms" | "p50_ms" | "p99_ms";
const DEFAULTS: Record<QueryName, string> = {
  requests: `sum by ($by) (increase(traces_span_metrics_calls_total{${SERVER}$filter}[$range]))`,
  errors: `sum by ($by) (increase(traces_span_metrics_calls_total{${SERVER},status_code="STATUS_CODE_ERROR"$filter}[$range]))`,
  p95_ms: `histogram_quantile(0.95, sum by (le, $by) (rate(traces_span_metrics_duration_milliseconds_bucket{${SERVER}$filter}[$range])))`,
  p50_ms: `histogram_quantile(0.50, sum by (le, $by) (rate(traces_span_metrics_duration_milliseconds_bucket{${SERVER}$filter}[$range])))`,
  p99_ms: `histogram_quantile(0.99, sum by (le, $by) (rate(traces_span_metrics_duration_milliseconds_bucket{${SERVER}$filter}[$range])))`,
};

/** Loki: request logs as JSON lines with method, route, status and duration_ms fields. */
export interface LokiSettings extends PrometheusSettings {
  /** JSON field with the HTTP method (default method); endpoints are "<method> <route>". */
  methodLabel?: string;
}
const LOGS = (expr: string) => `{service_name=~".+"$stream} | json | ${expr}$where`;
const LOKI_DEFAULTS: Record<QueryName, string> = {
  requests: `sum by ($by) (count_over_time(${LOGS('status != ""')} [$range]))`,
  errors: `sum by ($by) (count_over_time(${LOGS("status >= 500")} [$range]))`,
  p95_ms: `quantile_over_time(0.95, ${LOGS('duration_ms != ""')} | unwrap duration_ms [$range]) by ($by)`,
  p50_ms: `quantile_over_time(0.50, ${LOGS('duration_ms != ""')} | unwrap duration_ms [$range]) by ($by)`,
  p99_ms: `quantile_over_time(0.99, ${LOGS('duration_ms != ""')} | unwrap duration_ms [$range]) by ($by)`,
};

export function lokiSource(s: LokiSettings, fetchImpl: Fetch = fetch as unknown as Fetch): LiveSource {
  return querySource("loki", s, fetchImpl);
}

export function prometheusSource(s: PrometheusSettings, fetchImpl: Fetch = fetch as unknown as Fetch): LiveSource {
  return querySource("prometheus", s, fetchImpl);
}

function querySource(kind: "prometheus" | "loki", s: LokiSettings, fetchImpl: Fetch): LiveSource {
  const loki = kind === "loki";
  const svcLabel = s.serviceLabel ?? "service_name";
  const epLabel = s.endpointLabel ?? (loki ? "route" : "span_name");
  const methodLabel = loki ? (s.methodLabel ?? "method") : undefined;
  const defaults = loki ? LOKI_DEFAULTS : DEFAULTS;
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {};
    const token = secret(s.tokenEnv, `${kind} token`);
    const basic = secret(s.basicAuthEnv, `${kind} basic auth`);
    if (token) h.authorization = `Bearer ${token}`;
    else if (basic) h.authorization = `Basic ${Buffer.from(basic).toString("base64")}`;
    if (s.orgId) h["X-Scope-OrgID"] = s.orgId;
    return h;
  };
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const render = (name: QueryName, o: { by: string[]; range: number; service?: string; endpoint?: string; run?: string }) => {
    // Loki: the service is a stream label; the endpoint and run id are fields of the parsed line.
    const [method, route] = loki && o.endpoint?.includes(" ") ? o.endpoint.split(/\s+/, 2) : [undefined, o.endpoint];
    const fields = [method ? `${methodLabel}="${esc(method)}"` : "", route ? `${epLabel}="${esc(route)}"` : "", o.run && s.runLabel ? `${s.runLabel}="${esc(o.run)}"` : ""].filter(Boolean);
    const labels = [o.service ? `${svcLabel}="${esc(o.service)}"` : "", ...(loki ? [] : fields)].filter(Boolean);
    return (s.queries?.[name] ?? defaults[name])
      .replace(/ by \(\$by\)/g, o.by.length ? ` by (${o.by.join(", ")})` : "")
      .replace(/by \(le, \$by\)/g, o.by.length ? `by (le, ${o.by.join(", ")})` : "by (le)")
      .replace(/\$by/g, o.by.join(", "))
      .replace(/\$range/g, `${Math.max(60, Math.round(o.range / 1000))}s`)
      .replace(/\$filter/g, labels.map((l) => `,${l}`).join(""))
      .replace(/\$stream/g, o.service ? `,${svcLabel}="${esc(o.service)}"` : "")
      .replace(/\$where/g, loki ? fields.map((f) => ` | ${f}`).join("") : "")
      .replace(/\$run/g, esc(o.run ?? ""))
      .replace(/\$service/g, esc(o.service ?? ""))
      .replace(/\$endpoint/g, esc(o.endpoint ?? ""));
  };
  async function instant(query: string, at: number): Promise<{ metric: Record<string, string>; value: number }[]> {
    const api = loki ? "/loki/api/v1/query" : "/api/v1/query";
    const time = loki ? `${Math.round(at * 1e6)}` : (at / 1000).toFixed(3);
    const url = `${s.url.replace(/\/$/, "")}${api}?query=${encodeURIComponent(query)}&time=${time}`;
    const out = await getJson(fetchImpl, url, { headers: headers() }, kind);
    if (out?.status !== "success") throw new Error(`${kind}: ${out?.error ?? "query failed"}`);
    return ((out.data?.result ?? []) as any[]).map((r) => ({ metric: r.metric ?? {}, value: Number(r.value?.[1]) })).filter((r) => Number.isFinite(r.value));
  }

  return {
    name: kind,
    describe: `${loki ? "Loki" : "Prometheus"} (${new URL(s.url).host})`,

    async stats(q) {
      const by = [svcLabel, ...(methodLabel ? [methodLabel] : []), epLabel];
      const range = q.to - q.from;
      const endpointOf = (m: Record<string, string>) => (methodLabel && m[methodLabel] && m[epLabel] ? `${m[methodLabel]} ${m[epLabel]}` : m[epLabel]);
      const key = (m: Record<string, string>) => `${m[svcLabel]}|${endpointOf(m)}`;
      const [req, err, p95] = await Promise.all([instant(render("requests", { by, range }), q.to), instant(render("errors", { by, range }), q.to), instant(render("p95_ms", { by, range }), q.to)]);
      const errs = new Map(err.map((r) => [key(r.metric), r.value]));
      const lat = new Map(p95.map((r) => [key(r.metric), r.value]));
      return req
        .filter((r) => !q.services?.length || q.services.includes(r.metric[svcLabel]))
        .map((r): LiveStat => ({
          service: r.metric[svcLabel] ?? "unknown",
          endpoint: endpointOf(r.metric),
          rpm: r.value / (range / 60_000),
          p95_ms: lat.get(key(r.metric)),
          error_pct: r.value ? ((errs.get(key(r.metric)) ?? 0) / r.value) * 100 : undefined,
        }));
    },

    async measure(q) {
      // Metrics are aggregates: without a run-id label they cannot tell the experiment's requests apart.
      if (q.run && !s.runLabel && !Object.values(s.queries ?? {}).some((x) => x?.includes("$run"))) {
        throw new SourceError(
          loki
            ? "loki: say which log field holds the run id with sources.loki.runLabel, or measure with a trace source (datadog, tempo, jaeger)"
            : "prometheus: metrics carry no run id. Add the run attribute as a spanmetrics dimension and set sources.prometheus.runLabel, or measure with a trace source (datadog, tempo, jaeger)",
        );
      }
      const o = { by: [] as string[], range: q.to - q.from, service: q.service, endpoint: q.endpoint, run: q.run?.value };
      const one = async (name: QueryName) => (await instant(render(name, o), q.to))[0]?.value;
      const [requests, errors, p95, p50, p99] = await Promise.all([one("requests"), one("errors"), one("p95_ms"), one("p50_ms"), one("p99_ms")]);
      const out: Partial<Record<Measure, number>> = {};
      if (requests) {
        out.error_pct = ((errors ?? 0) / requests) * 100;
        out.availability_pct = 100 - out.error_pct;
        out.throughput_rps = requests / ((q.to - q.from) / 1000);
      }
      if (p95 !== undefined && Number.isFinite(p95)) out.p95_ms = p95;
      if (p50 !== undefined && Number.isFinite(p50)) out.p50_ms = p50;
      if (p99 !== undefined && Number.isFinite(p99)) out.p99_ms = p99;
      return out;
    },
  };
}
