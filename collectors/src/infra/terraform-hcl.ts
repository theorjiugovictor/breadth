// Reads Terraform / OpenTofu configuration (.tf source) into the same resource list that
// plan and state JSON produce, so a repository needs no `terraform plan` to be mapped.
//
// Values are evaluated where the configuration alone decides them: literals, variables with
// defaults or .tfvars values, locals, string templates and common functions. What only an
// apply would know (ids, ARNs, computed attributes) stays unknown. A reference to another
// resource is kept as a marker string, "${aws_s3_bucket.uploads.arn}", so that security
// group rules and IAM policies can still be resolved to the resources they point at.
// Browser-safe: no Node APIs.

import { basename, dirname, join } from "../code/posix.js";
import { attr, parseHcl, parseTfJson, parseTfvarsJson, type Block, type Body, type Expr } from "./hcl.js";
import type { TfResource } from "./terraform.js";

export interface TfSourceFile {
  /** Path relative to the scan root, forward slashes. */
  path: string;
  text: string;
}

export interface TfModuleCall {
  address: string;
  source: string;
  local: boolean;
  file: string;
  line: number;
}

export interface TfRoot {
  /** Directory of the root module, relative to the scan root ("." for the root itself). */
  dir: string;
  resources: TfResource[];
  modules: TfModuleCall[];
  files: string[];
}

export interface LoadOptions {
  warn?: (msg: string) => void;
  /**
   * Extra variable files (what `-var-file` would pass), relative to each root module: a list
   * for every root (files that do not exist are skipped), or per root folder:
   * { "envs/prod": ["prod.tfvars"] }.
   */
  varFiles?: string[] | Record<string, string[]>;
}

export const TF_FILE = /\.(tf|tofu)(\.json)?$/i;
/** Variable files Terraform loads on its own. */
export const TFVARS_FILE = /(^|\/)(terraform\.tfvars|[^/]*\.auto\.tfvars)(\.json)?$/i;
/** Any variable file (others apply only when named with -var-file / the varFiles setting). */
export const ANY_TFVARS_FILE = /\.tfvars(\.json)?$/i;

/* ---------------- values ---------------- */

/** A value only an apply would know. `refs` are the resource addresses it derives from. */
class Unknown {
  constructor(readonly refs: string[] = []) {}
}

type Value = unknown;

const isUnknown = (v: Value): v is Unknown => v instanceof Unknown;
const marker = (u: Unknown) => (u.refs.length === 1 ? `\${${u.refs[0]}}` : "${?}");

/** Whether a value is fully known (no Unknown and no marker strings inside). */
function known(v: Value): boolean {
  if (isUnknown(v)) return false;
  if (typeof v === "string") return !v.includes("${");
  if (Array.isArray(v)) return v.every(known);
  if (v && typeof v === "object") return Object.values(v).every(known);
  return true;
}

function refsIn(v: Value, out: string[] = []): string[] {
  if (isUnknown(v)) out.push(...v.refs);
  else if (Array.isArray(v)) v.forEach((x) => refsIn(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => refsIn(x, out));
  return out;
}

/** Plain JSON for a resource's values: unknowns become marker strings. */
function plain(v: Value): unknown {
  if (isUnknown(v)) return marker(v);
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

function str(v: Value): string {
  if (isUnknown(v)) return marker(v);
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(plain(v));
  return String(v);
}

/* ---------------- modules ---------------- */

interface ParsedDir {
  dir: string;
  files: { path: string; body: Body }[];
  tfvars: { path: string; body: Body }[];
}

const CONTEXT_ROOTS = new Set(["count", "each", "path", "terraform", "self"]);

class ModuleInstance {
  readonly resources = new Map<string, Block & { file: string }>();
  readonly data = new Map<string, Block & { file: string }>();
  readonly variables = new Map<string, Block>();
  readonly locals = new Map<string, Expr>();
  readonly outputs = new Map<string, Expr>();
  readonly calls = new Map<string, { block: Block; file: string; child?: ModuleInstance; source: string }>();
  private memo = new Map<string, Value>();
  private refMemo = new Map<string, string[]>();
  private busy = new Set<string>();

  constructor(
    readonly loader: Loader,
    readonly dir: ParsedDir,
    /** "" for a root module, "module.network." for a child. */
    readonly prefix: string,
    /** Input values for a child module: evaluated lazily in the parent. */
    readonly inputs: Map<string, { value: () => Value; refs: () => string[] }>,
    readonly tfvars: Map<string, Value>,
    depth: number,
  ) {
    for (const f of dir.files) {
      for (const b of f.body.blocks) {
        const [a, c] = b.labels;
        if (b.type === "resource" && a && c) this.resources.set(`${a}.${c}`, { ...b, file: f.path });
        else if (b.type === "data" && a && c) this.data.set(`${a}.${c}`, { ...b, file: f.path });
        else if (b.type === "variable" && a) this.variables.set(a, b);
        else if (b.type === "locals") for (const at of b.body.attrs) this.locals.set(at.name, at.expr);
        else if (b.type === "output" && a) {
          const v = attr(b.body, "value");
          if (v) this.outputs.set(a, v.expr);
        } else if (b.type === "module" && a) {
          const src = attr(b.body, "source");
          const source = src ? str(this.eval(src.expr)) : "";
          this.calls.set(a, { block: b, file: f.path, source });
        }
      }
    }
    for (const [name, call] of this.calls) {
      const local = /^\.\.?(\/|$)/.test(call.source);
      if (!local || depth > 12) continue;
      const childDir = loader.dirs.get(join(dir.dir, call.source));
      if (!childDir) continue;
      const inputs = new Map<string, { value: () => Value; refs: () => string[] }>();
      for (const a of call.block.body.attrs) {
        if (["source", "version", "count", "for_each", "providers", "depends_on"].includes(a.name)) continue;
        inputs.set(a.name, { value: () => this.eval(a.expr), refs: () => this.refs(a.expr) });
      }
      call.child = new ModuleInstance(loader, childDir, `${prefix}module.${name}.`, inputs, new Map(), depth + 1);
    }
  }

  /** Guards recursive lookups (locals that refer to each other, modules wired in a loop). */
  private once<T>(key: string, memo: Map<string, T>, fallback: T, fn: () => T): T {
    if (memo.has(key)) return memo.get(key)!;
    if (this.busy.has(key)) return fallback;
    this.busy.add(key);
    try {
      const v = fn();
      memo.set(key, v);
      return v;
    } finally {
      this.busy.delete(key);
    }
  }

  variable(name: string): Value {
    return this.once(`var.${name}`, this.memo, new Unknown(), () => {
      const input = this.inputs.get(name);
      if (input) return input.value();
      if (this.tfvars.has(name)) return this.tfvars.get(name);
      const def = this.variables.get(name) && attr(this.variables.get(name)!.body, "default");
      return def ? this.eval(def.expr) : new Unknown();
    });
  }

  variableRefs(name: string): string[] {
    return this.once(`var.${name}`, this.refMemo, [], () => this.inputs.get(name)?.refs() ?? []);
  }

  local(name: string): Value {
    const e = this.locals.get(name);
    return e ? this.once(`local.${name}`, this.memo, new Unknown(), () => this.eval(e)) : new Unknown();
  }

  localRefs(name: string): string[] {
    const e = this.locals.get(name);
    return e ? this.once(`local.${name}`, this.refMemo, [], () => this.refs(e)) : [];
  }

  moduleOutput(name: string, output: string | undefined): Value {
    const call = this.calls.get(name);
    if (!call?.child || !output) return new Unknown([`${this.prefix}module.${name}`]);
    const e = call.child.outputs.get(output);
    return e ? call.child.once(`output.${output}`, call.child.memo, new Unknown(), () => call.child!.eval(e)) : new Unknown();
  }

  moduleOutputRefs(name: string, output: string | undefined): string[] {
    const call = this.calls.get(name);
    if (!call?.child || !output) return [`${this.prefix}module.${name}`];
    const child = call.child;
    const e = child.outputs.get(output);
    return e ? child.once(`output.${output}`, child.refMemo, [], () => child.refs(e)) : [];
  }

  dataRefs(key: string): string[] {
    const b = this.data.get(key);
    return b ? this.once(`data.${key}`, this.refMemo, [], () => this.bodyRefs(b.body)) : [];
  }

  /* ---------------- references ---------------- */

  /** Resource addresses an expression depends on, through variables, locals and module outputs. */
  refs(e: Expr, shadow: ReadonlySet<string> = new Set()): string[] {
    const out = new Set<string>();
    const walk = (x: Expr, sh: ReadonlySet<string>) => {
      switch (x.t) {
        case "lit":
          return;
        case "var":
        case "get":
        case "index":
        case "splat": {
          const chain = flatten(x);
          for (const ix of chain.indexes) walk(ix, sh);
          for (const r of this.traversalRefs(chain, sh)) out.add(r);
          return;
        }
        case "tmpl":
          for (const p of x.parts) if (typeof p !== "string") walk(p, sh);
          return;
        case "tuple":
          x.items.forEach((i) => walk(i, sh));
          return;
        case "object":
          for (const i of x.items) {
            walk(i.key, sh);
            walk(i.value, sh);
          }
          return;
        case "call":
          x.args.forEach((a) => walk(a, sh));
          return;
        case "unary":
          return walk(x.x, sh);
        case "binary":
          walk(x.a, sh);
          return walk(x.b, sh);
        case "cond":
          walk(x.c, sh);
          walk(x.a, sh);
          return walk(x.b, sh);
        case "for": {
          walk(x.coll, sh);
          const inner = new Set([...sh, x.valVar, ...(x.keyVar ? [x.keyVar] : [])]);
          for (const p of [x.key, x.value, x.cond]) if (p) walk(p, inner);
          return;
        }
        case "directive": {
          const inner = new Set([...sh, ...x.vars]);
          x.exprs.forEach((p) => walk(p, inner));
          return;
        }
      }
    };
    walk(e, shadow);
    return [...out];
  }

  bodyRefs(body: Body, skipBlocks: string[] = []): string[] {
    const out = new Set<string>();
    for (const a of body.attrs) for (const r of this.refs(a.expr)) out.add(r);
    for (const b of body.blocks) {
      if (skipBlocks.includes(b.type)) continue;
      // dynamic "x" { for_each = ...; content { x.value ... } }: x is the iterator
      const sh = b.type === "dynamic" ? new Set([iteratorName(b)]) : new Set<string>();
      for (const a of b.body.attrs) for (const r of this.refs(a.expr, sh)) out.add(r);
      for (const r of this.bodyRefsShadowed(b.body, sh)) out.add(r);
    }
    return [...out];
  }

  private bodyRefsShadowed(body: Body, sh: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const b of body.blocks) {
      for (const a of b.body.attrs) out.push(...this.refs(a.expr, sh));
      out.push(...this.bodyRefsShadowed(b.body, sh));
    }
    return out;
  }

  private traversalRefs(chain: Chain, shadow: ReadonlySet<string>): string[] {
    const [first, second] = chain.steps;
    const root = chain.root;
    if (shadow.has(root) || CONTEXT_ROOTS.has(root)) return [];
    if (root === "var") return first ? this.variableRefs(first) : [];
    if (root === "local") return first ? this.localRefs(first) : [];
    if (root === "module") return first ? this.moduleOutputRefs(first, second) : [];
    if (root === "data") return first && second ? this.dataRefs(`${first}.${second}`) : [];
    if (first && this.resources.has(`${root}.${first}`)) return [this.prefix + chain.text];
    return [];
  }

  /* ---------------- evaluation ---------------- */

  eval(e: Expr, scope: ReadonlyMap<string, Value> = new Map()): Value {
    switch (e.t) {
      case "lit":
        return e.v;
      case "tmpl": {
        const parts = e.parts.map((p) => (typeof p === "string" ? p : this.eval(p, scope)));
        if (parts.length === 1 && typeof e.parts[0] !== "string") return parts[0];
        return parts.map(str).join("");
      }
      case "directive":
        return new Unknown(e.exprs.flatMap((x) => this.refs(x)));
      case "tuple":
        return e.items.map((i) => this.eval(i, scope));
      case "object": {
        const o: Record<string, Value> = {};
        for (const i of e.items) {
          // `{ name = 1 }` and `{ (var.k) = 1 }`: a parenthesised or computed key is evaluated.
          const k = this.eval(i.key, scope);
          if (typeof k === "string" || typeof k === "number") o[String(k)] = this.eval(i.value, scope);
        }
        return o;
      }
      case "var":
      case "get":
      case "index":
      case "splat":
        return this.evalTraversal(e, scope);
      case "call":
        return callFunction(e.name, e.args.map((a) => this.eval(a, scope)));
      case "unary": {
        const x = this.eval(e.x, scope);
        if (!known(x)) return new Unknown(refsIn(x));
        return e.op === "!" ? !x : -Number(x);
      }
      case "binary": {
        const a = this.eval(e.a, scope);
        const b = this.eval(e.b, scope);
        // Short-circuit what is decided by one side.
        if (e.op === "&&" && (a === false || b === false)) return false;
        if (e.op === "||" && (a === true || b === true)) return true;
        if (!known(a) || !known(b)) return new Unknown([...refsIn(a), ...refsIn(b)]);
        return binary(e.op, a, b);
      }
      case "cond": {
        const c = this.eval(e.c, scope);
        if (c === true || c === false) return this.eval(c ? e.a : e.b, scope);
        const a = this.eval(e.a, scope);
        const b = this.eval(e.b, scope);
        // Both branches agree: the condition does not matter.
        if (known(a) && JSON.stringify(a) === JSON.stringify(b)) return a;
        return new Unknown([...refsIn(a), ...refsIn(b)]);
      }
      case "for": {
        const coll = this.eval(e.coll, scope);
        if (!known(coll) || !coll || typeof coll !== "object") return new Unknown(refsIn(coll));
        const entries: [Value, Value][] = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : Object.entries(coll);
        const list: Value[] = [];
        const obj: Record<string, Value> = {};
        for (const [k, v] of entries) {
          const inner = new Map(scope);
          inner.set(e.valVar, v);
          if (e.keyVar) inner.set(e.keyVar, k);
          if (e.cond) {
            const ok = this.eval(e.cond, inner);
            if (ok === false) continue;
            if (ok !== true) return new Unknown();
          }
          const value = this.eval(e.value, inner);
          if (e.object) {
            const key = e.key ? this.eval(e.key, inner) : k;
            if (typeof key !== "string" && typeof key !== "number") return new Unknown();
            obj[String(key)] = value;
          } else list.push(value);
        }
        return e.object ? obj : list;
      }
    }
  }

  private evalTraversal(e: Expr, scope: ReadonlyMap<string, Value>): Value {
    const chain = flatten(e);
    const { root, steps } = chain;
    let value: Value;
    let used = 0;
    if (scope.has(root)) value = scope.get(root);
    else if (root === "var" && steps[0]) [value, used] = [this.variable(steps[0]), 1];
    else if (root === "local" && steps[0]) [value, used] = [this.local(steps[0]), 1];
    else if (root === "module" && steps[0]) [value, used] = [this.moduleOutput(steps[0], steps[1]), 2];
    else if (root === "data" && steps[0] === "aws_iam_policy_document" && steps[1] && steps[2] === "json") {
      const b = this.data.get(`${steps[0]}.${steps[1]}`);
      return b ? this.policyDocument(b.body) : new Unknown();
    } else if (root === "path" && steps[0] === "module") return this.dir.dir;
    else if (root === "terraform" && steps[0] === "workspace") return new Unknown();
    else return new Unknown(this.traversalRefs(chain, new Set(scope.keys())));
    // Apply the remaining steps to a known value; after a splat, attribute steps map over the list.
    let splatted = false;
    const pick = (v: Value, key: string): Value => (v && typeof v === "object" && !isUnknown(v) ? ((v as Record<string, Value>)[key] ?? new Unknown()) : new Unknown());
    for (const step of chain.ops.slice(used)) {
      if (isUnknown(value)) return value;
      if (step.kind === "splat") {
        if (!Array.isArray(value)) value = value === null || value === undefined ? [] : [value];
        splatted = true;
        continue;
      }
      const key = step.kind === "get" ? step.name : this.eval(step.index, scope);
      if (isUnknown(key)) return new Unknown(key.refs);
      value = splatted && Array.isArray(value) && step.kind === "get" ? value.map((v) => pick(v, step.name)) : pick(value, String(key));
    }
    return value;
  }

  /** data "aws_iam_policy_document": the JSON policy it renders. */
  private policyDocument(body: Body): string {
    const statements: Record<string, unknown>[] = [];
    for (const src of ["source_policy_documents", "override_policy_documents"]) {
      const a = attr(body, src);
      const docs = a ? this.eval(a.expr) : [];
      for (const d of Array.isArray(docs) ? docs : []) {
        try {
          const parsed = JSON.parse(String(d));
          statements.push(...(Array.isArray(parsed.Statement) ? parsed.Statement : [parsed.Statement]).filter(Boolean));
        } catch {
          /* not a literal document */
        }
      }
    }
    for (const st of body.blocks.filter((b) => b.type === "statement")) {
      const get = (n: string) => {
        const a = attr(st.body, n);
        return a ? plain(this.eval(a.expr)) : undefined;
      };
      const principals = (type: string) => {
        const out: Record<string, unknown> = {};
        for (const p of st.body.blocks.filter((b) => b.type === type)) {
          const t = attr(p.body, "type");
          const ids = attr(p.body, "identifiers");
          if (t && ids) out[str(this.eval(t.expr))] = plain(this.eval(ids.expr));
        }
        return Object.keys(out).length ? out : undefined;
      };
      statements.push(
        compactObject({
          Sid: get("sid"),
          Effect: get("effect") ?? "Allow",
          Action: get("actions"),
          NotAction: get("not_actions"),
          Resource: get("resources"),
          NotResource: get("not_resources"),
          Principal: principals("principals"),
          NotPrincipal: principals("not_principals"),
          Condition: st.body.blocks.some((b) => b.type === "condition") ? { present: true } : undefined,
        }),
      );
    }
    return JSON.stringify({ Version: "2012-10-17", Statement: statements });
  }

  /** A block's body as plan JSON shapes it: attributes as values, nested blocks as lists. */
  bodyValues(body: Body, scope: ReadonlyMap<string, Value> = new Map()): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const a of body.attrs) out[a.name] = plain(this.eval(a.expr, scope));
    for (const b of body.blocks) {
      if (b.type === "lifecycle" || b.type === "provisioner" || b.type === "connection") continue;
      const list = (out[b.type === "dynamic" ? (b.labels[0] ?? "") : b.type] as unknown[] | undefined) ?? [];
      if (b.type === "dynamic") {
        // dynamic "ingress" { for_each = [...]; content { ... } }: one block per element when the list is known
        const content = b.body.blocks.find((x) => x.type === "content");
        if (!b.labels[0] || !content) continue;
        const fe = attr(b.body, "for_each");
        const items = fe ? this.eval(fe.expr, scope) : new Unknown();
        const it = iteratorName(b);
        for (const [k, v] of instances(items) ?? [[undefined, new Unknown()]]) {
          list.push(this.bodyValues(content.body, new Map([...scope, [it, k === undefined ? new Unknown() : { key: k, value: v }]])));
        }
        out[b.labels[0]] = list;
        continue;
      }
      list.push(this.bodyValues(b.body, scope));
      out[b.type] = list;
    }
    return out;
  }

  /** Every managed resource in this module and the modules it calls. */
  collect(out: TfResource[], modules: TfModuleCall[]) {
    for (const [key, b] of this.resources) {
      const count = attr(b.body, "count");
      const forEach = attr(b.body, "for_each");
      // One instance per for_each key / count index when they are known (a few of them):
      // aws_sqs_queue.jobs["emails"], aws_instance.web[0]. Unknown: one node for all.
      let keyed: [string | number | undefined, Value][] = [[undefined, new Unknown()]];
      if (count) {
        const n = this.eval(count.expr);
        if (n === 0) continue; // count = 0, often a feature flag: the resource does not exist
        if (typeof n === "number" && n > 0 && n <= MAX_INSTANCES) keyed = Array.from({ length: n }, (_, i) => [i, i]);
      } else if (forEach) {
        const items = instances(this.eval(forEach.expr));
        if (items && !items.length) continue;
        if (items && items.length <= MAX_INSTANCES) keyed = items;
      }
      const refs = new Set(this.bodyRefs(b.body, ["lifecycle"]));
      for (const [k, v] of keyed) {
        const scope = new Map<string, Value>([
          ["each", forEach && k !== undefined ? { key: k, value: v } : new Unknown()],
          ["count", count && k !== undefined ? { index: k } : new Unknown()],
        ]);
        const values = this.bodyValues(b.body, scope);
        delete values.count;
        delete values.for_each;
        delete values.depends_on;
        delete values.provider;
        out.push({
          address: this.prefix + key + (k === undefined ? "" : `[${JSON.stringify(k)}]`),
          type: b.labels[0],
          name: b.labels[1],
          module: this.prefix ? this.prefix.replace(/\.$/, "") : undefined,
          values,
          refs,
          file: b.file,
          line: b.line,
        });
      }
    }
    for (const [name, call] of this.calls) {
      modules.push({ address: `${this.prefix}module.${name}`, source: call.source, local: !!call.child, file: call.file, line: call.block.line });
      call.child?.collect(out, modules);
    }
  }
}

/** Above this many for_each keys / count instances, one node stands for all of them. */
const MAX_INSTANCES = 25;

/** The [key, value] pairs a known for_each collection iterates over (sets iterate with key = value). */
function instances(v: Value): [string | number, Value][] | undefined {
  if (!known(v) || !v || typeof v !== "object") return undefined;
  if (Array.isArray(v)) return v.map((x) => [typeof x === "string" || typeof x === "number" ? x : JSON.stringify(plain(x)), x]);
  return Object.entries(v);
}

function iteratorName(dynamic: Block): string {
  const it = attr(dynamic.body, "iterator");
  return it?.expr.t === "var" ? it.expr.name : (dynamic.labels[0] ?? "");
}

/* ---------------- traversals ---------------- */

type Op = { kind: "get"; name: string } | { kind: "index"; index: Expr } | { kind: "splat" };

interface Chain {
  root: string;
  ops: Op[];
  /** Leading attribute names (for var.x, module.a.b, aws_vpc.main). */
  steps: string[];
  /** Address-style text: aws_subnet.private[0].id, aws_subnet.private[*].id */
  text: string;
  indexes: Expr[];
}

function flatten(e: Expr): Chain {
  const ops: Op[] = [];
  let cur = e;
  for (;;) {
    if (cur.t === "get") ops.unshift({ kind: "get", name: cur.name });
    else if (cur.t === "index") ops.unshift({ kind: "index", index: cur.index });
    else if (cur.t === "splat") ops.unshift({ kind: "splat" });
    else break;
    cur = cur.obj;
  }
  const root = cur.t === "var" ? cur.name : "";
  const steps: string[] = [];
  for (const op of ops) {
    if (op.kind !== "get") break;
    steps.push(op.name);
  }
  let text = root;
  for (const op of ops) {
    if (op.kind === "get") text += `.${op.name}`;
    else if (op.kind === "splat") text += "[*]";
    else if (op.index.t === "lit") text += `[${JSON.stringify(op.index.v)}]`;
    else text += "[*]";
  }
  return { root, ops, steps, text, indexes: ops.flatMap((o) => (o.kind === "index" ? [o.index] : [])) };
}

/* ---------------- operators and functions ---------------- */

function binary(op: string, a: Value, b: Value): Value {
  const x = a as number;
  const y = b as number;
  switch (op) {
    case "+":
      return Number(x) + Number(y);
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return x / y;
    case "%":
      return x % y;
    case "==":
      return JSON.stringify(a) === JSON.stringify(b);
    case "!=":
      return JSON.stringify(a) !== JSON.stringify(b);
    case "<":
      return x < y;
    case ">":
      return x > y;
    case "<=":
      return x <= y;
    case ">=":
      return x >= y;
    case "&&":
      return !!a && !!b;
    case "||":
      return !!a || !!b;
  }
  return new Unknown();
}

/** Functions that keep partly unknown values (they only arrange them). */
const ARRANGING = new Set(["jsonencode", "concat", "merge", "tolist", "toset", "tomap", "flatten", "compact", "distinct", "coalesce", "coalescelist", "try", "join", "format", "tostring", "list", "map"]);

function callFunction(name: string, args: Value[]): Value {
  const fn = name.replace(/^provider::[^:]+::/, "");
  if (!ARRANGING.has(fn) && !args.every(known)) return new Unknown(args.flatMap((a) => refsIn(a)));
  const [a, b, c] = args;
  const list = (v: Value): Value[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);
  switch (fn) {
    case "jsonencode":
      return isUnknown(a) ? a : JSON.stringify(plain(a));
    case "jsondecode":
      try {
        return JSON.parse(String(a));
      } catch {
        return new Unknown();
      }
    case "lower":
      return String(a).toLowerCase();
    case "upper":
      return String(a).toUpperCase();
    case "title":
      return String(a).replace(/\b\w/g, (m) => m.toUpperCase());
    case "trimspace":
      return String(a).trim();
    case "trimprefix":
      return String(a).startsWith(String(b)) ? String(a).slice(String(b).length) : a;
    case "trimsuffix":
      return String(a).endsWith(String(b)) ? String(a).slice(0, -String(b).length) : a;
    case "replace": {
      const re = String(b).match(/^\/(.*)\/$/);
      return re ? String(a).replace(new RegExp(re[1], "g"), String(c)) : String(a).split(String(b)).join(String(c));
    }
    case "substr":
      return String(a).substr(Number(b), Number(c) < 0 ? undefined : Number(c));
    case "format": {
      let i = 1;
      return String(str(a)).replace(/%(%|[-+ #0-9.]*[sdvfqt])/g, (m) => {
        if (m === "%%") return "%";
        const v = args[i++];
        if (/q$/.test(m)) return JSON.stringify(str(v));
        return str(v);
      });
    }
    case "join":
      return list(b).map(str).join(str(a));
    case "split":
      return String(b).split(String(a));
    case "concat":
      return args.flatMap((x) => (isUnknown(x) ? [x] : list(x)));
    case "merge":
      if (args.some(isUnknown)) return new Unknown(args.flatMap((x) => refsIn(x)));
      return Object.assign({}, ...args.filter((x) => x && typeof x === "object"));
    case "flatten": {
      const flat = (v: Value): Value[] => (Array.isArray(v) ? v.flatMap(flat) : [v]);
      return flat(a);
    }
    case "compact":
      return list(a).filter((x) => x !== "" && x !== null);
    case "distinct":
    case "toset":
      return isUnknown(a) ? a : [...new Map(list(a).map((x) => [JSON.stringify(plain(x)), x])).values()];
    case "tolist":
    case "list":
      return isUnknown(a) ? a : list(a);
    case "tomap":
    case "map":
      return a;
    case "coalesce":
      return args.find((x) => x !== null && x !== "" && !isUnknown(x)) ?? new Unknown(args.flatMap((x) => refsIn(x)));
    case "coalescelist":
      return args.find((x) => Array.isArray(x) && x.length) ?? [];
    case "try":
      return args.find((x) => !isUnknown(x)) ?? args[args.length - 1];
    case "length":
      return typeof a === "string" ? a.length : list(a).length;
    case "keys":
      return a && typeof a === "object" ? Object.keys(a).sort() : [];
    case "values":
      return list(a);
    case "lookup": {
      const v = a && typeof a === "object" ? (a as Record<string, Value>)[String(b)] : undefined;
      return v === undefined ? (args.length > 2 ? c : new Unknown()) : v;
    }
    case "element": {
      const l = list(a);
      return l.length ? l[Number(b) % l.length] : new Unknown();
    }
    case "contains":
      return list(a).some((x) => JSON.stringify(x) === JSON.stringify(b));
    case "tostring":
      return isUnknown(a) ? a : str(a);
    case "tonumber":
      return Number(a);
    case "tobool":
      return a === true || a === "true";
    case "min":
      return Math.min(...(args as number[]));
    case "max":
      return Math.max(...(args as number[]));
    case "abs":
      return Math.abs(Number(a));
    case "startswith":
      return String(a).startsWith(String(b));
    case "endswith":
      return String(a).endsWith(String(b));
    case "basename":
      return basename(String(a));
    case "dirname":
      return dirname(String(a));
  }
  return new Unknown(args.flatMap((x) => refsIn(x)));
}

function compactObject(o: Record<string, unknown>) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/* ---------------- loading ---------------- */

class Loader {
  readonly dirs = new Map<string, ParsedDir>();
  /** Every variable file by path, for the varFiles setting. */
  readonly varFiles = new Map<string, Body>();

  constructor(files: TfSourceFile[], opts: LoadOptions) {
    for (const f of files) {
      const isTf = TF_FILE.test(f.path);
      const isVars = ANY_TFVARS_FILE.test(f.path);
      if (!isTf && !isVars) continue;
      let body: Body;
      try {
        const json = /\.json$/i.test(f.path);
        body = isTf ? (json ? parseTfJson(f.text) : parseHcl(f.text)) : json ? parseTfvarsJson(f.text) : parseHcl(f.text);
      } catch (err) {
        opts.warn?.(`infra: could not parse ${f.path}: ${(err as Error).message}`);
        continue;
      }
      const dir = dirname(f.path);
      if (!this.dirs.has(dir)) this.dirs.set(dir, { dir, files: [], tfvars: [] });
      if (isTf) this.dirs.get(dir)!.files.push({ path: f.path, body });
      else {
        this.varFiles.set(f.path, body);
        if (TFVARS_FILE.test(f.path)) this.dirs.get(dir)!.tfvars.push({ path: f.path, body });
      }
    }
    for (const [dir, d] of this.dirs) if (!d.files.length) this.dirs.delete(dir);
  }

  /** Directories called as a module from another directory are not roots. */
  roots(): ParsedDir[] {
    const called = new Set<string>();
    for (const d of this.dirs.values()) {
      for (const f of d.files) {
        for (const b of f.body.blocks) {
          if (b.type !== "module") continue;
          const src = attr(b.body, "source")?.expr;
          if (src?.t === "lit" && typeof src.v === "string" && /^\.\.?(\/|$)/.test(src.v)) {
            const target = join(d.dir, src.v);
            if (target !== d.dir) called.add(target);
          }
        }
      }
    }
    return [...this.dirs.values()].filter((d) => !called.has(d.dir)).sort((a, b) => a.dir.localeCompare(b.dir));
  }
}

/**
 * Read Terraform source files into one resource list per root module (a directory that no
 * other directory calls as a module). Local modules are followed; registry and git modules
 * are listed as module calls without their contents.
 */
export function loadTerraform(files: TfSourceFile[], opts: LoadOptions = {}): TfRoot[] {
  const loader = new Loader(files, opts);
  const roots: TfRoot[] = [];
  for (const dir of loader.roots()) {
    // terraform.tfvars, then *.auto.tfvars in name order, then the configured var files: later wins.
    const tfvars = new Map<string, Value>();
    const auto = [...dir.tfvars].sort((a, b) => Number(/\.auto\./.test(a.path)) - Number(/\.auto\./.test(b.path)) || a.path.localeCompare(b.path));
    const wanted = Array.isArray(opts.varFiles) ? opts.varFiles : (opts.varFiles?.[dir.dir] ?? []);
    const extra = wanted.map((f) => ({ path: join(dir.dir, f), body: loader.varFiles.get(join(dir.dir, f)) }));
    for (const x of extra) if (!x.body && !Array.isArray(opts.varFiles)) opts.warn?.(`infra: var file ${x.path} for ${dir.dir} not found`);
    const scratch = new ModuleInstance(loader, { dir: dir.dir, files: [], tfvars: [] }, "", new Map(), new Map(), 0);
    for (const v of [...auto, ...extra]) for (const a of v.body?.attrs ?? []) tfvars.set(a.name, scratch.eval(a.expr));
    const mod = new ModuleInstance(loader, dir, "", new Map(), tfvars, 0);
    const resources: TfResource[] = [];
    const modules: TfModuleCall[] = [];
    mod.collect(resources, modules);
    roots.push({ dir: dir.dir, resources, modules, files: dir.files.map((f) => f.path) });
  }
  return roots;
}

/**
 * With several root modules (envs/prod, envs/staging) only one should be matched with the code
 * and Kubernetes layers by name (datastore:postgresql, service:orders), or every environment's
 * database merges into one node. The configured one, else one that looks like production, else
 * the only one.
 */
export function primaryRoot(dirs: string[], configured?: string): string | undefined {
  if (configured !== undefined) return dirs.find((d) => d === configured.replace(/^\.\//, "").replace(/\/+$/, "") || (configured === "." && d === "."));
  if (dirs.length === 1) return dirs[0];
  const prod = dirs.filter((d) => /(^|[/_-])(prod|production|prd|live)$/i.test(d));
  return prod.length === 1 ? prod[0] : undefined;
}
