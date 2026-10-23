import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync, inflateSync } from "node:zlib";
import { decodeOtlpTraces, parseOtlp, type Span } from "@breadth/collectors";

/**
 * An OTLP/HTTP receiver: point any OpenTelemetry SDK or Collector at it
 * (OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318) and traces flow into the graph live.
 * Accepts protobuf (the SDK default) and JSON, gzip or deflate. Metrics and logs are
 * acknowledged and dropped, so exporters that send every signal do not error.
 *
 * Browsers cannot post here from other sites: both content types need a CORS preflight,
 * which is never answered.
 */

export const OTLP_MAX_BYTES = 32_000_000;

export async function readOtlpRequest(req: IncomingMessage): Promise<Span[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > OTLP_MAX_BYTES) throw new HttpError(413, "payload too large");
    chunks.push(c as Buffer);
  }
  let body = Buffer.concat(chunks);
  const enc = String(req.headers["content-encoding"] ?? "").toLowerCase();
  if (enc === "gzip") body = gunzipSync(body);
  else if (enc === "deflate") body = inflateSync(body);
  else if (enc && enc !== "identity") throw new HttpError(415, `unsupported content-encoding ${enc}`);
  const type = String(req.headers["content-type"] ?? "").toLowerCase();
  if (type.includes("json")) return parseOtlp(body.toString("utf8"));
  if (type.includes("protobuf")) return parseOtlp(JSON.stringify(decodeOtlpTraces(body)));
  throw new HttpError(415, "send application/x-protobuf or application/json");
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Answer an OTLP export request (POST /v1/traces | /v1/metrics | /v1/logs). Returns false for other paths. */
export async function handleOtlp(req: IncomingMessage, res: ServerResponse, onSpans: (spans: Span[]) => void): Promise<boolean> {
  const p = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!/^\/v1\/(traces|metrics|logs)$/.test(p)) return false;
  const proto = String(req.headers["content-type"] ?? "").includes("protobuf");
  const reply = (status: number, message?: string) => {
    res.writeHead(status, { "content-type": proto && status === 200 ? "application/x-protobuf" : "application/json" });
    res.end(status === 200 ? (proto ? "" : "{}") : JSON.stringify({ code: status, message }));
  };
  if (req.method !== "POST") {
    reply(405, "POST only");
    return true;
  }
  try {
    if (p === "/v1/traces") {
      const spans = await readOtlpRequest(req);
      if (spans.length) onSpans(spans);
    } else for await (const _ of req) void _; // drain
    reply(200);
  } catch (err) {
    reply(err instanceof HttpError ? err.status : 400, (err as Error).message);
  }
  return true;
}

/** A standalone receiver on its own port (4318 is the OTLP/HTTP default). */
export async function startOtlpServer(opts: { port: number; host: string; onSpans: (spans: Span[]) => void }): Promise<Server> {
  const server = createServer(async (req, res) => {
    if (!(await handleOtlp(req, res, opts.onSpans))) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "POST OTLP to /v1/traces" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  return server;
}

/** Spans kept in memory: the most recent traces, bounded. */
export class SpanBuffer {
  private traces = new Map<string, Span[]>();
  constructor(private maxTraces = 2000) {}

  add(spans: Span[]) {
    for (const s of spans) {
      const list = this.traces.get(s.traceId);
      if (list) {
        if (!list.some((x) => x.spanId === s.spanId)) list.push(s);
        // keep insertion order = recency
        this.traces.delete(s.traceId);
        this.traces.set(s.traceId, list);
      } else this.traces.set(s.traceId, [s]);
    }
    while (this.traces.size > this.maxTraces) this.traces.delete(this.traces.keys().next().value!);
  }

  get spans(): Span[] {
    return [...this.traces.values()].flat();
  }

  get size(): number {
    return this.traces.size;
  }
}
