import path from "node:path";
import { edgeId, SCHEMA_VERSION, type EdgeKind, type FlowEdge, type FlowGraph, type FlowNode, type Port } from "@noodles/schema";
import type { CallSite, Def, FileModel, ImportBinding } from "./model.js";
import {
  classifyPackage,
  CONSUME_METHODS,
  dbAccessMode,
  HTTP_VERBS,
  packageName,
  PRODUCE_METHODS,
  sqlLabel,
  type PackageClass,
} from "./known.js";

/** Files that mark a directory as a deployable unit (a service). */
export const SERVICE_MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Pipfile",
  "Dockerfile",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
]);

export interface BuildInput {
  rootName: string;
  files: FileModel[];
  /** All non-code files that were seen, used for service detection. */
  otherFiles: string[];
  includeExternal?: boolean;
}

type Target =
  | { kind: "def"; file: string; qual: string }
  | { kind: "module"; file: string }
  | { kind: "global"; file: string; name: string }
  | { kind: "external"; pkg: string; cls: PackageClass; member?: string; lang: FileModel["lang"] };

const ids = {
  system: (name: string) => `code:repo:${name}`,
  dir: (p: string) => `code:dir:${p}`,
  file: (p: string) => `code:file:${p}`,
  def: (p: string, qual: string) => `code:fn:${p}#${qual}`,
  global: (p: string, name: string) => `code:global:${p}#${name}`,
  pkg: (name: string) => `code:pkg:${name}`,
  externalGroup: "code:external",
  http: (host: string) => `ext:http:${host}`,
  store: (engine: string) => `store:${engine}`,
  queue: (system: string) => `queue:${system}`,
  topic: (system: string, topic: string) => `queue:${system}:${topic}`,
};

/** Common method names: never guess a call target from these alone. */
const AMBIGUOUS_METHODS = new Set(
  "get set run add update delete remove save load init start stop close open read write send call apply map filter reduce find push pop then catch next render handle process execute query create build parse format validate log debug info warn error emit on off".split(
    " ",
  ),
);

export function buildGraph(input: BuildInput): FlowGraph {
  const { rootName, files } = input;
  const includeExternal = input.includeExternal ?? true;
  const nodes = new Map<string, FlowNode>();
  const edges = new Map<string, FlowEdge & { _lines?: number[]; _uncond?: boolean; _unguarded?: boolean }>();
  const byPath = new Map(files.map((f) => [f.path, f]));
  const defIndex = new Map<string, Map<string, Def>>(files.map((f) => [f.path, new Map(f.defs.map((d) => [d.qual, d]))]));
  const globalIndex = new Map(files.map((f) => [f.path, new Set(f.globals.map((g) => g.name))]));

  const addNode = (n: FlowNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return nodes.get(n.id)!;
  };

  // ---------- hierarchy: system > (service|module dirs) > file > class > function ----------
  const systemId = ids.system(rootName);
  addNode({ id: systemId, name: rootName, kind: "system", layer: "code", description: `Source tree of ${rootName}`, metadata: { files: files.length } });

  const manifestDirs = new Set<string>();
  for (const f of input.otherFiles) {
    if (SERVICE_MANIFESTS.has(path.posix.basename(f))) manifestDirs.add(path.posix.dirname(f));
  }

  const { parents: dirParent, collapsed } = buildDirTree(files.map((f) => f.path));
  // dirParent maps a visible dir (after chain collapsing) to its parent visible dir ('' = root).
  for (const [dir, parentDir] of dirParent) {
    // A collapsed chain (schema > src shown as "schema/src") is a service if any dir in it has a manifest.
    const manifestDir = [dir, ...(collapsed.get(dir) ?? [])].find((d) => manifestDirs.has(d));
    const isService = !!manifestDir;
    const name = parentDir ? dir.slice(parentDir.length + 1) : dir;
    const base = path.posix.basename(manifestDir ?? dir);
    addNode({
      id: ids.dir(dir),
      // services are named after their manifest dir ("gateway"), plain dirs after their path ("lib/utils/")
      name: isService ? base : name + "/",
      kind: isService ? "service" : "module",
      layer: "code",
      parent: parentDir ? ids.dir(parentDir) : systemId,
      aliases: isService ? [`service:${base}`] : undefined,
      source: { file: dir },
      metadata: { path: dir, ...(isService ? { manifest: true } : {}) },
    });
  }
  const dirOfFile = (p: string): string | undefined => {
    let d = path.posix.dirname(p);
    while (d !== "." && d !== "" && !dirParent.has(d)) d = path.posix.dirname(d);
    return d === "." || d === "" ? undefined : d;
  };

  for (const f of files) {
    const dir = dirOfFile(f.path);
    addNode({
      id: ids.file(f.path),
      name: path.posix.basename(f.path),
      description: f.doc,
      kind: "module",
      layer: "code",
      parent: dir ? ids.dir(dir) : systemId,
      source: { file: f.path, line: 1, endLine: f.lines },
      metadata: { language: f.lang, lines: f.lines, subkind: "file" },
    });
    for (const d of f.defs) {
      addNode(defNode(f, d));
    }
  }

  // ---------- resolution ----------
  const pyModules = new Map<string, string>(); // dotted module -> path
  for (const f of files) {
    if (f.lang !== "python") continue;
    pyModules.set(pyModuleName(f.path), f.path);
  }
  const pySuffixCache = new Map<string, string | undefined>();
  const findPyModule = (mod: string, fromFile: string): string | undefined => {
    if (pyModules.has(mod)) return pyModules.get(mod);
    const key = `${mod}|${path.posix.dirname(fromFile)}`;
    if (pySuffixCache.has(key)) return pySuffixCache.get(key);
    const matches = [...pyModules.keys()].filter((m) => m.endsWith(`.${mod}`));
    let found: string | undefined;
    if (matches.length === 1) found = pyModules.get(matches[0]);
    else if (matches.length > 1) {
      // Prefer the candidate that shares the longest directory prefix with the importer.
      found = matches
        .map((m) => pyModules.get(m)!)
        .sort((a, b) => commonPrefix(b, fromFile) - commonPrefix(a, fromFile) || a.length - b.length)[0];
    }
    pySuffixCache.set(key, found);
    return found;
  };

  const resolveModule = (from: FileModel, spec: string): { file: string } | { external: string } | undefined => {
    if (from.lang === "python") {
      if (spec.startsWith(".")) {
        const level = spec.match(/^\.+/)![0].length;
        const rest = spec.slice(level);
        let base = path.posix.dirname(from.path);
        for (let i = 1; i < level; i++) base = path.posix.dirname(base);
        const parts = base === "." ? [] : base.split("/");
        const mod = [...parts, ...(rest ? rest.split(".") : [])].join(".");
        const p = pyModules.get(mod) ?? findPyModule(mod, from.path);
        return p ? { file: p } : undefined;
      }
      const p = findPyModule(spec, from.path);
      return p ? { file: p } : { external: packageName(spec, "python") };
    }
    // JS / TS
    if (spec.startsWith(".") || spec.startsWith("/")) {
      const p = resolveJsPath(path.posix.join(path.posix.dirname(from.path), spec), byPath);
      return p ? { file: p } : undefined;
    }
    for (const alias of ["@/", "~/", "src/"]) {
      if (spec.startsWith(alias)) {
        const rest = spec.slice(alias.length);
        for (const base of ["src/", "", "app/"]) {
          const p = resolveJsPath(base + rest, byPath);
          if (p) return { file: p };
        }
      }
    }
    return { external: packageName(spec, from.lang) };
  };

  const resolveBinding = (from: FileModel, b: ImportBinding, depth: number): Target | undefined => {
    const mod = resolveModule(from, b.module);
    if (!mod) return undefined;
    if ("external" in mod) {
      return { kind: "external", pkg: mod.external, cls: classifyPackage(mod.external, from.lang), member: b.imported === "*" || b.imported === "default" ? undefined : b.imported, lang: from.lang };
    }
    if (b.imported === "*") return { kind: "module", file: mod.file };
    const target = byPath.get(mod.file)!;
    if (b.imported === "default") {
      const defs = target.defs.filter((d) => !d.parentQual);
      const named = defs.find((d) => d.name === b.local) ?? (defs.length === 1 ? defs[0] : undefined);
      return named ? { kind: "def", file: target.path, qual: named.qual } : { kind: "module", file: target.path };
    }
    const r = resolveName(target, b.imported, depth + 1);
    if (r) return r;
    // `from pkg import submodule`
    if (from.lang === "python") {
      const sub = resolveModule(from, b.module.endsWith(".") ? b.module + b.imported : `${b.module}.${b.imported}`);
      if (sub && "file" in sub) return { kind: "module", file: sub.file };
    }
    return undefined;
  };

  const resolveName = (file: FileModel, name: string, depth = 0): Target | undefined => {
    if (depth > 6) return undefined;
    if (defIndex.get(file.path)!.has(name)) return { kind: "def", file: file.path, qual: name };
    if (globalIndex.get(file.path)!.has(name)) return { kind: "global", file: file.path, name };
    // Last binding wins, like the language does.
    const bindings = file.imports.filter((b) => b.local === name);
    const b = bindings[bindings.length - 1];
    if (b) return resolveBinding(file, b, depth);
    for (const w of file.imports.filter((i) => i.local === "*")) {
      const mod = resolveModule(file, w.module);
      if (mod && "file" in mod) {
        const r = resolveName(byPath.get(mod.file)!, name, depth + 1);
        if (r) return r;
      }
    }
    return undefined;
  };

  /** Look up `name` from inside def `scope` (nested defs first, then the file). */
  const resolveInScope = (file: FileModel, scope: string, name: string): Target | undefined => {
    const defs = defIndex.get(file.path)!;
    let s = scope;
    while (s) {
      const d = defs.get(s);
      // Inside a class body, sibling methods are not in scope by bare name.
      if (d && d.type !== "class" && defs.has(`${s}.${name}`)) return { kind: "def", file: file.path, qual: `${s}.${name}` };
      s = s.includes(".") ? s.slice(0, s.lastIndexOf(".")) : "";
    }
    return resolveName(file, name);
  };

  const enclosingClass = (file: FileModel, qual: string): string | undefined => {
    const defs = defIndex.get(file.path)!;
    let s = qual;
    while (s) {
      if (defs.get(s)?.type === "class") return s;
      s = s.includes(".") ? s.slice(0, s.lastIndexOf(".")) : "";
    }
    return undefined;
  };

  const findMethod = (file: string, cls: string, method: string, depth = 0): Target | undefined => {
    const defs = defIndex.get(file)!;
    if (defs.has(`${cls}.${method}`)) return { kind: "def", file, qual: `${cls}.${method}` };
    if (depth > 4) return undefined;
    for (const base of defs.get(cls)?.bases ?? []) {
      const t = resolveName(byPath.get(file)!, base.split("[")[0].split("<")[0]);
      if (t?.kind === "def" && defIndex.get(t.file)!.get(t.qual)?.type === "class") {
        const r = findMethod(t.file, t.qual, method, depth + 1);
        if (r) return r;
      }
    }
    return undefined;
  };

  const attrTypeOf = (file: string, cls: string, attr: string, depth = 0): { file: string; scope: string; type: string[] } | undefined => {
    const f = byPath.get(file)!;
    const t = f.attrTypes[`${cls}.${attr}`];
    if (t) return { file, scope: cls, type: t };
    if (depth > 4) return undefined;
    for (const base of defIndex.get(file)!.get(cls)?.bases ?? []) {
      const b = resolveName(f, base.split("[")[0].split("<")[0]);
      if (b?.kind === "def") {
        const r = attrTypeOf(b.file, b.qual, attr, depth + 1);
        if (r) return r;
      }
    }
    return undefined;
  };

  // Unique method names across the project, for `obj.method()` calls with unknown receivers.
  const methodsByName = new Map<string, Target[]>();
  for (const f of files) {
    for (const d of f.defs) {
      if (d.type !== "method" || d.name.startsWith("__") || d.name.length < 4 || AMBIGUOUS_METHODS.has(d.name)) continue;
      const list = methodsByName.get(d.name) ?? [];
      list.push({ kind: "def", file: f.path, qual: d.qual });
      methodsByName.set(d.name, list);
    }
  }

  /** Resolve a type (callee parts like ['models','User']) seen from a scope, then call `member` on it. */
  const callOnType = (file: FileModel, scope: string, type: string[], member: string[]): { target: Target } | undefined => {
    const t = resolveInScope(file, scope, type[0]);
    if (!t) return undefined;
    const cls = descend(t, type.slice(1));
    if (!cls) return undefined;
    if (cls.target.kind === "external") return descend(cls.target, member);
    if (cls.target.kind === "def" && defIndex.get(cls.target.file)!.get(cls.target.qual)?.type === "class") {
      const m = findMethod(cls.target.file, cls.target.qual, member[0]);
      return m ? { target: m } : undefined;
    }
    return undefined;
  };

  const resolveCall = (file: FileModel, c: CallSite): { target: Target; inferred?: boolean } | undefined => {
    const [head, ...rest] = c.parts;
    if ((head === "self" || head === "this" || head === "cls") && rest.length >= 1) {
      const cls = enclosingClass(file, c.from);
      if (!cls) return undefined;
      if (rest.length === 1) {
        const t = findMethod(file.path, cls, rest[0]);
        return t ? { target: t } : undefined;
      }
      // self.repo.find(): use the attribute's known type
      const attrType = attrTypeOf(file.path, cls, rest[0]);
      if (attrType) return callOnType(byPath.get(attrType.file)!, attrType.scope, attrType.type, rest.slice(1));
      return undefined;
    }
    if (c.receiver && rest.length >= 1) {
      const r = callOnType(file, c.from, c.receiver, rest);
      if (r) return r;
    }
    if (rest.length === 0) {
      const t = resolveInScope(file, c.from, head);
      return t ? { target: t } : undefined;
    }
    // Dotted python imports: `import a.b` then a.b.f()
    for (let k = c.parts.length - 1; k >= 1; k--) {
      const local = c.parts.slice(0, k).join(".");
      const t = k === 1 ? resolveInScope(file, c.from, local) : file.imports.some((b) => b.local === local) ? resolveName(file, local) : undefined;
      if (!t) continue;
      const member = c.parts.slice(k);
      return descend(t, member);
    }
    // Unknown receiver: guess by unique method name.
    const last = c.parts[c.parts.length - 1];
    const candidates = methodsByName.get(last);
    if (candidates?.length === 1) return { target: candidates[0], inferred: true };
    return undefined;
  };

  /**
   * A module-level object created by a call stands for what created it:
   * producer = KafkaProducer(...) -> the kafka package; orders = new OrdersClient() -> that class.
   */
  const clientOf = (t: Target & { kind: "global" }, depth = 0): Target | undefined => {
    const f = byPath.get(t.file)!;
    const g = f.globals.find((x) => x.name === t.name);
    if (!g?.init || depth > 3) return undefined;
    const head = resolveName(f, g.init[0]);
    if (!head) return undefined;
    if (head.kind === "global") return clientOf(head, depth + 1);
    const r = descend(head, g.init.slice(1));
    if (r?.target.kind === "external") return { ...r.target, member: undefined };
    if (r?.target.kind === "def" && defIndex.get(r.target.file)!.get(r.target.qual)?.type === "class") return r.target;
    return undefined;
  };

  const descend = (t: Target, member: string[]): { target: Target } | undefined => {
    if (member.length === 0) return { target: t };
    if (t.kind === "external") return { target: { ...t, member: [t.member, ...member].filter(Boolean).join(".") } };
    if (t.kind === "global") {
      const client = clientOf(t);
      if (client?.kind === "def") {
        const m = findMethod(client.file, client.qual, member[0]);
        return m ? { target: m } : undefined;
      }
      return client ? descend(client, member) : { target: t };
    }
    if (t.kind === "module") {
      const r = resolveName(byPath.get(t.file)!, member[0]);
      return r ? descend(r, member.slice(1)) : undefined;
    }
    // def: class methods (Class.method) or static access
    const d = defIndex.get(t.file)!.get(t.qual);
    if (d?.type === "class") {
      const m = findMethod(t.file, t.qual, member[0]);
      return m ? { target: m } : { target: t };
    }
    return undefined;
  };

  // ---------- edges ----------
  const fromNodeId = (f: FileModel, qual: string) => (qual ? ids.def(f.path, qual) : ids.file(f.path));

  const addEdge = (
    kind: EdgeKind,
    from: string,
    to: string,
    site: { line: number; inLoop?: boolean; conditional?: boolean; guarded?: boolean; file: string },
    extra: Partial<FlowEdge> = {},
  ) => {
    const id = edgeId(kind, { node: from }, { node: to });
    let e = edges.get(id);
    if (!e) {
      e = { id, from: { node: from }, to: { node: to }, kind, count: 0, _lines: [], _uncond: false, _unguarded: false, ...extra };
      edges.set(id, e);
    }
    if (!site.guarded) e._unguarded = true;
    e.count = (e.count ?? 0) + 1;
    if (site.inLoop) e.loop = true;
    if (!site.conditional) e._uncond = true;
    if (e._lines!.length < 10) e._lines!.push(site.line);
    if (extra.label && e.label && !e.label.split(", ").includes(extra.label)) {
      const labels = e.label.split(", ");
      if (labels.length < 3) e.label = [...labels, extra.label].join(", ");
      else if (!e.label.endsWith("…")) e.label += ", …";
    }
    if (!e.metadata) e.metadata = { file: site.file };
  };

  const externalGroup = () =>
    addNode({ id: ids.externalGroup, name: "External packages", kind: "module", layer: "code", parent: systemId, description: "Third-party libraries used by this code", metadata: { external: true } });

  const httpNode = (rawHost: string | undefined): string => {
    const host = rawHost ?? "dynamic";
    const internal = !!rawHost && !rawHost.includes(".") && rawHost !== "localhost";
    addNode({
      id: ids.http(host),
      name: rawHost ? host : "HTTP (dynamic URL)",
      kind: "external_api",
      layer: "network",
      description: internal ? `HTTP service "${host}" called by this code` : `HTTP API at ${host}`,
      aliases: internal ? [`service:${host}`] : rawHost ? [`host:${host}`] : undefined,
      inputs: [{ name: "request", type: "http" }],
      outputs: [{ name: "response", type: "http" }],
      metadata: { host },
    });
    return ids.http(host);
  };

  const storeNode = (engine: string): string => {
    addNode({
      id: ids.store(engine),
      name: engine,
      kind: "datastore",
      layer: "runtime",
      description: `${engine} datastore used by this code`,
      aliases: [`datastore:${engine}`],
      inputs: [{ name: "write" }],
      outputs: [{ name: "read" }],
      metadata: { engine },
    });
    return ids.store(engine);
  };

  const queueNode = (system: string, topic?: string): string => {
    addNode({ id: ids.queue(system), name: system, kind: "queue", layer: "messaging", aliases: [`queue:${system}`], metadata: { system } });
    if (!topic) return ids.queue(system);
    addNode({
      id: ids.topic(system, topic),
      name: topic,
      kind: "queue",
      layer: "messaging",
      parent: ids.queue(system),
      aliases: [`topic:${topic}`],
      inputs: [{ name: "publish", type: `${system}:${topic}` }],
      outputs: [{ name: "consume", type: `${system}:${topic}` }],
      metadata: { system, topic },
    });
    return ids.topic(system, topic);
  };

  const globalNode = (file: string, name: string): string => {
    const g = byPath.get(file)!.globals.find((x) => x.name === name);
    addNode({
      id: ids.global(file, name),
      name,
      kind: "datastore",
      layer: "code",
      parent: ids.file(file),
      description: "Module-level shared state",
      source: { file, line: g?.line },
      metadata: { subkind: "global" },
    });
    return ids.global(file, name);
  };

  const httpCall = (f: FileModel, c: CallSite, method: string, from: string) => {
    const url = c.firstArg;
    const { host, path: urlPath } = parseUrl(url);
    const verb = method.toUpperCase() === "FETCH" || method.toUpperCase() === "REQUEST" ? "" : method.toUpperCase();
    const label = `${verb} ${urlPath ?? ""}`.trim();
    if (host && urlPath) {
      const norm = normRoute(urlPath);
      const route = routeIndex.get(`${host}:${verb || "GET"} ${norm}`) ?? routeIndex.get(`${host}:* ${norm}`);
      if (route) {
        addEdge("call", from, route, { ...c, file: f.path }, { protocol: "http", label: label || undefined });
        return;
      }
    }
    addEdge("call", from, httpNode(host), { ...c, file: f.path }, { protocol: "http", label: label || undefined });
  };

  // ---------- HTTP routes (entry points) ----------
  const serviceOf = (file: string): string => {
    let d = path.posix.dirname(file);
    while (d !== "." && d !== "") {
      if (manifestDirs.has(d)) return path.posix.basename(d);
      d = path.posix.dirname(d);
    }
    return rootName;
  };
  const routeIndex = new Map<string, string>(); // 'svc:METHOD /path' and 'svc:* /path' -> node id
  const routeSites = new Set<CallSite>();
  const addRoute = (f: FileModel, method: string, rawPath: string, line: number, framework: string): string => {
    const m = method.toUpperCase();
    const norm = normRoute(rawPath);
    const svc = serviceOf(f.path);
    const id = `route:${f.path}#${m} ${norm}`;
    addNode({
      id,
      name: `${m} ${rawPath || "/"}`,
      kind: "network_endpoint",
      layer: "network",
      parent: ids.file(f.path),
      description: `HTTP endpoint served by ${svc}`,
      aliases: [`route:${svc}:${m} ${norm}`],
      inputs: [{ name: "request", type: "http" }],
      outputs: [{ name: "response", type: "http" }],
      source: { file: f.path, line },
      metadata: { method: m, path: rawPath, framework, service: svc },
    });
    routeIndex.set(`${svc}:${m} ${norm}`, id);
    if (!routeIndex.has(`${svc}:* ${norm}`)) routeIndex.set(`${svc}:* ${norm}`, id);
    return id;
  };
  const ROUTE_METHODS = /^(get|post|put|patch|delete|head|options|all)$/i;
  for (const f of files) {
    for (const d of f.defs) {
      for (const dec of d.decorators ?? []) {
        let r: { method: string; path: string; fw: string } | undefined;
        const py = dec.match(/^[\w.]+\.(get|post|put|patch|delete|head|options|route|api_route|websocket)\(\s*(?:path\s*=\s*)?[rf]?["']([^"']*)["']([\s\S]*)\)$/);
        if (py) {
          const methods = py[3].match(/methods\s*=\s*\[\s*["'](\w+)/);
          const verb = py[1] === "route" || py[1] === "api_route" ? (methods?.[1] ?? "GET") : py[1] === "websocket" ? "WS" : py[1];
          r = { method: verb, path: py[2], fw: f.lang === "python" ? "python" : "js" };
        }
        const nest = dec.match(/^(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:["'`]([^"'`]*)["'`])?/);
        if (nest) {
          const cls = d.parentQual ? f.defs.find((x) => x.qual === d.parentQual) : undefined;
          const prefix = cls?.decorators?.map((x) => x.match(/^Controller\(\s*["'`]([^"'`]*)["'`]/)?.[1]).find(Boolean) ?? "";
          r = { method: nest[1], path: `/${[prefix, nest[2] ?? ""].filter(Boolean).join("/")}`.replace(/\/+/g, "/"), fw: "nest" };
        }
        if (!r) continue;
        const id = addRoute(f, r.method, r.path, d.line, r.fw);
        addEdge("call", id, ids.def(f.path, d.qual), { line: d.line, file: f.path }, { protocol: "http" });
      }
    }
    for (const c of f.calls) {
      if (c.parts.length !== 2 || !ROUTE_METHODS.test(c.parts[1]) || !c.firstArg?.startsWith("/")) continue;
      const recv = resolveInScope(f, c.from, c.parts[0]);
      if (recv && !(recv.kind === "external" && recv.cls.type === "lib") && recv.kind !== "global") continue;
      routeSites.add(c);
      const id = addRoute(f, c.parts[1] === "all" ? "*" : c.parts[1], c.firstArg, c.line, "js");
      const handler = [...(c.argNames ?? [])].reverse().map((n) => resolveInScope(f, c.from, n.split(".")[0])).find((t) => t?.kind === "def");
      const target = handler && handler.kind === "def" ? ids.def(handler.file, handler.qual) : fromNodeId(f, c.from);
      addEdge("call", id, target, { line: c.line, file: f.path }, { protocol: "http" });
    }
  }

  for (const f of files) {
    const imported = new Map<string, PackageClass>();
    for (const b of f.imports) {
      const mod = resolveModule(f, b.module);
      if (mod && "external" in mod) imported.set(mod.external, classifyPackage(mod.external, f.lang));
    }
    const fileUses = (type: PackageClass["type"]) => [...imported.entries()].filter(([, c]) => c.type === type);

    for (const c of f.calls) {
      if (routeSites.has(c)) continue;
      const from = fromNodeId(f, c.from);
      const site = { ...c, file: f.path };
      const r = resolveCall(f, c);
      const last = c.parts[c.parts.length - 1];

      if (r) {
        const t = r.target;
        if (t.kind === "def") {
          addEdge("call", from, ids.def(t.file, t.qual), site, r.inferred ? { metadata: { inferred: true, file: f.path } } : {});
        } else if (t.kind === "module") {
          addEdge("call", from, ids.file(t.file), site);
        } else if (t.kind === "global") {
          const mode = c.parts.length > 1 && /^(append|extend|insert|pop|remove|clear|update|add|discard|setdefault|set|put|delete|push|shift|unshift|splice)$/.test(last) ? "write" : "read";
          const g = globalNode(t.file, t.name);
          if (mode === "write") addEdge("write", from, g, site);
          else addEdge("read", g, from, site);
        } else if (t.kind === "external") {
          const member = t.member ?? "";
          const method = member.split(".").pop() ?? "";
          if (t.cls.type === "stdlib") continue;
          if (t.cls.type === "http") {
            if (HTTP_VERBS.has(method.toLowerCase()) || /^https?:/.test(c.firstArg ?? "")) httpCall(f, c, method || "request", from);
            continue;
          }
          if (t.cls.type === "db") {
            const store = storeNode(t.cls.engine);
            const mode = dbAccessMode(method, c.firstArg);
            if (mode === "write") addEdge("write", from, store, site, { protocol: t.cls.engine, label: sqlLabel(c.firstArg) });
            else if (mode === "read") addEdge("read", store, from, site, { protocol: t.cls.engine, label: sqlLabel(c.firstArg) });
            continue;
          }
          if (t.cls.type === "queue") {
            queueCall(f, c, t.cls.system, method, from, site);
            continue;
          }
          if (!includeExternal) continue;
          externalGroup();
          addNode({ id: ids.pkg(t.pkg), name: t.pkg, kind: "module", layer: "code", parent: ids.externalGroup, metadata: { external: true, package: t.pkg } });
          addEdge("call", from, ids.pkg(t.pkg), site, { label: member || undefined });
        }
        continue;
      }

      // Unresolved: global fetch(), or method calls on clients created from known packages.
      if (c.parts.length === 1 && last === "fetch" && f.lang !== "python") {
        httpCall(f, c, "fetch", from);
        continue;
      }
      if (c.parts.length < 2) continue;
      const clientLike = /client|http|api|session|axios|request/i.test(c.parts[0]);
      if (fileUses("http").length && HTTP_VERBS.has(last.toLowerCase()) && (isAbsoluteUrl(c.firstArg) || (clientLike && looksLikeUrl(c.firstArg)))) {
        httpCall(f, c, last, from);
        continue;
      }
      const dbs = fileUses("db");
      if (dbs.length) {
        const mode = dbAccessMode(last, c.firstArg);
        const clientish = /^(execute|executemany|query|fetch\w*|find\w*|insert\w*|update\w*|delete\w*|aggregate|commit|hget\w*|hset|sadd|smembers|lpush|rpush|lrange|zadd|incr\w*|expire|upsert\w*|replace_one)$/.test(last) || !!sqlLabel(c.firstArg);
        if (mode && clientish) {
          const engine = (dbs.find(([, cl]) => cl.type === "db" && cl.engine !== "sql") ?? dbs[0])[1] as { engine: string };
          const store = storeNode(engine.engine);
          if (mode === "write") addEdge("write", from, store, site, { protocol: engine.engine, label: sqlLabel(c.firstArg) });
          else addEdge("read", store, from, site, { protocol: engine.engine, label: sqlLabel(c.firstArg) });
          continue;
        }
      }
      const queues = fileUses("queue");
      if (queues.length && (PRODUCE_METHODS.test(last) || CONSUME_METHODS.test(last))) {
        queueCall(f, c, (queues[0][1] as { system: string }).system, last, from, site);
      }
    }

    // Shared state accesses that were not calls (plain reads, assignments).
    for (const a of f.globalAccess) {
      const t = resolveInScope(f, a.from, a.name);
      if (t?.kind !== "global") continue;
      if (clientOf(t)) continue;
      const g = byPath.get(t.file)!.globals.find((x) => x.name === t.name);
      const from = fromNodeId(f, a.from);
      if (a.mode === "read" && g && g.constantLike && !g.mutable && !isWrittenAnywhere(t.file, t.name)) continue;
      const node = globalNode(t.file, t.name);
      if (a.mode === "write") addEdge("write", from, node, { line: a.line, file: f.path });
      else addEdge("read", node, from, { line: a.line, file: f.path });
    }
  }

  // Functions passed as values (callbacks, handlers, executor.submit(fn)) are used even without a call edge.
  const markReferenced = (t: Target | undefined) => {
    if (t?.kind !== "def") return;
    const n = nodes.get(ids.def(t.file, t.qual));
    if (n) n.metadata = { ...(n.metadata ?? {}), referenced: true };
  };
  // Method names called anywhere (even on unknown receivers): overrides may be reached by dynamic dispatch.
  const calledNames = new Set(files.flatMap((f) => f.calls.map((c) => c.parts[c.parts.length - 1])));
  for (const f of files) {
    for (const d of f.defs) {
      if (d.type !== "method" || !calledNames.has(d.name)) continue;
      const n = nodes.get(ids.def(f.path, d.qual));
      if (n) n.metadata = { ...(n.metadata ?? {}), nameCalled: true };
    }
  }
  for (const f of files) {
    for (const name of f.valueRefs) {
      const t = resolveName(f, name);
      // only count references that resolve to a def in another file or a top-level def here
      markReferenced(t);
    }
    for (const c of f.calls) {
      for (const a of c.argNames ?? []) {
        const t = resolveInScope(f, c.from, a.split(".")[0]);
        const target = t && a.includes(".") ? descend(t, a.split(".").slice(1))?.target : t;
        if (target?.kind === "def") {
          const n = nodes.get(ids.def(target.file, target.qual));
          if (n) n.metadata = { ...(n.metadata ?? {}), referenced: true };
        }
      }
    }
  }

  function queueCall(f: FileModel, c: CallSite, system: string, method: string, from: string, site: { line: number; file: string; inLoop?: boolean; conditional?: boolean }) {
    const topic = c.firstArg && /^[\w.\-/:]+$/.test(c.firstArg) ? c.firstArg : undefined;
    const q = queueNode(system, topic);
    if (CONSUME_METHODS.test(method)) addEdge("event", q, from, site, { protocol: system, label: topic ? `consume ${topic}` : "consume" });
    else if (PRODUCE_METHODS.test(method)) addEdge("event", from, q, site, { protocol: system, label: topic ? `publish ${topic}` : "publish" });
  }

  function isWrittenAnywhere(file: string, name: string): boolean {
    return files.some((f) => f.globalAccess.some((a) => a.mode === "write" && a.name === name && (f.path === file || f.imports.some((b) => b.local === name))));
  }

  // Finalise edges: conditional only if every call site was conditional; record source lines.
  const outEdges: FlowEdge[] = [];
  for (const e of edges.values()) {
    const { _lines, _uncond, _unguarded, ...rest } = e;
    if (!_uncond) rest.conditional = true;
    // guarded: every call site sits in a try block / .catch chain
    rest.metadata = { ...(rest.metadata ?? {}), lines: _lines, guarded: !_unguarded };
    outEdges.push(rest);
  }

  return {
    version: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    nodes: [...nodes.values()],
    edges: outEdges,
  };
}

function defNode(f: FileModel, d: Def): FlowNode {
  const parent = d.parentQual ? ids.def(f.path, d.parentQual) : ids.file(f.path);
  const aliases = [`src:${f.path}#${d.qual}`];
  if (f.lang === "python") aliases.push(`py:${pyModuleName(f.path)}.${d.qual}`);
  if (d.type === "class") {
    const init = f.defs.find((x) => x.qual === `${d.qual}.__init__`);
    return {
      id: ids.def(f.path, d.qual),
      name: d.name,
      description: d.doc,
      kind: "module",
      layer: "code",
      parent,
      aliases,
      inputs: init?.params ?? d.params,
      outputs: [{ name: "instance", type: d.name }],
      source: { file: f.path, line: d.line, endLine: d.endLine },
      metadata: compact({ subkind: "class", language: f.lang, bases: d.bases?.length ? d.bases : undefined, decorators: d.decorators }),
    };
  }
  const outputs: Port[] = [{ name: "return", ...(d.returns ? { type: d.returns } : {}) }];
  return {
    id: ids.def(f.path, d.qual),
    name: d.type === "method" ? d.name : d.name,
    description: d.doc,
    kind: "function",
    layer: "code",
    parent,
    aliases,
    inputs: d.params,
    outputs,
    source: { file: f.path, line: d.line, endLine: d.endLine },
    metadata: compact({ subkind: d.type, language: f.lang, async: d.isAsync || undefined, decorators: d.decorators, qualifiedName: d.qual, visibility: d.visibility }),
  };
}

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

export function pyModuleName(p: string): string {
  return p
    .replace(/\.py$/, "")
    .replace(/\/__init__$/, "")
    .split("/")
    .join(".");
}

function resolveJsPath(p: string, files: Map<string, unknown>): string | undefined {
  const norm = path.posix.normalize(p).replace(/^\.\//, "");
  const stripped = norm.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
  if (files.has(norm)) return norm;
  for (const base of [norm, stripped]) {
    for (const e of exts) if (files.has(base + e)) return base + e;
    for (const e of exts) if (files.has(`${base}/index${e}`)) return `${base}/index${e}`;
  }
  return undefined;
}

/**
 * Directory nodes, with single-child chains collapsed ("src/app" instead of "src" > "app").
 * Returns visible dir -> parent visible dir ('' for top level), and the dirs folded into each visible dir.
 */
function buildDirTree(filePaths: string[]): { parents: Map<string, string>; collapsed: Map<string, string[]> } {
  const children = new Map<string, Set<string>>(); // dir -> child dirs
  const hasFiles = new Set<string>();
  for (const f of filePaths) {
    let d = path.posix.dirname(f);
    if (d === ".") continue;
    hasFiles.add(d);
    while (d !== ".") {
      const parent = path.posix.dirname(d);
      const key = parent === "." ? "" : parent;
      if (!children.has(key)) children.set(key, new Set());
      children.get(key)!.add(d);
      d = parent;
    }
  }
  const out = new Map<string, string>();
  const collapsed = new Map<string, string[]>();
  const visit = (dir: string, visibleParent: string) => {
    for (const child of [...(children.get(dir) ?? [])].sort()) {
      let cur = child;
      const folded: string[] = [];
      // collapse: a dir with no files and exactly one child dir merges with that child
      while (!hasFiles.has(cur) && (children.get(cur)?.size ?? 0) === 1) {
        folded.push(cur);
        cur = [...children.get(cur)!][0];
      }
      out.set(cur, visibleParent);
      if (folded.length) collapsed.set(cur, folded);
      visit(cur, cur);
    }
  };
  visit("", "");
  return { parents: out, collapsed };
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function isAbsoluteUrl(s?: string): boolean {
  return !!s && (/^https?:\/\//.test(s) || /^\{[^}]+\}\//.test(s));
}

export function normRoute(p: string): string {
  let r = p.trim().split("?")[0];
  if (!r.startsWith("/")) r = `/${r}`;
  r = r.replace(/:\w+/g, "{}").replace(/\{[^}]*\}/g, "{}").replace(/<[^>]*>/g, "{}");
  if (r.length > 1) r = r.replace(/\/+$/, "");
  return r;
}

function looksLikeUrl(s?: string): boolean {
  return !!s && (/^https?:\/\//.test(s) || /^\{[^}]+\}\//.test(s) || /^\/[\w{}\-./]*$/.test(s));
}

/** Pull a host (or a service name guessed from a placeholder like {ORDERS_URL}) and a path out of a URL literal. */
export function parseUrl(url?: string): { host?: string; path?: string } {
  if (!url) return {};
  const abs = url.match(/^https?:\/\/([^/{}?#:]+|\{[^}]+\})(?::(?:\d+|\{[^}]*\}))?(\/[^?#]*)?/);
  if (abs) {
    const rawHost = abs[1];
    let host = rawHost.startsWith("{") ? serviceFromPlaceholder(rawHost) : rawHost.replace(/:\d*$/, "");
    if (host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]") host = "localhost";
    return { host, path: abs[2] || "/" };
  }
  const ph = url.match(/^\{([^}]+)\}(\/[^?#]*)?/);
  if (ph) return { host: serviceFromPlaceholder(ph[1]), path: ph[2] || "/" };
  if (url.startsWith("/")) return { path: url.split("?")[0] };
  return {};
}

function serviceFromPlaceholder(ph: string): string | undefined {
  const last = ph.replace(/[{}]/g, "").split(/[.[\]'"]/).filter(Boolean).pop() ?? "";
  const name = last
    .replace(/^(process\.env\.|os\.environ)/, "")
    .toLowerCase()
    .replace(/(_|-)?(service)?(_|-)?(base)?(_|-)?(url|uri|host|addr|address|endpoint|api)$/, "")
    .replace(/_(service|svc)$/, "")
    .replace(/_/g, "-");
  return name && /^[a-z][a-z0-9-]*$/.test(name) && name !== "base" ? name : undefined;
}
