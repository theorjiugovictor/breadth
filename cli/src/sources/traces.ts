import { parseOtlp, type Span } from "@breadth/collectors";
import { measureFromSpans } from "./measure.js";
import { getJson, secret, type Fetch, type LiveSource } from "./types.js";

/** Grafana Tempo: TraceQL / tag search, then each trace as OTLP JSON. */
export interface TempoSettings {
  url: string;
  tokenEnv?: string;
  basicAuthEnv?: string;
  orgId?: string;
}

export function tempoSource(s: TempoSettings, fetchImpl: Fetch = fetch as unknown as Fetch): LiveSource {
  const base = s.url.replace(/\/$/, "");
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { accept: "application/json" };
    const token = secret(s.tokenEnv, "tempo token");
    const basic = secret(s.basicAuthEnv, "tempo basic auth");
    if (token) h.authorization = `Bearer ${token}`;
    else if (basic) h.authorization = `Basic ${Buffer.from(basic).toString("base64")}`;
    if (s.orgId) h["X-Scope-OrgID"] = s.orgId;
    return h;
  };
  return {
    name: "tempo",
    describe: `Tempo (${new URL(base).host})`,
    async traces(q) {
      const services = q.services?.length ? q.services : [undefined];
      const ids = new Set<string>();
      for (const svc of services) {
        const q2 = (v: string) => v.replace(/"/g, '\\"');
        const parts = [svc ? `{ resource.service.name = "${q2(svc)}" }` : "", q.where ? `{ .${q.where.attr} = "${q2(q.where.value)}" }` : ""].filter(Boolean);
        const traceql = parts.join(" && ") || "{}";
        const url = `${base}/api/search?q=${encodeURIComponent(traceql)}&start=${Math.floor(q.from / 1000)}&end=${Math.ceil(q.to / 1000)}&limit=${Math.min(q.limit, 500)}`;
        const out = await getJson(fetchImpl, url, { headers: headers() }, "tempo");
        for (const t of (out?.traces ?? []) as any[]) if (t.traceID) ids.add(String(t.traceID));
      }
      const spans: Span[] = [];
      for (const id of [...ids].slice(0, q.limit)) {
        const out = await getJson(fetchImpl, `${base}/api/traces/${id}`, { headers: headers() }, "tempo");
        // v1: { batches | resourceSpans }, v2: { trace: { resourceSpans } }
        spans.push(...parseOtlp(JSON.stringify(out?.trace ?? out)));
      }
      return spans;
    },
    async measure(q) {
      return measureFromSpans(await this.traces!({ from: q.from, to: q.to, services: [q.service], limit: 500, where: q.run }), q);
    },
  };
}

/** Jaeger query service (/api/traces). */
export interface JaegerSettings {
  url: string;
  tokenEnv?: string;
}

export function jaegerSource(s: JaegerSettings, fetchImpl: Fetch = fetch as unknown as Fetch): LiveSource {
  const base = s.url.replace(/\/$/, "");
  const headers = (): Record<string, string> => {
    const token = secret(s.tokenEnv, "jaeger token");
    return token ? { authorization: `Bearer ${token}` } : {};
  };
  return {
    name: "jaeger",
    describe: `Jaeger (${new URL(base).host})`,
    async traces(q) {
      let services = q.services;
      if (!services?.length) services = ((await getJson(fetchImpl, `${base}/api/services`, { headers: headers() }, "jaeger"))?.data ?? []).filter((x: string) => x !== "jaeger-query");
      const spans: Span[] = [];
      const per = Math.max(1, Math.floor(q.limit / Math.max(1, services!.length)));
      for (const svc of services!) {
        const tags = q.where ? `&tags=${encodeURIComponent(JSON.stringify({ [q.where.attr]: q.where.value }))}` : "";
        const url = `${base}/api/traces?service=${encodeURIComponent(svc)}&start=${q.from * 1000}&end=${q.to * 1000}&limit=${per}${tags}`;
        const out = await getJson(fetchImpl, url, { headers: headers() }, "jaeger");
        for (const t of (out?.data ?? []) as any[]) spans.push(...fromJaeger(t));
      }
      const seen = new Set<string>();
      return spans.filter((s) => (seen.has(s.traceId + s.spanId) ? false : (seen.add(s.traceId + s.spanId), true)));
    },
    async measure(q) {
      return measureFromSpans(await this.traces!({ from: q.from, to: q.to, services: [q.service], limit: 500, where: q.run }), q);
    },
  };
}

/** A Jaeger trace (UI / query JSON) -> spans. Tags keep their OTel names (span.kind, http.*, db.*). */
export function fromJaeger(t: any): Span[] {
  const procs = (t.processes ?? {}) as Record<string, { serviceName: string }>;
  return ((t.spans ?? []) as any[]).map((s) => {
    const attrs = Object.fromEntries(((s.tags ?? []) as any[]).map((x) => [x.key, x.value]));
    const parent = ((s.references ?? []) as any[]).find((r) => r.refType === "CHILD_OF")?.spanID;
    const kind = String(attrs["span.kind"] ?? "internal") as Span["kind"];
    const error = attrs.error === true || attrs["otel.status_code"] === "ERROR";
    const start = Number(s.startTime) / 1000;
    return {
      traceId: String(s.traceID ?? t.traceID),
      spanId: String(s.spanID),
      parentSpanId: parent ? String(parent) : undefined,
      name: String(s.operationName ?? "span"),
      kind: ["server", "client", "producer", "consumer"].includes(kind) ? kind : "internal",
      service: procs[s.processID]?.serviceName ?? "unknown_service",
      start,
      end: start + Number(s.duration ?? 0) / 1000,
      attrs,
      status: error ? "error" : "unset",
      error: error ? String(attrs["otel.status_description"] ?? attrs["error.message"] ?? "error") : undefined,
    } as Span;
  });
}
