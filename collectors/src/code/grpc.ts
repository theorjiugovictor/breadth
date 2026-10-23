import type { CallSite, FileModel } from "./model.js";

/**
 * gRPC between services: the methods a .proto declares, the classes and types that serve them,
 * and the stubs that call them. Both sides meet on one endpoint node per method
 * (grpc:<package>.<Service>/<Method>), so a call from one service reaches the handler in another.
 *
 *   server  Go       type server struct{ pb.UnimplementedCartServiceServer } + func (s *server) AddItem
 *           Python   class CartService(demo_pb2_grpc.CartServiceServicer): def AddItem
 *           Java     class CartImpl extends CartServiceGrpc.CartServiceImplBase { addItem(...) }
 *           Node     server.addService(proto.CartService.service, { addItem: handler })
 *   client  Go       pb.NewCartServiceClient(conn) ... .AddItem(ctx, req)
 *           Python   demo_pb2_grpc.CartServiceStub(channel) ... .AddItem(req)
 *           Java     CartServiceGrpc.newBlockingStub(channel) ... .addItem(req)
 *           Node     new proto.CartService(addr, creds) ... .addItem(req, cb)
 */

export interface ProtoService {
  /** package-qualified: hipstershop.CartService */
  full: string;
  name: string;
  methods: { name: string; line: number; streaming?: "client" | "server" | "bidi" }[];
  file: string;
}

/** Services and rpcs in a .proto file. */
export function parseProto(file: string, text: string): ProtoService[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/\/\/[^\n]*/g, "");
  const pkg = src.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
  const out: ProtoService[] = [];
  for (const m of src.matchAll(/\bservice\s+(\w+)\s*\{/g)) {
    // the service body, braces balanced (rpcs may have { option ... } bodies)
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < src.length && depth; i++) depth += src[i] === "{" ? 1 : src[i] === "}" ? -1 : 0;
    const body = src.slice(start, i - 1);
    const base = src.slice(0, start).split("\n").length;
    const methods = [...body.matchAll(/\brpc\s+(\w+)\s*\(\s*(stream\s+)?[\w.]+\s*\)\s*returns\s*\(\s*(stream\s+)?[\w.]+\s*\)/g)].map((r) => ({
      name: r[1],
      line: base + body.slice(0, r.index).split("\n").length - 1,
      streaming: r[2] && r[3] ? ("bidi" as const) : r[2] ? ("client" as const) : r[3] ? ("server" as const) : undefined,
    }));
    out.push({ full: pkg ? `${pkg}.${m[1]}` : m[1], name: m[1], methods, file });
  }
  return out;
}

export interface GrpcLinks {
  services: Map<string, ProtoService>;
  /** endpoint id -> the def that serves it */
  servers: { endpoint: string; file: string; qual: string; line: number }[];
  /** calls through a stub */
  clients: { endpoint: string; file: FileModel; site: CallSite }[];
}

export const grpcId = (full: string, method: string) => `grpc:${full}/${method}`;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function grpcLinks(files: FileModel[], protos: ProtoService[]): GrpcLinks {
  // Services by short name; the same .proto is often copied into every service, so merge them.
  const services = new Map<string, ProtoService>();
  for (const p of protos) {
    const prev = services.get(p.name);
    if (!prev) services.set(p.name, { ...p, methods: [...p.methods] });
    else for (const m of p.methods) if (!prev.methods.some((x) => x.name === m.name)) prev.methods.push(m);
  }
  // Health checks and reflection are served by everything; they say nothing about the architecture.
  for (const [k, v] of services) if (/^grpc\.(health|reflection)\./.test(v.full)) services.delete(k);
  const fromCode = !protos.length;
  const service = (name: string): ProtoService | undefined => {
    if (services.has(name)) return services.get(name);
    if (!fromCode || /^(Health|ServerReflection)$/.test(name)) return undefined;
    // No .proto in the repository: learn the service from the generated names the code uses.
    const s: ProtoService = { full: name, name, methods: [], file: "" };
    services.set(name, s);
    return s;
  };
  const method = (s: ProtoService, name: string, learn: boolean) => {
    const m = s.methods.find((x) => x.name === name || lowerFirst(x.name) === name);
    if (m || !learn || !fromCode || !/^[A-Za-z]\w*$/.test(name)) return m;
    const added = { name: name.charAt(0).toUpperCase() + name.slice(1), line: 0 };
    s.methods.push(added);
    return added;
  };

  const servers: GrpcLinks["servers"] = [];
  const baseService = (f: FileModel, cls: string): ProtoService | undefined => {
    const d = f.defs.find((x) => x.qual === cls);
    for (const b of d?.bases ?? []) {
      const name = b.split(".").pop()!.match(/^(\w+)Servicer$/)?.[1] ?? b.match(/(\w+)Grpc\.(\w+)ImplBase$/)?.[2];
      if (name && services.has(name)) return services.get(name);
    }
    return undefined;
  };
  const serve = (s: ProtoService, f: FileModel, cls: string, learn: boolean) => {
    for (const d of f.defs) {
      if (d.parentQual !== cls && !d.qual.startsWith(`${cls}.`)) continue;
      if (d.type === "class") continue;
      const m = method(s, d.name, learn && /^[A-Z]/.test(d.name));
      if (m) servers.push({ endpoint: grpcId(s.full, m.name), file: f.path, qual: d.qual, line: d.line });
    }
  };

  // Servers: generated base classes and embedded Unimplemented servers.
  const goServers = new Map<string, { s: ProtoService; dir: string; type: string }>();
  for (const f of files) {
    for (const d of f.defs) {
      if (d.type !== "class") continue;
      for (const b of d.bases ?? []) {
        const last = b.replace(/<.*$/, "").split(".").pop()!;
        const py = f.lang === "python" ? last.match(/^(\w+)Servicer$/) : undefined;
        const java = f.lang === "java" ? b.match(/(\w+)Grpc\.(\w+)ImplBase$/) : undefined;
        const go = f.lang === "go" ? last.match(/^Unimplemented(\w+)Server$/) : undefined;
        const name = py?.[1] ?? java?.[2] ?? go?.[1];
        const s = name ? service(name) : undefined;
        if (!s) continue;
        if (go) goServers.set(`${dirOf(f.path)}:${d.qual}`, { s, dir: dirOf(f.path), type: d.qual });
        else serve(s, f, d.qual, true);
      }
    }
    // class EmailService(BaseEmailService) where BaseEmailService is the servicer
    for (const d of f.defs) {
      for (const b of d.bases ?? []) {
        const base = f.defs.find((x) => x.type === "class" && x.name === b);
        const s = base && baseService(f, base.qual);
        if (s) serve(s, f, d.qual, false);
      }
    }
  }
  // Go methods are declared apart from the struct, anywhere in its package (directory).
  // pb.RegisterXServer(srv, svc) marks a server even without the embedded struct: any method in
  // that package named after one of X's rpcs serves it.
  for (const { s, dir, type } of goServers.values()) for (const f of files) if (f.lang === "go" && dirOf(f.path) === dir) serve(s, f, type, true);
  for (const f of files) {
    if (f.lang !== "go") continue;
    for (const c of f.calls) {
      const reg = c.parts[c.parts.length - 1].match(/^Register(\w+)Server$/);
      const s = reg ? service(reg[1]) : undefined;
      if (!s) continue;
      for (const g of files) {
        if (g.lang !== "go" || dirOf(g.path) !== dirOf(f.path)) continue;
        for (const d of g.defs) {
          const m = d.type !== "class" && d.qual.includes(".") ? s.methods.find((x) => x.name === d.name) : undefined;
          if (m) servers.push({ endpoint: grpcId(s.full, m.name), file: g.path, qual: d.qual, line: d.line });
        }
      }
    }
  }
  // Node: server.addService(proto.X.service, impl): handlers are the file's functions named after the rpcs.
  for (const f of files) {
    if (!["typescript", "tsx", "javascript"].includes(f.lang)) continue;
    for (const c of f.calls) {
      if (c.parts[c.parts.length - 1] !== "addService") continue;
      const name = (c.argNames ?? []).map((a) => a.match(/(\w+)\.service$/)?.[1]).find(Boolean);
      const s = name ? service(name) : undefined;
      if (!s) continue;
      for (const d of f.defs) {
        // { charge: chargeHandler } is not visible here: match handlers by name (charge, Charge, ChargeServiceHandler)
        const m = d.type !== "class" ? s.methods.find((x) => new RegExp(`^${x.name}(Service)?(Handler|Impl)?$`, "i").test(d.name)) : undefined;
        if (m) servers.push({ endpoint: grpcId(s.full, m.name), file: f.path, qual: d.qual, line: d.line });
      }
    }
  }

  // Clients: a file that makes a stub for a service calls its rpcs by name.
  const clients: GrpcLinks["clients"] = [];
  for (const f of files) {
    const stubs = new Set<ProtoService>();
    for (const c of f.calls) {
      const last = c.parts[c.parts.length - 1];
      const name =
        last.match(/^New(\w+)Client$/)?.[1] ?? // Go
        last.match(/^(\w+)Stub$/)?.[1] ?? // Python
        (/^new(Blocking|Future)?Stub$/.test(last) ? c.parts[c.parts.length - 2]?.match(/^(\w+)Grpc$/)?.[1] : undefined) ?? // Java
        (c.isNew && f.lang !== "java" && f.lang !== "python" && c.parts.length > 1 ? last : undefined); // Node: new proto.X(addr, creds)
      const s = name ? (c.isNew && !/Stub$|Client$/.test(last) ? services.get(name) : service(name)) : undefined;
      if (s) stubs.add(s);
    }
    if (!stubs.size) continue;
    for (const c of f.calls) {
      if (c.parts.length < 2 || c.isNew || /^(self|this)$/.test(c.parts[0])) continue;
      const last = c.parts[c.parts.length - 1];
      for (const s of stubs) {
        const m = s.methods.find((x) => x.name === last || (f.lang !== "go" && f.lang !== "python" && lowerFirst(x.name) === last));
        if (m) {
          clients.push({ endpoint: grpcId(s.full, m.name), file: f, site: c });
          break;
        }
      }
    }
  }
  return { services, servers, clients };
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
