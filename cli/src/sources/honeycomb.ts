import { getJson, secret, SourceError, type Fetch, type LiveSource, type LiveStat, type Measure, type RunFilter } from "./types.js";

/**
 * Honeycomb through the Query Data API (read only): a query spec is created, run, and its
 * result polled. Stats break down server spans by service and span name; measure() runs the
 * same calculations for one service (and endpoint) over the window.
 *
 * Needs a configuration or management key with "Run Queries" (and the Query Data API, a Pro /
 * Enterprise feature), named by environment variable.
 */
export interface HoneycombSettings {
  /** api.honeycomb.io (default) or api.eu1.honeycomb.io */
  host?: string;
  apiKeyEnv?: string;
  /** Dataset to query (default __all__: every dataset in the environment) */
  dataset?: string;
  serviceColumn?: string;
  endpointColumn?: string;
  /** Filter for requests into a service (default span.kind = server) */
  serverFilter?: { column: string; op: string; value?: unknown };
}

interface Calc {
  op: string;
  column?: string;
}

export function honeycombSource(s: HoneycombSettings, fetchImpl: Fetch = fetch as unknown as Fetch, pollMs = 500): LiveSource {
  const base = `https://${(s.host ?? "api.honeycomb.io").replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  const dataset = encodeURIComponent(s.dataset ?? "__all__");
  const svc = s.serviceColumn ?? "service.name";
  const ep = s.endpointColumn ?? "name";
  const server = s.serverFilter ?? { column: "span.kind", op: "=", value: "server" };
  const headers = () => ({ "content-type": "application/json", "X-Honeycomb-Team": secret(s.apiKeyEnv ?? "HONEYCOMB_API_KEY", "honeycomb")! });

  async function run(from: number, to: number, calculations: Calc[], filters: object[], breakdowns: string[]): Promise<Record<string, unknown>[]> {
    const spec = { calculations, filters: [server, ...filters], filter_combination: "AND", breakdowns, start_time: Math.floor(from / 1000), end_time: Math.ceil(to / 1000), limit: 1000 };
    const q = await getJson(fetchImpl, `${base}/1/queries/${dataset}`, { method: "POST", headers: headers(), body: JSON.stringify(spec) }, "honeycomb");
    let r = await getJson(fetchImpl, `${base}/1/query_results/${dataset}`, { method: "POST", headers: headers(), body: JSON.stringify({ query_id: q.id, disable_series: true }) }, "honeycomb");
    for (let i = 0; !r?.complete && i < 30; i++) {
      await new Promise((res) => setTimeout(res, pollMs));
      r = await getJson(fetchImpl, `${base}/1/query_results/${dataset}/${r.id}`, { headers: headers() }, "honeycomb");
    }
    if (!r?.complete) throw new SourceError("honeycomb: query did not finish in time; try a shorter window");
    return ((r.data?.results ?? []) as any[]).map((x) => (x.data ?? x) as Record<string, unknown>);
  }
  const CALCS: Calc[] = [{ op: "COUNT" }, { op: "P50", column: "duration_ms" }, { op: "P95", column: "duration_ms" }, { op: "P99", column: "duration_ms" }];
  const ERRORS = { column: "error", op: "=", value: true };
  const runFilter = (r?: RunFilter) => (r ? [{ column: r.attr, op: "=", value: r.value }] : []);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

  return {
    name: "honeycomb",
    describe: `Honeycomb (${new URL(base).host}, dataset ${decodeURIComponent(dataset)})`,

    async stats(q) {
      const filters = q.services?.length ? [{ column: svc, op: "in", value: q.services }] : [];
      const [all, errs] = await Promise.all([run(q.from, q.to, CALCS, filters, [svc, ep]), run(q.from, q.to, [{ op: "COUNT" }], [...filters, ERRORS], [svc, ep])]);
      const key = (r: Record<string, unknown>) => `${r[svc]}|${r[ep]}`;
      const errCount = new Map(errs.map((r) => [key(r), num(r.COUNT) ?? 0]));
      const minutes = (q.to - q.from) / 60_000;
      return all.map((r): LiveStat => {
        const count = num(r.COUNT) ?? 0;
        return {
          service: String(r[svc] ?? "unknown"),
          endpoint: r[ep] !== undefined ? String(r[ep]) : undefined,
          rpm: count / minutes,
          p95_ms: num(r["P95(duration_ms)"]),
          error_pct: count ? ((errCount.get(key(r)) ?? 0) / count) * 100 : undefined,
        };
      });
    },

    async measure(q) {
      const filters = [{ column: svc, op: "=", value: q.service }, ...(q.endpoint ? [{ column: ep, op: "=", value: q.endpoint }] : []), ...runFilter(q.run)];
      const [[all], [errs]] = await Promise.all([run(q.from, q.to, CALCS, filters, []), run(q.from, q.to, [{ op: "COUNT" }], [...filters, ERRORS], [])]);
      const count = num(all?.COUNT) ?? 0;
      if (!count) return {};
      const errorPct = ((num(errs?.COUNT) ?? 0) / count) * 100;
      const out: Partial<Record<Measure, number>> = { error_pct: errorPct, availability_pct: 100 - errorPct, throughput_rps: count / ((q.to - q.from) / 1000) };
      for (const [m, col] of [["p50_ms", "P50"], ["p95_ms", "P95"], ["p99_ms", "P99"]] as const) {
        const v = num(all[`${col}(duration_ms)`]);
        if (v !== undefined) out[m] = v;
      }
      return out;
    },
  };
}
