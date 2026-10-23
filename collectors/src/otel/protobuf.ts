// Decodes OTLP ExportTraceServiceRequest protobuf (what OTel SDKs and the Collector send to
// /v1/traces by default) into the same object shape as OTLP JSON, so parseOtlp reads both.
// Hand-written for the handful of messages involved: no protobuf dependency. Browser-safe.

type Fields = Map<number, unknown[]>;

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error("truncated varint");
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 70n) throw new Error("varint too long");
    }
  }

  fixed64(): bigint {
    if (this.pos + 8 > this.buf.length) throw new Error("truncated fixed64");
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.buf[this.pos + i]);
    this.pos += 8;
    return v;
  }

  bytes(): Uint8Array {
    const len = Number(this.varint());
    if (this.pos + len > this.buf.length) throw new Error("truncated field");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  /** All fields of a message: field number -> raw values (bigint for varint/fixed, Uint8Array for length-delimited). */
  fields(): Fields {
    const out: Fields = new Map();
    while (this.pos < this.buf.length) {
      const key = Number(this.varint());
      const field = key >>> 3;
      const wire = key & 7;
      let v: unknown;
      if (wire === 0) v = this.varint();
      else if (wire === 1) v = this.fixed64();
      else if (wire === 2) v = this.bytes();
      else if (wire === 5) {
        v = BigInt(this.buf[this.pos] | (this.buf[this.pos + 1] << 8) | (this.buf[this.pos + 2] << 16) | (this.buf[this.pos + 3] << 24));
        this.pos += 4;
      } else throw new Error(`unsupported wire type ${wire}`);
      if (!out.has(field)) out.set(field, []);
      out.get(field)!.push(v);
    }
    return out;
  }
}

const utf8 = new TextDecoder();
const msg = (b: unknown) => new Reader(b as Uint8Array).fields();
const all = (f: Fields, n: number) => (f.get(n) ?? []) as unknown[];
const one = (f: Fields, n: number) => f.get(n)?.[f.get(n)!.length - 1];
const str = (f: Fields, n: number) => (one(f, n) instanceof Uint8Array ? utf8.decode(one(f, n) as Uint8Array) : undefined);
const hex = (b: unknown) => (b instanceof Uint8Array ? [...b].map((x) => x.toString(16).padStart(2, "0")).join("") : undefined);
const signed64 = (v: bigint) => (v >= 1n << 63n ? v - (1n << 64n) : v);

function anyValue(b: Uint8Array): Record<string, unknown> {
  const f = msg(b);
  if (f.has(1)) return { stringValue: str(f, 1) };
  if (f.has(2)) return { boolValue: one(f, 2) === 1n };
  if (f.has(3)) return { intValue: signed64(one(f, 3) as bigint).toString() };
  if (f.has(4)) {
    const bits = one(f, 4) as bigint;
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, bits, true);
    return { doubleValue: view.getFloat64(0, true) };
  }
  if (f.has(5)) return { arrayValue: { values: all(msg(one(f, 5)), 1).map((x) => anyValue(x as Uint8Array)) } };
  if (f.has(6)) return { kvlistValue: { values: all(msg(one(f, 6)), 1).map((x) => keyValue(x as Uint8Array)) } };
  if (f.has(7)) return { bytesValue: hex(one(f, 7)) };
  return {};
}

function keyValue(b: Uint8Array) {
  const f = msg(b);
  return { key: str(f, 1) ?? "", value: f.has(2) ? anyValue(one(f, 2) as Uint8Array) : undefined };
}

function span(b: Uint8Array) {
  const f = msg(b);
  const status = f.has(15) ? msg(one(f, 15)) : undefined;
  return {
    traceId: hex(one(f, 1)) ?? "",
    spanId: hex(one(f, 2)) ?? "",
    parentSpanId: hex(one(f, 4)) || undefined,
    name: str(f, 5) ?? "",
    kind: Number((one(f, 6) as bigint | undefined) ?? 0n),
    startTimeUnixNano: ((one(f, 7) as bigint | undefined) ?? 0n).toString(),
    endTimeUnixNano: ((one(f, 8) as bigint | undefined) ?? 0n).toString(),
    attributes: all(f, 9).map((x) => keyValue(x as Uint8Array)),
    events: all(f, 11).map((x) => {
      const e = msg(x);
      return { name: str(e, 2) ?? "", timeUnixNano: ((one(e, 1) as bigint | undefined) ?? 0n).toString(), attributes: all(e, 3).map((y) => keyValue(y as Uint8Array)) };
    }),
    status: status ? { code: Number((one(status, 3) as bigint | undefined) ?? 0n), message: str(status, 2) } : undefined,
  };
}

/** ExportTraceServiceRequest (protobuf) -> { resourceSpans: [...] } in OTLP JSON shape. */
export function decodeOtlpTraces(buf: Uint8Array): { resourceSpans: unknown[] } {
  const req = msg(buf);
  return {
    resourceSpans: all(req, 1).map((rsb) => {
      const rs = msg(rsb);
      const resource = rs.has(1) ? msg(one(rs, 1)) : undefined;
      return {
        resource: { attributes: resource ? all(resource, 1).map((x) => keyValue(x as Uint8Array)) : [] },
        scopeSpans: all(rs, 2).map((ssb) => ({ spans: all(msg(ssb), 2).map((x) => span(x as Uint8Array)) })),
      };
    }),
  };
}
