import { promises as fs } from "node:fs";
import path from "node:path";
import {
  edgeId,
  SCHEMA_VERSION,
  type EdgeKind,
  type Execution,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type Port,
  type Status,
  type Step,
} from "@noodles/schema";
import type { Collector } from "../core/types.js";
import { normRoute } from "../code/build.js";

/* ------------------------------------------------------------------ */
/* OTLP JSON parsing                                                   */
/* ------------------------------------------------------------------ */

type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  bytesValue?: string;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
};
type KeyValue = { key: string; value?: AnyValue };

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number | string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: KeyValue[];
  status?: { code?: number | string; message?: string };
  events?: { name: string; timeUnixNano?: string; attributes?: KeyValue[] }[];
}

/** A span flattened with its resource attributes. */
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "internal" | "server" | "client" | "producer" | "consumer";
  service: string;
  start: number; // ms
  end: number; // ms
  attrs: Record<string, unknown>;
  status: Status;
  error?: string;
}

const KINDS = ["internal", "internal", "server", "client", "producer", "consumer"] as const;

function anyValue(v?: AnyValue): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.bytesValue !== undefined) return v.bytesValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(anyValue);
  if (v.kvlistValue) return attrsToObject(v.kvlistValue.values);
  return undefined;
}

function attrsToObject(kvs?: KeyValue[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const kv of kvs ?? []) o[kv.key] = anyValue(kv.value);
  return o;
}

function nanosToMs(n?: string | number): number {
  if (n === undefined) return 0;
  // Keep microsecond precision without overflowing doubles.
  const s = String(n);
  if (s.length > 6) return Number(s.slice(0, -6)) + Number(s.slice(-6)) / 1e6;
  return Number(s) / 1e6;
}

function spanKind(k?: number | string): Span["kind"] {
  if (typeof k === "number") return KINDS[k] ?? "internal";
  const s = String(k ?? "").toLowerCase().replace("span_kind_", "");
  return (["server", "client", "producer", "consumer"].includes(s) ? s : "internal") as Span["kind"];
}

function statusOf(s?: OtlpSpan["status"]): Status {
  const c = s?.code;
  if (c === 2 || c === "STATUS_CODE_ERROR" || c === "ERROR") return "error";
  if (c === 1 || c === "STATUS_CODE_OK" || c === "OK") return "ok";
  return "unset";
}

/** Accepts {resourceSpans}, {batches}, an array of those, or line-delimited JSON. */
export function parseOtlp(text: string): Span[] {
  const docs: unknown[] = [];
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) docs.push(...parsed);
    else docs.push(parsed);
  } catch {
    for (const line of trimmed.split("\n")) {
      if (line.trim()) docs.push(JSON.parse(line));
    }
  }
  const spans: Span[] = [];
  for (const doc of docs as Record<string, unknown>[]) {
    const rss = (doc.resourceSpans ?? doc.batches ?? []) as Record<string, unknown>[];
    for (const rs of rss) {
      const res = attrsToObject((rs.resource as { attributes?: KeyValue[] })?.attributes);
      const service = String(res["service.name"] ?? "unknown_service");
      const scopes = (rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) as { spans?: OtlpSpan[] }[];
      for (const sc of scopes) {
        for (const s of sc.spans ?? []) {
          const attrs = { ...attrsToObject(s.attributes) };
          const exc = s.events?.find((e) => e.name === "exception");
          const excAttrs = exc ? attrsToObject(exc.attributes) : {};
          spans.push({
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId || undefined,
            name: s.name,
            kind: spanKind(s.kind),
            service,
            start: nanosToMs(s.startTimeUnixNano),
            end: nanosToMs(s.endTimeUnixNano),
            attrs: { ...attrs, ...prefixed(res, "resource.") },
            status: statusOf(s.status),
            error: s.status?.message || (excAttrs["exception.message"] as string | undefined),
          });
        }
      }
    }
  }
  return spans;
}

function prefixed(o: Record<string, unknown>, p: string) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]));
}

/* ------------------------------------------------------------------ */
/* Spans -> flowgraph                                                  */
/* ------------------------------------------------------------------ */

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));

function jsonish(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

function pick(attrs: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (attrs[k] !== undefined) o[k.split(".").slice(-2).join("_").replace(/^request_|^response_/, "")] = jsonish(attrs[k]);
  return Object.keys(o).length ? o : undefined;
}

const httpMethod = (a: Record<string, unknown>) => str(a["http.request.method"] ?? a["http.method"]);
const httpRoute = (a: Record<string, unknown>) => str(a["http.route"]);
const dbSystem = (a: Record<string, unknown>) => str(a["db.system.name"] ?? a["db.system"]);
const msgSystem = (a: Record<string, unknown>) => str(a["messaging.system"]);
const msgDest = (a: Record<string, unknown>) => str(a["messaging.destination.name"] ?? a["messaging.destination"]);
const dbStatement = (a: Record<string, unknown>) => str(a["db.query.text"] ?? a["db.statement"]);

/** What went into a span: explicit noodles/OpenInference attributes, else protocol-specific request attributes. */
export function spanInput(s: Span): unknown {
  const a = s.attrs;
  for (const k of ["noodles.input", "input.value", "code.input", "rpc.request.body"]) if (a[k] !== undefined) return jsonish(a[k]);
  const body = a["http.request.body"] ?? a["http.request.body.content"];
  if (httpMethod(a)) {
    return compact({
      method: httpMethod(a),
      route: httpRoute(a),
      url: str(a["url.full"] ?? a["http.url"] ?? a["http.target"] ?? a["url.path"]),
      query: str(a["url.query"]),
      body: jsonish(body),
    });
  }
  if (dbSystem(a)) return compact({ statement: dbStatement(a), operation: str(a["db.operation.name"] ?? a["db.operation"]), table: str(a["db.collection.name"] ?? a["db.sql.table"]) });
  if (msgSystem(a)) return compact({ destination: msgDest(a), message: jsonish(a["messaging.message.body"] ?? a["messaging.message.payload"]), key: str(a["messaging.kafka.message.key"]) });
  if (a["rpc.system"]) return compact({ service: str(a["rpc.service"]), method: str(a["rpc.method"]) });
  return pick(a, Object.keys(a).filter((k) => /^(app|arg|param|input)\./.test(k)));
}

/** What came out of a span. */
export function spanOutput(s: Span): unknown {
  const a = s.attrs;
  for (const k of ["noodles.output", "output.value", "code.output", "rpc.response.body"]) if (a[k] !== undefined) return jsonish(a[k]);
  if (s.status === "error" && s.error) return { error: s.error };
  const status = a["http.response.status_code"] ?? a["http.status_code"];
  if (status !== undefined || a["http.response.body"] !== undefined) return compact({ status, body: jsonish(a["http.response.body"]) });
  if (dbSystem(a)) return compact({ rows: a["db.response.returned_rows"] ?? a["db.rows_affected"] ?? a["db.response.rows"] });
  if (msgSystem(a)) return compact({ messageId: str(a["messaging.message.id"]), partition: a["messaging.destination.partition.id"] });
  if (a["rpc.grpc.status_code"] !== undefined) return { status: a["rpc.grpc.status_code"] };
  return pick(a, Object.keys(a).filter((k) => /^(result|output|return)\./.test(k)));
}

function compact(o: Record<string, unknown>) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === "") delete o[k];
  return Object.keys(o).length ? o : undefined;
}

function portsFrom(value: unknown, fallback: string): Port[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 12)
      .map(([k, v]) => ({ name: k, type: Array.isArray(v) ? "array" : v === null ? "null" : typeof v }));
  }
  return [{ name: fallback, type: value === undefined ? undefined : Array.isArray(value) ? "array" : typeof value }].map((p) => (p.type ? p : { name: p.name }));
}

const MAX_SAMPLE_CHARS = 4000;
function sampleValue(v: unknown): { value: unknown; truncated?: boolean } {
  const text = JSON.stringify(v);
  if (text && text.length > MAX_SAMPLE_CHARS) return { value: text.slice(0, MAX_SAMPLE_CHARS) + "…", truncated: true };
  return { value: v };
}

/** Where a span lands on the canvas. Undefined = the span is a hop (a client span whose callee is traced). */
function nodeForSpan(s: Span, hasTracedChild: boolean): FlowNode | undefined {
  const a = s.attrs;
  const svcId = `svc:${s.service}`;
  const isOutgoing = s.kind === "client" || s.kind === "producer";

  if (isOutgoing && hasTracedChild && s.kind === "client") return undefined;

  if (isOutgoing) {
    const db = dbSystem(a);
    if (db) {
      return {
        id: `store:${db}`,
        name: str(a["db.name"] ?? a["db.namespace"]) ? `${db} (${str(a["db.name"] ?? a["db.namespace"])})` : db,
        kind: "datastore",
        layer: "runtime",
        aliases: [`datastore:${db}`],
        inputs: [{ name: "write" }],
        outputs: [{ name: "read" }],
        metadata: { engine: db },
      };
    }
    const ms = msgSystem(a);
    if (ms) {
      const dest = msgDest(a);
      return dest
        ? {
            id: `queue:${ms}:${dest}`,
            name: dest,
            kind: "queue",
            layer: "messaging",
            parent: `queue:${ms}`,
            aliases: [`topic:${dest}`],
            inputs: [{ name: "publish", type: `${ms}:${dest}` }],
            outputs: [{ name: "consume", type: `${ms}:${dest}` }],
            metadata: { system: ms, topic: dest },
          }
        : { id: `queue:${ms}`, name: ms, kind: "queue", layer: "messaging", aliases: [`queue:${ms}`], metadata: { system: ms } };
    }
    const peer = str(a["peer.service"]);
    const url = str(a["url.full"] ?? a["http.url"]);
    const host = str(a["server.address"] ?? a["net.peer.name"] ?? a["http.host"]) ?? (url ? safeHost(url) : undefined) ?? peer;
    if (host || peer) {
      const internal = !!host && !host.includes(".") && host !== "localhost";
      const aliases = [...(peer ? [`service:${peer}`] : []), ...(internal ? [`service:${host}`] : host ? [`host:${host}`] : [])];
      return {
        id: `ext:http:${host ?? peer}`,
        name: host ?? peer!,
        kind: "external_api",
        layer: "network",
        aliases: aliases.length ? [...new Set(aliases)] : undefined,
        inputs: [{ name: "request", type: "http" }],
        outputs: [{ name: "response", type: "http" }],
        metadata: { host },
      };
    }
  }

  // Operation inside a service (server, consumer, internal, or an untargeted client span).
  const fn = str(a["code.function.name"] ?? a["code.function"]);
  const ns = str(a["code.namespace"]);
  const route = httpRoute(a);
  const method = httpMethod(a);
  const aliases: string[] = [];
  if (fn && ns) aliases.push(`py:${ns}.${fn}`);
  if (s.kind === "server" && route) aliases.push(`route:${s.service}:${(method ?? "GET").toUpperCase()} ${normRoute(route)}`);
  const isEndpoint = s.kind === "server" && (route || method);
  return {
    id: `op:${s.service}:${s.name}`,
    name: s.name,
    kind: isEndpoint ? "network_endpoint" : "function",
    layer: isEndpoint ? "network" : "runtime",
    parent: svcId,
    aliases: aliases.length ? aliases : undefined,
    metadata: compactMeta({
      spanKind: s.kind,
      service: s.service,
      "code.function": fn,
      "code.namespace": ns,
      "code.filepath": str(a["code.file.path"] ?? a["code.filepath"]),
      "code.lineno": a["code.line.number"] ?? a["code.lineno"],
      "http.route": route,
      "http.method": method,
    }),
  };
}

function compactMeta(o: Record<string, unknown>) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function edgeShape(s: Span): { kind: EdgeKind; protocol?: string; label?: string; reverse?: boolean } {
  const a = s.attrs;
  const db = dbSystem(a);
  if (db) {
    const stmt = dbStatement(a) ?? "";
    const op = (str(a["db.operation.name"] ?? a["db.operation"]) ?? stmt.split(/\s/)[0] ?? "").toUpperCase();
    const table = str(a["db.collection.name"] ?? a["db.sql.table"]) ?? stmt.match(/\b(?:FROM|INTO|UPDATE)\s+["`]?([\w.]+)/i)?.[1];
    const label = [op, table].filter(Boolean).join(" ") || undefined;
    const isRead = /^(SELECT|GET|FIND|MGET|HGET|HGETALL|SMEMBERS|SCAN|QUERY|COUNT|AGGREGATE)/.test(op);
    const isWrite = /^(INSERT|UPDATE|DELETE|UPSERT|SET|HSET|DEL|SAVE|PUT|MERGE|REPLACE)/.test(op);
    if (isRead) return { kind: "read", protocol: db, label, reverse: true };
    if (isWrite) return { kind: "write", protocol: db, label };
    return { kind: "call", protocol: db, label };
  }
  const ms = msgSystem(a);
  if (ms) {
    const dest = msgDest(a);
    const op = s.kind === "consumer" ? "consume" : "publish";
    return { kind: "event", protocol: ms, label: dest ? `${op} ${dest}` : op };
  }
  if (a["rpc.system"]) return { kind: "call", protocol: str(a["rpc.system"]), label: str(a["rpc.method"]) };
  const method = httpMethod(a);
  if (method) {
    const target = httpRoute(a) ?? str(a["url.path"] ?? a["http.target"]);
    return { kind: "call", protocol: "http", label: [method.toUpperCase(), target].filter(Boolean).join(" ") };
  }
  return { kind: "call" };
}

export interface OtlpInput {
  name: string;
  text: string;
}

/** Convert one or more OTLP JSON documents into a flowgraph with one execution per trace. */
export function importOtlp(inputs: OtlpInput[] | string): FlowGraph {
  const docs = typeof inputs === "string" ? [{ name: "traces", text: inputs }] : inputs;
  const spans = docs.flatMap((d) => parseOtlp(d.text));
  return spansToGraph(spans, docs.map((d) => d.name));
}

export function spansToGraph(spans: Span[], sourceNames: string[] = []): FlowGraph {
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge>();
  const byTrace = new Map<string, Span[]>();
  for (const s of spans) {
    if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, []);
    byTrace.get(s.traceId)!.push(s);
  }

  const addNode = (n: FlowNode) => {
    const cur = nodes.get(n.id);
    if (!cur) {
      nodes.set(n.id, n);
      return;
    }
    if (n.aliases) cur.aliases = [...new Set([...(cur.aliases ?? []), ...n.aliases])];
  };

  const executions: Execution[] = [];
  for (const [traceId, list] of byTrace) {
    list.sort((a, b) => a.start - b.start);
    const byId = new Map(list.map((s) => [s.spanId, s]));
    const childServices = new Map<string, Set<string>>();
    for (const s of list) {
      if (!s.parentSpanId) continue;
      const p = byId.get(s.parentSpanId);
      if (p && (s.kind === "server" || s.kind === "consumer") && s.service !== p.service) {
        if (!childServices.has(p.spanId)) childServices.set(p.spanId, new Set());
        childServices.get(p.spanId)!.add(s.service);
      }
    }

    const nodeOf = new Map<string, string | undefined>(); // spanId -> node id
    for (const s of list) {
      const n = nodeForSpan(s, childServices.has(s.spanId));
      if (!n) {
        nodeOf.set(s.spanId, undefined);
        continue;
      }
      addNode(n);
      if (n.parent?.startsWith("svc:")) {
        addNode({ id: n.parent, name: s.service, kind: "service", layer: "runtime", aliases: [`service:${s.service}`], metadata: { source: "otel" } });
      }
      if (n.parent?.startsWith("queue:")) {
        const system = n.parent.slice("queue:".length);
        addNode({ id: n.parent, name: system, kind: "queue", layer: "messaging", aliases: [`queue:${system}`], metadata: { system } });
      }
      nodeOf.set(s.spanId, n.id);
    }

    // Consumers attach to the topic they read from (parent is usually the producer span).
    const steps: Step[] = [];
    for (const s of list) {
      const nodeId = nodeOf.get(s.spanId);
      // Nearest ancestor that is on the canvas.
      let parent = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
      let hop: Span | undefined;
      while (parent && !nodeOf.get(parent.spanId)) {
        hop ??= parent;
        parent = parent.parentSpanId ? byId.get(parent.parentSpanId) : undefined;
      }
      if (!nodeId) continue;
      const input = spanInput(s) ?? (hop ? spanInput(hop) : undefined);
      const output = spanOutput(s) ?? (hop ? spanOutput(hop) : undefined);

      let viaEdge: string | undefined;
      if (parent) {
        const fromNode = nodeOf.get(parent.spanId)!;
        let shapeSpan = hop ?? s;
        // consumer under a producer: topic -> consumer
        let from = fromNode;
        if (s.kind === "consumer" && parent.kind === "producer") shapeSpan = s;
        const shape = edgeShape(shapeSpan.kind === "server" && hop ? hop : shapeSpan);
        let to = nodeId;
        if (shape.reverse) [from, to] = [to, from];
        if (from !== to || shape.kind === "call") {
          const id = edgeId(shape.kind, { node: from }, { node: to });
          const e = edges.get(id) ?? { id, from: { node: from }, to: { node: to }, kind: shape.kind, count: 0, samples: [] };
          e.count = (e.count ?? 0) + 1;
          if (shape.protocol && !e.protocol) e.protocol = shape.protocol;
          if (shape.label && !e.label) e.label = shape.label;
          if (e.samples!.length < 5) e.samples!.push({ ...sampleValue({ input, output }), observedAt: s.start, execution: `otel:${traceId}` });
          edges.set(id, e);
          viaEdge = id;
        }
      }

      // Ports from what we actually observed.
      const node = nodes.get(nodeId)!;
      if (node.kind === "function" || node.kind === "network_endpoint") {
        if (!node.inputs && input !== undefined) node.inputs = portsFrom(input, "input");
        if (!node.outputs && output !== undefined) node.outputs = portsFrom(output, "output");
      }

      steps.push(
        clean({
          id: s.spanId,
          node: nodeId,
          parent: parent?.spanId,
          via: viaEdge,
          input: input === undefined ? undefined : sampleValue(input).value,
          output: output === undefined ? undefined : sampleValue(output).value,
          start: s.start,
          end: s.end,
          status: s.status,
          error: s.error,
          metadata: { span: s.name, service: s.service, kind: s.kind, durationMs: round(s.end - s.start) },
        }),
      );
    }

    const root = list.find((s) => !s.parentSpanId || !byId.has(s.parentSpanId)) ?? list[0];
    executions.push({
      id: `otel:${traceId}`,
      name: `${root.service}: ${root.name}`,
      start: list[0].start,
      end: Math.max(...list.map((s) => s.end)),
      status: list.some((s) => s.status === "error") ? "error" : "ok",
      steps,
      metadata: { traceId, spans: list.length, services: [...new Set(list.map((s) => s.service))] },
    });
  }

  for (const e of edges.values()) if (!e.samples?.length) delete e.samples;
  executions.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  return {
    version: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sources: [{ collector: "otel", target: sourceNames.join(", ") || undefined, collectedAt: new Date().toISOString() }].map((s) =>
      s.target ? s : { collector: s.collector, collectedAt: s.collectedAt },
    ),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    executions,
  };
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/**
 * Give trace nodes aliases pointing at matching static code nodes, so a merge lands
 * trace steps on real functions. A candidate must have the same function name; among
 * those, the one whose file path shares the most trailing segments with code.filepath
 * wins, and paths containing the span's service name break ties.
 */
export function linkTracesToCode(traces: FlowGraph, base: FlowGraph): FlowGraph {
  const functions = base.nodes.filter((n) => n.kind === "function" && n.source?.file);
  const out = structuredClone(traces);
  const segs = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean);
  for (const n of out.nodes) {
    const m = n.metadata ?? {};
    const fn = m["code.function"] as string | undefined;
    if (!fn) continue;
    const file = (m["code.filepath"] as string | undefined) ?? "";
    const ns = m["code.namespace"] as string | undefined;
    const service = m.service as string | undefined;
    const shortFn = fn.split(".").pop()!;
    const fileSegs = file ? segs(file) : ns ? [...ns.split("."), ""] : [];
    let best: { id: string; score: number }[] = [];
    for (const c of functions) {
      const qual = (c.metadata?.qualifiedName as string | undefined) ?? c.name;
      if (!(qual === fn || qual.endsWith(`.${fn}`) || (c.name === shortFn && !fn.includes(".")))) continue;
      const cSegs = segs(c.source!.file!);
      let common = 0;
      if (file) {
        while (common < fileSegs.length && common < cSegs.length && fileSegs[fileSegs.length - 1 - common] === cSegs[cSegs.length - 1 - common]) common++;
        if (common === 0) continue;
      } else if (ns) {
        const mod = c.source!.file!.replace(/\.\w+$/, "").replace(/\//g, ".");
        if (!mod.endsWith(ns)) continue;
        common = ns.split(".").length;
      }
      const score = common * 10 + (service && cSegs.includes(service) ? 5 : 0) + (qual === fn ? 1 : 0);
      if (!best.length || score > best[0].score) best = [{ id: c.id, score }];
      else if (score === best[0].score) best.push({ id: c.id, score });
    }
    if (best.length === 1) n.aliases = [...new Set([...(n.aliases ?? []), best[0].id])];
  }
  // Static code ports are authoritative: drop ports guessed from payloads for nodes that will merge.
  const known = new Set(base.nodes.flatMap((b) => [b.id, ...(b.aliases ?? [])]));
  for (const n of out.nodes) {
    if ([n.id, ...(n.aliases ?? [])].some((a) => known.has(a))) {
      delete n.inputs;
      delete n.outputs;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Collector                                                           */
/* ------------------------------------------------------------------ */

async function otlpFiles(target: string): Promise<string[]> {
  const st = await fs.stat(target).catch(() => undefined);
  if (!st) return [];
  if (st.isFile()) return [target];
  const entries = await fs.readdir(target);
  return entries.filter((e) => /\.(json|jsonl|ndjson)$/.test(e)).map((e) => path.join(target, e));
}

export const otelCollector: Collector = {
  name: "otel",
  description: "OpenTelemetry traces (OTLP JSON): services, calls and replayable executions",
  implemented: true,
  async detect(target) {
    for (const f of await otlpFiles(target)) {
      const head = (await fs.readFile(f, "utf8")).slice(0, 2000);
      if (head.includes("resourceSpans") || head.includes('"batches"')) return true;
    }
    return false;
  },
  async collect(target) {
    const files = await otlpFiles(target);
    const inputs: OtlpInput[] = [];
    for (const f of files) {
      const text = await fs.readFile(f, "utf8");
      if (text.includes("resourceSpans") || text.includes('"batches"')) inputs.push({ name: f, text });
    }
    return importOtlp(inputs);
  },
};
