import { linkTracesToCode, spansToGraph } from "@breadth/collectors";
import { mergeGraphs, type FlowGraph } from "@breadth/schema";
import { applyLiveStats } from "./apply.js";
import { datadogSource, type DatadogSettings } from "./datadog.js";
import { prometheusSource, type PrometheusSettings } from "./prometheus.js";
import { jaegerSource, tempoSource, type JaegerSettings, type TempoSettings } from "./traces.js";
import { SourceError, type Fetch, type LiveSource } from "./types.js";

export { applyLiveStats, liveText, type LiveInfo } from "./apply.js";
export { parseDuration, SourceError, type LiveSource, type LiveStat, type Measure } from "./types.js";

/** `sources` in breadth.config.json: one entry per backend (name -> settings). */
export interface SourcesConfig {
  datadog?: DatadogSettings;
  prometheus?: PrometheusSettings;
  tempo?: TempoSettings;
  jaeger?: JaegerSettings;
  /** Services to ask about (default: every service the backend knows). */
  services?: string[];
}

export const SOURCE_NAMES = ["datadog", "prometheus", "tempo", "jaeger"] as const;

export function createSource(name: string, config: SourcesConfig | undefined, fetchImpl?: Fetch): LiveSource {
  const s = (config ?? {}) as Record<string, any>;
  switch (name) {
    case "datadog":
      return datadogSource(s.datadog ?? {}, fetchImpl);
    case "prometheus":
      if (!s.prometheus?.url) throw new SourceError('prometheus: set sources.prometheus.url in breadth.config.json');
      return prometheusSource(s.prometheus, fetchImpl);
    case "tempo":
      if (!s.tempo?.url) throw new SourceError('tempo: set sources.tempo.url in breadth.config.json');
      return tempoSource(s.tempo, fetchImpl);
    case "jaeger":
      if (!s.jaeger?.url) throw new SourceError('jaeger: set sources.jaeger.url in breadth.config.json');
      return jaegerSource(s.jaeger, fetchImpl);
  }
  throw new SourceError(`unknown source "${name}". Available: ${SOURCE_NAMES.join(", ")}`);
}

export interface PullOptions {
  since: number; // ms back from now
  until?: number;
  traces: boolean;
  stats: boolean;
  limit: number;
  services?: string[];
  window: string;
}

export interface PullResult {
  graph: FlowGraph;
  spans: number;
  traces: number;
  stats: number;
  matched: number;
}

/**
 * Fetch traces and traffic from live sources into a graph: traces become executions linked to
 * code, stats annotate endpoints and services (metadata.live).
 */
export async function pullLive(base: FlowGraph, sources: LiveSource[], o: PullOptions): Promise<PullResult> {
  const to = o.until ?? Date.now();
  const from = to - o.since;
  let graph = base;
  let spans = 0;
  let traces = 0;
  let stats = 0;
  let matched = 0;
  for (const src of sources) {
    if (o.traces && src.traces) {
      const got = await src.traces({ from, to, services: o.services, limit: o.limit });
      if (got.length) {
        const g = spansToGraph(got, [src.name]);
        spans += got.length;
        traces += g.executions?.length ?? 0;
        graph = mergeGraphs(graph, linkTracesToCode(g, graph));
      }
    }
    if (o.stats && src.stats) {
      const got = await src.stats({ from, to, services: o.services });
      stats += got.length;
      matched += applyLiveStats(graph, got, src.name, o.window);
    }
  }
  return { graph, spans, traces, stats, matched };
}
