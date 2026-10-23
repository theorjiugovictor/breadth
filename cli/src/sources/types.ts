import type { Span } from "@breadth/collectors";

/**
 * A live observability backend (Datadog, Prometheus, Tempo, Jaeger, ...). Each adapter does what
 * its backend can: traces become executions on the graph, stats annotate services and
 * endpoints, measure() answers one number for a time window (evidence verdicts).
 *
 * Credentials never live in config: config names the environment variable that holds them.
 */
export interface LiveSource {
  name: string;
  /** "datadog: datadoghq.eu, env prod": shown in the privacy notice */
  describe: string;
  traces?(q: TraceQuery): Promise<Span[]>;
  stats?(q: StatsQuery): Promise<LiveStat[]>;
  measure?(q: MeasureQuery): Promise<Partial<Record<Measure, number>>>;
}

export interface TraceQuery {
  from: number; // epoch ms
  to: number;
  services?: string[];
  limit: number;
}

export interface StatsQuery {
  from: number;
  to: number;
  services?: string[];
}

/** Traffic of one endpoint (or a whole service when endpoint is undefined) over the window. */
export interface LiveStat {
  service: string;
  /** "POST /checkout", as the backend names it (route, resource, span name) */
  endpoint?: string;
  /** requests per minute */
  rpm: number;
  p95_ms?: number;
  error_pct?: number;
}

export type Measure = "p50_ms" | "p95_ms" | "p99_ms" | "error_pct" | "availability_pct" | "throughput_rps";

export interface MeasureQuery {
  from: number;
  to: number;
  service: string;
  endpoint?: string;
}

/** What `fetch` is to adapters: injectable, so tests run against recorded responses. */
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export class SourceError extends Error {}

/** Read a secret from the environment variable config names. */
export function secret(envName: string | undefined, what: string, required = true): string | undefined {
  if (!envName) return undefined;
  const v = process.env[envName];
  if (!v && required) throw new SourceError(`${what}: set the ${envName} environment variable`);
  return v || undefined;
}

export async function getJson(fetchImpl: Fetch, url: string, init: Parameters<Fetch>[1], what: string): Promise<any> {
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw new SourceError(`${what}: cannot reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    const hint = res.status === 401 || res.status === 403 ? " (check the key and its permissions)" : "";
    throw new SourceError(`${what}: ${res.status} from ${new URL(url).host}${hint}${body ? `: ${body}` : ""}`);
  }
  return res.json();
}

/** "1h", "30m", "2d", "90s" -> milliseconds */
export function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!m) throw new Error(`not a duration: ${s} (use 30m, 1h, 2d)`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "ms"];
}

/** Comparable endpoint names: "post /orders/:id" ~ "POST /orders/{order_id}" ~ "POST /orders/<id>". */
export function endpointKey(name: string): string {
  const m = name.trim().match(/^([A-Za-z]+)\s+(\S+)/);
  if (!m) return name.trim().toLowerCase();
  const path = m[2]
    .split("?")[0]
    .replace(/\{[^}]*\}|:[\w-]+|<[^>]*>|\[[^\]]*\]/g, "{}")
    .replace(/\/+$/, "") || "/";
  return `${m[1].toUpperCase()} ${path}`;
}
