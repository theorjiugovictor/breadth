import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import type { Span } from "@breadth/collectors";
import { SpanBuffer, startOtlpServer } from "./otlp.js";

/* A minimal protobuf encoder, enough to build an ExportTraceServiceRequest like an SDK sends. */
const varint = (n: bigint | number): number[] => {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const field = (n: number, wire: number, payload: number[]) => [...varint((n << 3) | wire), ...payload];
const bytes = (n: number, b: number[] | Uint8Array) => field(n, 2, [...varint(b.length), ...b]);
const str = (n: number, s: string) => bytes(n, [...new TextEncoder().encode(s)]);
const u64 = (n: number, v: bigint) => field(n, 1, Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn)));
const kv = (k: string, v: string) => [...str(1, k), ...bytes(2, str(1, v))];
const hexBytes = (h: string) => h.match(/../g)!.map((x) => parseInt(x, 16));

function exportRequest(): Uint8Array {
  const span = (id: string, parent: string | undefined, name: string, kind: number, attrs: [string, string][], start: bigint, end: bigint, error = false) => [
    ...bytes(1, hexBytes("0af7651916cd43dd8448eb211c80319c")),
    ...bytes(2, hexBytes(id)),
    ...(parent ? bytes(4, hexBytes(parent)) : []),
    ...str(5, name),
    ...field(6, 0, varint(kind)),
    ...u64(7, start),
    ...u64(8, end),
    ...attrs.flatMap(([k, v]) => bytes(9, kv(k, v))),
    ...(error ? bytes(15, [...str(2, "boom"), ...field(3, 0, varint(2))]) : []),
  ];
  const t0 = 1_700_000_000_000_000_000n;
  const resource = bytes(1, bytes(1, kv("service.name", "checkout")));
  const scope = bytes(2, [
    ...bytes(2, span("b7ad6b7169203331", undefined, "POST /checkout", 2, [["http.request.method", "POST"], ["http.route", "/checkout"]], t0, t0 + 40_000_000n)),
    ...bytes(2, span("00f067aa0ba902b7", "b7ad6b7169203331", "SET", 3, [["db.system", "redis"]], t0 + 5_000_000n, t0 + 9_000_000n, true)),
  ]);
  return new Uint8Array(bytes(1, [...resource, ...scope]));
}

describe("OTLP receiver", async () => {
  const got: Span[][] = [];
  const server = await startOtlpServer({ port: 0, host: "127.0.0.1", onSpans: (s) => got.push(s) });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => server.close());

  it("decodes gzipped protobuf, the SDK default", async () => {
    const res = await fetch(`${base}/v1/traces`, { method: "POST", headers: { "content-type": "application/x-protobuf", "content-encoding": "gzip" }, body: gzipSync(exportRequest()) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    const [root, db] = got.pop()!;
    expect(root).toMatchObject({ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", name: "POST /checkout", kind: "server", service: "checkout", status: "unset" });
    expect(root.attrs["http.route"]).toBe("/checkout");
    expect(root.end - root.start).toBe(40);
    expect(db).toMatchObject({ parentSpanId: "b7ad6b7169203331", kind: "client", status: "error", error: "boom" });
  });

  it("accepts JSON, acknowledges metrics and logs, rejects what it cannot read", async () => {
    const json = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "api" } }] }, scopeSpans: [{ spans: [{ traceId: "aa", spanId: "bb", name: "GET /x", kind: 2, startTimeUnixNano: "1000000", endTimeUnixNano: "3000000" }] }] }] };
    expect((await fetch(`${base}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) })).status).toBe(200);
    expect(got.pop()![0]).toMatchObject({ service: "api", name: "GET /x" });
    expect((await fetch(`${base}/v1/metrics`, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: new Uint8Array([1]) })).status).toBe(200);
    expect((await fetch(`${base}/v1/traces`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status).toBe(415);
    expect((await fetch(`${base}/v1/traces`)).status).toBe(405);
  });

  it("keeps the most recent traces", () => {
    const b = new SpanBuffer(2);
    const s = (t: string, id: string) => ({ traceId: t, spanId: id }) as Span;
    b.add([s("t1", "a"), s("t2", "a"), s("t1", "b"), s("t3", "a"), s("t3", "a")]);
    expect(b.size).toBe(2);
    expect(b.spans.map((x) => `${x.traceId}/${x.spanId}`)).toEqual(["t1/a", "t1/b", "t3/a"]);
  });
});
