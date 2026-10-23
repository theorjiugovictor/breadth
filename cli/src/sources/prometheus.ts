import { getJson, secret, type Fetch, type LiveSource, type LiveStat, type Measure } from "./types.js";

/**
 * Prometheus (or Mimir, Thanos, VictoriaMetrics, Grafana Cloud): stats and evidence measurements
 * from PromQL. The default queries read OpenTelemetry span metrics (the Collector's spanmetrics
 * connector); override them for other metric names. In queries, $range is the window
 * ("3600s") and $service / $endpoint are filled in for measure().
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
}

const SERVER = 'span_kind="SPAN_KIND_SERVER"';
const DEFAULTS = {
  requests: `sum by ($by) (increase(traces_span_metrics_calls_total{${SERVER}$filter}[$range]))`,
  errors: `sum by ($by) (increase(traces_span_metrics_calls_total{${SERVER},status_code="STATUS_CODE_ERROR"$filter}[$range]))`,
  p95_ms: `histogram_quantile(0.95, sum by (le, $by) (rate(traces_span_metrics_duration_milliseconds_bucket{${SERVER}$filter}[$range])))`,
  p50_ms: `histogram_quantile(0.50, sum by (le, $by) (rate(traces_span_metrics_duration_milliseconds_bucket{${SERVER}$filter}[$range])))`,
  p99_ms: `histogram_quantile(0.99, sum by (le, $by) (rate(traces_span_metrics_duration_milliseconds_bucket{${SERVER}$filter}[$range])))`,
};

export function prometheusSource(s: PrometheusSettings, fetchImpl: Fetch = fetch as unknown as Fetch): LiveSource {
  const svcLabel = s.serviceLabel ?? "service_name";
  const epLabel = s.endpointLabel ?? "span_name";
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = {};
    const token = secret(s.tokenEnv, "prometheus token");
    const basic = secret(s.basicAuthEnv, "prometheus basic auth");
    if (token) h.authorization = `Bearer ${token}`;
    else if (basic) h.authorization = `Basic ${Buffer.from(basic).toString("base64")}`;
    if (s.orgId) h["X-Scope-OrgID"] = s.orgId;
    return h;
  };
  const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const render = (name: keyof typeof DEFAULTS, o: { by: string[]; range: number; service?: string; endpoint?: string }) =>
    (s.queries?.[name] ?? DEFAULTS[name])
      .replace(/\$by/g, o.by.join(", ") || "__name__")
      .replace(/\$range/g, `${Math.max(60, Math.round(o.range / 1000))}s`)
      .replace(/\$filter/g, [o.service ? `,${svcLabel}="${esc(o.service)}"` : "", o.endpoint ? `,${epLabel}="${esc(o.endpoint)}"` : ""].join(""))
      .replace(/\$service/g, esc(o.service ?? ""))
      .replace(/\$endpoint/g, esc(o.endpoint ?? ""));
  async function instant(query: string, at: number): Promise<{ metric: Record<string, string>; value: number }[]> {
    const url = `${s.url.replace(/\/$/, "")}/api/v1/query?query=${encodeURIComponent(query)}&time=${(at / 1000).toFixed(3)}`;
    const out = await getJson(fetchImpl, url, { headers: headers() }, "prometheus");
    if (out?.status !== "success") throw new Error(`prometheus: ${out?.error ?? "query failed"}`);
    return ((out.data?.result ?? []) as any[]).map((r) => ({ metric: r.metric ?? {}, value: Number(r.value?.[1]) })).filter((r) => Number.isFinite(r.value));
  }

  return {
    name: "prometheus",
    describe: `Prometheus (${new URL(s.url).host})`,

    async stats(q) {
      const by = [svcLabel, epLabel];
      const range = q.to - q.from;
      const key = (m: Record<string, string>) => `${m[svcLabel]}|${m[epLabel]}`;
      const [req, err, p95] = await Promise.all([instant(render("requests", { by, range }), q.to), instant(render("errors", { by, range }), q.to), instant(render("p95_ms", { by, range }), q.to)]);
      const errs = new Map(err.map((r) => [key(r.metric), r.value]));
      const lat = new Map(p95.map((r) => [key(r.metric), r.value]));
      return req
        .filter((r) => !q.services?.length || q.services.includes(r.metric[svcLabel]))
        .map((r): LiveStat => ({
          service: r.metric[svcLabel] ?? "unknown",
          endpoint: r.metric[epLabel],
          rpm: r.value / (range / 60_000),
          p95_ms: lat.get(key(r.metric)),
          error_pct: r.value ? ((errs.get(key(r.metric)) ?? 0) / r.value) * 100 : undefined,
        }));
    },

    async measure(q) {
      const o = { by: [] as string[], range: q.to - q.from, service: q.service, endpoint: q.endpoint };
      const one = async (name: keyof typeof DEFAULTS) => (await instant(render(name, o), q.to))[0]?.value;
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
