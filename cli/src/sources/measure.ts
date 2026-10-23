import type { Span } from "@breadth/collectors";
import { endpointKey, type Measure, type MeasureQuery } from "./types.js";

/**
 * Evidence numbers from raw spans, for backends that store traces but have no aggregate API
 * (Tempo, Jaeger): the service's server spans in the window, optionally only those of traces
 * that carry the run id somewhere (the load generator's root span, or baggage copied down).
 */
export function measureFromSpans(spans: Span[], q: MeasureQuery): Partial<Record<Measure, number>> {
  const runTraces = q.run ? new Set(spans.filter((s) => String(s.attrs[q.run!.attr] ?? "") === q.run!.value).map((s) => s.traceId)) : undefined;
  const want = q.endpoint ? endpointKey(q.endpoint) : undefined;
  const nameOf = (s: Span) => {
    const method = s.attrs["http.request.method"] ?? s.attrs["http.method"];
    const route = s.attrs["http.route"];
    return method && route ? `${method} ${route}` : s.name;
  };
  const picked = spans.filter(
    (s) => s.kind === "server" && s.service === q.service && s.start >= q.from && s.start <= q.to && (!runTraces || runTraces.has(s.traceId)) && (!want || endpointKey(nameOf(s)) === want || endpointKey(s.name) === want),
  );
  if (!picked.length) return {};
  const durations = picked.map((s) => s.end - s.start).sort((a, b) => a - b);
  const pct = (p: number) => durations[Math.min(durations.length - 1, Math.max(0, Math.ceil((p / 100) * durations.length) - 1))];
  const errors = picked.filter((s) => s.status === "error" || Number(s.attrs["http.response.status_code"] ?? s.attrs["http.status_code"] ?? 0) >= 500).length;
  const errorPct = (errors / picked.length) * 100;
  return { p50_ms: pct(50), p95_ms: pct(95), p99_ms: pct(99), error_pct: errorPct, availability_pct: 100 - errorPct, throughput_rps: picked.length / ((q.to - q.from) / 1000) };
}
