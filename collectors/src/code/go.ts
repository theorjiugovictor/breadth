import type { Node } from "web-tree-sitter";
import type { Port } from "@breadth/schema";
import { emptyModel, type Def, type FileModel } from "./model.js";
import { MIN_FINGERPRINT } from "./python.js";
import { argIdentifiers, argValue, calleeParts, fingerprint, firstLine, namedArgs, stringLiteral, truncate } from "./util.js";

const LOOPS = new Set(["for_statement"]);
const CONDITIONALS = new Set(["if_statement", "expression_case", "type_case", "communication_case", "default_case"]);

interface Ctx {
  def: string;
  /** Receiver type of the current method (Store in `func (s *Store) Save()`). */
  cls?: string;
  /** Receiver variable: calls on it are calls on `self`. */
  recv?: string;
  inLoop: boolean;
  conditional: boolean;
  /** Inside `x, err := f()`: the error is looked at. */
  guarded?: boolean;
  locals: Set<string>;
  types: Map<string, string[]>;
}

/** Go's package name for an import path: github.com/segmentio/kafka-go -> kafka, gopkg.in/yaml.v3 -> yaml. */
export function goPackageName(importPath: string): string {
  const parts = importPath.split("/");
  let last = parts[parts.length - 1];
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts[parts.length - 2];
  return last.replace(/\.v\d+$/, "").replace(/^go-|-go$/g, "").replace(/[^A-Za-z0-9_]/g, "");
}

/** Type name parts: *sql.DB -> ['sql','DB'], []Order -> undefined, Store -> ['Store']. */
function goType(n: Node | null | undefined): string[] | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case "pointer_type":
      return goType(n.namedChildren[0]);
    case "type_identifier":
      return [n.text];
    case "qualified_type": {
      const pkg = n.childForFieldName("package")?.text;
      const name = n.childForFieldName("name")?.text;
      return pkg && name ? [pkg, name] : undefined;
    }
    case "generic_type":
      return goType(n.childForFieldName("type"));
  }
  return undefined;
}

/** The type an expression produces, when it is obvious: &Store{}, Store{}, NewStore(), pkg.NewClient(). */
function exprType(n: Node | null | undefined): string[] | undefined {
  if (!n) return undefined;
  if (n.type === "unary_expression") return exprType(n.childForFieldName("operand"));
  if (n.type === "composite_literal") return goType(n.childForFieldName("type"));
  if (n.type === "call_expression") {
    const fn = n.childForFieldName("function");
    const parts = fn ? calleeParts(fn, "selector_expression", "operand", "field") : [];
    const last = parts[parts.length - 1] ?? "";
    // constructors by convention: NewStore() -> Store, kafka.NewWriter() -> kafka.Writer
    const ctor = last.match(/^New([A-Z]\w*)$/);
    if (ctor) return [...parts.slice(0, -1), ctor[1]];
    // sql.Open(...) -> the sql package's client
    if (parts.length === 2) return parts;
  }
  return undefined;
}

/** Fields of a struct literal argument: &s3.PutObjectInput{Bucket: aws.String("x")} -> { Bucket: "x" }. */
function structArgs(args: Node | null): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const a of args?.namedChildren ?? []) {
    let lit = a;
    if (lit?.type === "unary_expression") lit = lit.childForFieldName("operand");
    if (lit?.type !== "composite_literal") continue;
    for (const el of lit.childForFieldName("body")?.namedChildren ?? []) {
      if (el?.type !== "keyed_element") continue;
      const [k, v] = el.namedChildren;
      let value = v?.namedChildren[0] ?? v;
      // aws.String(x), aws.Int(x): the value inside
      if (value?.type === "call_expression") value = value.childForFieldName("arguments")?.namedChildren[0] ?? value;
      const key = (k?.namedChildren[0] ?? k)?.text;
      const val = argValue(value);
      if (key && val) out[key] = val;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function extractGo(path: string, root: Node): FileModel {
  const m = emptyModel(path, "go");
  m.lines = root.endPosition.row + 1;
  const globalNames = new Set<string>();
  const valueRefs = new Set<string>();
  const defs = new Map<string, Def>();
  const constants: Record<string, string> = {};

  // Pass 1: imports, package-level variables, types (so methods can find their receiver's fields).
  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    if (stmt.type === "import_declaration") {
      for (const spec of stmt.descendantsOfType("import_spec")) {
        if (!spec) continue;
        const p = stringLiteral(spec.childForFieldName("path")!);
        if (!p) continue;
        const alias = spec.childForFieldName("name")?.text;
        if (alias === "_") continue;
        m.imports.push({ local: alias === "." ? "*" : (alias ?? goPackageName(p)), module: p, imported: "*", line: spec.startPosition.row + 1 });
      }
    } else if (stmt.type === "var_declaration" || stmt.type === "const_declaration") {
      for (const spec of stmt.namedChildren) {
        if (spec?.type !== "var_spec" && spec?.type !== "const_spec") continue;
        const names = spec.namedChildren.filter((c) => c?.type === "identifier");
        const values = spec.childForFieldName("value")?.namedChildren ?? [];
        names.forEach((n, i) => {
          if (!n || n.text === "_") return;
          const value = values[i];
          const v = argValue(value);
          if (v && !v.startsWith("id:")) constants[n.text] = v;
          if (stmt.type === "const_declaration") return;
          globalNames.add(n.text);
          const init = value ? exprType(value) : goType(spec.childForFieldName("type"));
          m.globals.push({ name: n.text, line: spec.startPosition.row + 1, mutable: !init || /^(map|\[\])/.test(value?.text ?? ""), constantLike: false, init });
        });
      }
    } else if (stmt.type === "type_declaration") {
      for (const spec of stmt.namedChildren) {
        if (spec?.type !== "type_spec") continue;
        const name = spec.childForFieldName("name")?.text;
        const type = spec.childForFieldName("type");
        if (!name || !type) continue;
        const d: Def = { qual: name, name, type: "class", params: [], line: spec.startPosition.row + 1, endLine: spec.endPosition.row + 1, doc: docBefore(stmt) };
        if (type.type === "struct_type") {
          const embedded: string[] = [];
          for (const f of type.descendantsOfType("field_declaration")) {
            if (!f) continue;
            const ftype = goType(f.childForFieldName("type"));
            const fname = f.childForFieldName("name")?.text;
            if (fname && ftype) m.attrTypes[`${name}.${fname}`] = ftype;
            else if (!fname && ftype) embedded.push(ftype.join("."));
          }
          if (embedded.length) d.bases = embedded;
        }
        defs.set(name, d);
        m.defs.push(d);
      }
    }
  }

  const visit = (node: Node, ctx: Ctx) => {
    switch (node.type) {
      case "function_declaration":
      case "method_declaration":
        visitFunc(node, ctx);
        return;
      case "call_expression": {
        const fn = node.childForFieldName("function");
        const args = node.childForFieldName("arguments");
        if (fn && fn.type !== "func_literal") {
          let parts = calleeParts(fn, "selector_expression", "operand", "field");
          if (parts.length) {
            if (ctx.recv && parts[0] === ctx.recv && parts.length > 1) parts = ["self", ...parts.slice(1)];
            const first = args?.namedChildren[0];
            m.calls.push({
              from: ctx.def,
              parts,
              line: node.startPosition.row + 1,
              inLoop: ctx.inLoop,
              conditional: ctx.conditional,
              guarded: ctx.guarded || undefined,
              // db.ExecContext(ctx, "INSERT ..."): the context comes first
              firstArg: (first ? (stringLiteral(first) ?? suffixLiteral(first)) : undefined) ?? (args?.namedChildren[1] ? stringLiteral(args.namedChildren[1]) : undefined),
              receiver: parts.length > 1 && parts[0] !== "self" ? ctx.types.get(parts[0]) : undefined,
              argNames: argIdentifiers(args),
              kwargs: { ...namedArgs(args), ...structArgs(args) },
            });
          }
          if (fn.type === "selector_expression") {
            const operand = fn.childForFieldName("operand");
            if (operand) visit(operand, ctx);
          }
        } else if (fn) visit(fn, ctx);
        if (args) visit(args, ctx);
        return;
      }
      case "short_var_declaration":
      case "assignment_statement": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        const names = left?.namedChildren ?? [];
        // x, err := f(): the call's error is checked (or at least kept)
        const checksError = names.some((n) => n?.text === "err");
        if (ctx.def) {
          names.forEach((n, i) => {
            if (n?.type !== "identifier") {
              // CACHE[k] = v, state.x = v on a package-level variable
              const base = n?.text.match(/^(\w+)/)?.[1];
              if (base && globalNames.has(base) && !ctx.locals.has(base)) m.globalAccess.push({ from: ctx.def, name: base, mode: "write", line: node.startPosition.row + 1 });
              return;
            }
            if (node.type === "short_var_declaration") {
              ctx.locals.add(n.text);
              const t = exprType(right?.namedChildren[i]);
              if (t) ctx.types.set(n.text, t);
            } else if (globalNames.has(n.text) && !ctx.locals.has(n.text)) {
              m.globalAccess.push({ from: ctx.def, name: n.text, mode: "write", line: node.startPosition.row + 1 });
            }
          });
        }
        if (right) visit(right, checksError ? { ...ctx, guarded: true } : ctx);
        return;
      }
      case "var_declaration":
        if (ctx.def) {
          for (const spec of node.descendantsOfType("var_spec")) {
            const t = goType(spec?.childForFieldName("type")) ?? exprType(spec?.childForFieldName("value")?.namedChildren[0]);
            for (const n of spec?.namedChildren.filter((c) => c?.type === "identifier") ?? []) {
              ctx.locals.add(n!.text);
              if (t) ctx.types.set(n!.text, t);
            }
          }
        }
        break;
      case "range_clause":
        for (const n of node.childForFieldName("left")?.namedChildren ?? []) if (n?.type === "identifier") ctx.locals.add(n.text);
        break;
      case "identifier": {
        valueRefs.add(node.text);
        if (ctx.def && globalNames.has(node.text) && !ctx.locals.has(node.text)) m.globalAccess.push({ from: ctx.def, name: node.text, mode: "read", line: node.startPosition.row + 1 });
        return;
      }
    }
    const next = LOOPS.has(node.type) ? { ...ctx, inLoop: true } : CONDITIONALS.has(node.type) ? { ...ctx, conditional: true } : ctx;
    for (const c of node.namedChildren) if (c) visit(c, next);
  };

  const visitFunc = (node: Node, ctx: Ctx) => {
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    let cls: string | undefined;
    let recv: string | undefined;
    if (node.type === "method_declaration") {
      const r = node.childForFieldName("receiver")?.namedChildren.find((c) => c?.type === "parameter_declaration");
      cls = goType(r?.childForFieldName("type"))?.[0];
      recv = r?.childForFieldName("name")?.text;
    }
    const qual = cls ? `${cls}.${name}` : name;
    if (defs.has(qual)) return;
    const params = goParams(node.childForFieldName("parameters"));
    const body = node.childForFieldName("body");
    const d: Def = {
      qual,
      name,
      type: cls ? "method" : "function",
      // the receiver type may be declared in another file of the package
      parentQual: cls && defs.get(cls)?.type === "class" ? cls : undefined,
      params,
      returns: node.childForFieldName("result")?.text,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      doc: docBefore(node),
    };
    if (body) {
      const fp = fingerprint(body);
      if (fp.size >= MIN_FINGERPRINT) d.fingerprint = fp;
    }
    defs.set(qual, d);
    m.defs.push(d);
    const types = new Map<string, string[]>();
    for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
      const t = goType(p?.childForFieldName("type"));
      for (const n of p?.namedChildren.filter((c) => c?.type === "identifier") ?? []) if (t) types.set(n!.text, t);
    }
    const locals = new Set(params.map((p) => p.name));
    if (recv) locals.add(recv);
    if (body) visit(body, { def: qual, cls, recv, inLoop: false, conditional: false, locals, types });
  };

  for (const stmt of root.namedChildren) if (stmt) visit(stmt, { def: "", inLoop: false, conditional: false, locals: new Set(), types: new Map() });

  const exported = (n: string) => /^[A-Z]/.test(n);
  for (const d of m.defs) {
    d.visibility = exported(d.name) && (!d.parentQual || exported(d.parentQual)) ? "exported" : "internal";
    if (!d.parentQual && d.type !== "method" && exported(d.name)) m.exports.push(d.name);
  }
  // main() and init() run without being called
  for (const d of m.defs) if (!d.parentQual && (d.name === "main" || d.name === "init")) d.visibility = "exported";
  m.valueRefs = [...valueRefs];
  // short_var_declaration constants inside functions too: bucket := os.Getenv("BUCKET")
  for (const decl of root.descendantsOfType("short_var_declaration")) {
    const names = decl?.childForFieldName("left")?.namedChildren ?? [];
    const values = decl?.childForFieldName("right")?.namedChildren ?? [];
    names.forEach((n, i) => {
      const v = argValue(values[i]);
      if (n?.type === "identifier" && v && !v.startsWith("id:")) constants[n.text] = constants[n.text] === undefined || constants[n.text] === v ? v : "";
    });
  }
  m.constants = Object.fromEntries(Object.entries(constants).filter(([, v]) => v));
  return m;
}

/** baseURL + "/cart": the literal part, which carries the route or URL path. */
function suffixLiteral(n: Node): string | undefined {
  if (n.type !== "binary_expression") return undefined;
  const right = n.childForFieldName("right");
  const lit = right ? stringLiteral(right) : undefined;
  return lit?.startsWith("/") ? lit : undefined;
}

function goParams(list: Node | null): Port[] {
  const out: Port[] = [];
  for (const p of list?.namedChildren ?? []) {
    if (!p) continue;
    const type = p.childForFieldName("type")?.text;
    const names = p.namedChildren.filter((c) => c?.type === "identifier");
    if (!names.length) out.push({ name: `_${out.length}`, ...(type ? { type } : {}) });
    for (const n of names) out.push({ name: n!.text, ...(type ? { type: truncate(type, 60) } : {}), ...(p.type === "variadic_parameter_declaration" ? { optional: true } : {}) });
  }
  return out;
}

/** The `// comment` block right above a declaration. */
function docBefore(node: Node): string | undefined {
  let prev = node.previousNamedSibling;
  const lines: string[] = [];
  let row = node.startPosition.row;
  while (prev?.type === "comment" && prev.endPosition.row === row - 1) {
    lines.unshift(prev.text.replace(/^\/\/\s?|^\/\*|\*\/$/g, ""));
    row = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  return lines.length ? firstLine(lines.join(" ")) : undefined;
}
