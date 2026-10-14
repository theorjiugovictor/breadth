import type { Node } from "web-tree-sitter";
import type { Port } from "@breadth/schema";
import { emptyModel, type Def, type FileModel } from "./model.js";
import { argIdentifiers, calleeParts, fingerprint, firstLine, stringLiteral, truncate, typeParts } from "./util.js";

const LOOPS = new Set([
  "for_statement",
  "while_statement",
  "list_comprehension",
  "set_comprehension",
  "dictionary_comprehension",
  "generator_expression",
]);
const CONDITIONALS = new Set(["if_statement", "elif_clause", "else_clause", "conditional_expression", "except_clause", "case_clause"]);

interface Ctx {
  def: string; // '' = module level
  cls?: string; // qual of enclosing class (for methods)
  inLoop: boolean;
  conditional: boolean;
  guarded?: boolean;
  /** Names declared `global` in the current function. */
  globalsDeclared: Set<string>;
  /** Names bound locally in the current function (params + assignments). */
  locals: Set<string>;
  /** Known types of local names. */
  types: Map<string, string[]>;
}

export function extractPython(path: string, root: Node): FileModel {
  const m = emptyModel(path, "python");
  m.lines = root.endPosition.row + 1;
  m.doc = docstring(root);

  const globalNames = new Set<string>();
  /** Names imported at module level: may refer to another module's shared state. */
  const importedNames = new Set<string>();
  const valueRefs = new Set<string>();
  const tracked = (name: string, ctx: Ctx) => (globalNames.has(name) || importedNames.has(name)) && !ctx.locals.has(name);

  // Pass 1: module-level globals and imports (so function bodies can tell globals from locals).
  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    if (stmt.type === "expression_statement") {
      const a = stmt.namedChildren[0];
      if (a?.type === "assignment") {
        const left = a.childForFieldName("left");
        const right = a.childForFieldName("right");
        if (left?.type === "identifier") {
          const name = left.text;
          if (name === "__all__") continue;
          globalNames.add(name);
          m.globals.push({
            name,
            line: stmt.startPosition.row + 1,
            mutable: isMutableValue(right),
            init: right?.type === "call" ? calleeParts(right.childForFieldName("function")!, "attribute", "object", "attribute") : undefined,
            constantLike: /^[A-Z][A-Z0-9_]*$/.test(name),
          });
        }
      }
    }
  }

  const visit = (node: Node, ctx: Ctx) => {
    switch (node.type) {
      case "import_statement":
        for (const c of node.namedChildren) {
          if (!c) continue;
          if (c.type === "dotted_name") {
            // `import a.b` binds `a`, but calls look like a.b.f(): bind the full dotted name too.
            const full = c.text;
            m.imports.push({ local: full, module: full, imported: "*", line: node.startPosition.row + 1 });
            if (!ctx.def) importedNames.add(full.split(".")[0]);
            if (full.includes(".")) m.imports.push({ local: full.split(".")[0], module: full.split(".")[0], imported: "*", line: node.startPosition.row + 1 });
          } else if (c.type === "aliased_import") {
            const name = c.childForFieldName("name")?.text ?? "";
            const alias = c.childForFieldName("alias")?.text ?? name;
            m.imports.push({ local: alias, module: name, imported: "*", line: node.startPosition.row + 1 });
            if (!ctx.def) importedNames.add(alias);
          }
        }
        return;
      case "import_from_statement": {
        const mod = node.childForFieldName("module_name")?.text ?? "";
        for (const c of node.namedChildren) {
          if (!c || c === node.childForFieldName("module_name")) continue;
          if (c.type === "dotted_name") {
            m.imports.push({ local: c.text, module: mod, imported: c.text, line: node.startPosition.row + 1 });
            if (!ctx.def) importedNames.add(c.text);
          } else if (c.type === "aliased_import") {
            const name = c.childForFieldName("name")?.text ?? "";
            const alias = c.childForFieldName("alias")?.text ?? name;
            m.imports.push({ local: alias, module: mod, imported: name, line: node.startPosition.row + 1 });
            if (!ctx.def) importedNames.add(alias);
          } else if (c.type === "wildcard_import") {
            m.imports.push({ local: "*", module: mod, imported: "*", line: node.startPosition.row + 1 });
          }
        }
        return;
      }
      case "decorated_definition": {
        const decoratorNodes = node.namedChildren.filter((c) => c?.type === "decorator");
        const decorators = decoratorNodes.map((c) => c!.text.replace(/^@/, ""));
        // @click.option(callback=validate): names used inside decorators are references
        for (const d of decoratorNodes) for (const id of d!.descendantsOfType("identifier")) if (id) valueRefs.add(id.text);
        const def = node.childForFieldName("definition");
        if (def) visitDef(def, ctx, decorators);
        // Decorator expressions themselves may call things (e.g. @app.route(...)): skip, they run at import.
        return;
      }
      case "function_definition":
      case "class_definition":
        visitDef(node, ctx, []);
        return;
      case "expression_statement": {
        // class body `name: Type` annotations describe instance attributes
        const a = node.namedChildren[0];
        if (ctx.cls && ctx.def === ctx.cls && a?.type === "assignment" && a.childForFieldName("left")?.type === "identifier") {
          const t = typeParts(a.childForFieldName("type")?.text);
          if (t) m.attrTypes[`${ctx.cls}.${a.childForFieldName("left")!.text}`] = t;
        }
        break;
      }
      case "try_statement": {
        const body = node.childForFieldName("body");
        for (const c of node.namedChildren) if (c) visit(c, c === body ? { ...ctx, guarded: true } : ctx);
        return;
      }
      case "global_statement":
        for (const c of node.namedChildren) if (c?.type === "identifier") ctx.globalsDeclared.add(c.text);
        return;
      case "call": {
        const fn = node.childForFieldName("function");
        const args = node.childForFieldName("arguments");
        if (fn) {
          const parts = calleeParts(fn, "attribute", "object", "attribute");
          if (parts.length) {
            const first = args?.namedChildren[0];
            m.calls.push({
              from: ctx.def,
              parts,
              line: node.startPosition.row + 1,
              inLoop: ctx.inLoop,
              conditional: ctx.conditional,
              guarded: ctx.guarded || undefined,
              firstArg: first ? stringLiteral(first) : undefined,
              receiver: parts.length > 1 ? ctx.types.get(parts[0]) : undefined,
              argNames: argIdentifiers(args),
            });
            // obj.append(x) / obj.update(...) on a global mutates it.
            if (parts.length === 2 && tracked(parts[0], ctx) && ctx.def && MUTATORS.has(parts[1])) {
              m.globalAccess.push({ from: ctx.def, name: parts[0], mode: "write", line: node.startPosition.row + 1 });
            }
          }
          // the callee itself is not a value reference; its receiver (obj in obj.f()) is
          if (fn.type !== "identifier") visit(fn, ctx);
        }
        if (args) visit(args, ctx);
        return;
      }
      case "assignment":
      case "augmented_assignment": {
        const left = node.childForFieldName("left");
        const rhs = node.childForFieldName("right");
        if (ctx.def && left && rhs) {
          // Remember types: x = Foo(...), self.x = Foo(...), self.x = typed_param
          const t =
            rhs.type === "call"
              ? calleeParts(rhs.childForFieldName("function")!, "attribute", "object", "attribute")
              : rhs.type === "identifier"
                ? ctx.types.get(rhs.text)
                : undefined;
          const annotated = typeParts(node.childForFieldName("type")?.text);
          const type = annotated ?? (t?.length && !t.includes("?") ? t : undefined);
          if (type && left.type === "identifier") ctx.types.set(left.text, type);
          if (type && left.type === "attribute" && left.childForFieldName("object")?.text === "self" && ctx.cls) {
            m.attrTypes[`${ctx.cls}.${left.childForFieldName("attribute")!.text}`] = type;
          }
        }
        if (ctx.def && left) {
          // x = ... inside a function: local unless declared global.
          if (left.type === "identifier") {
            if (ctx.globalsDeclared.has(left.text) && (globalNames.has(left.text) || importedNames.has(left.text))) {
              m.globalAccess.push({ from: ctx.def, name: left.text, mode: "write", line: node.startPosition.row + 1 });
            } else if (node.type === "assignment") {
              ctx.locals.add(left.text);
            }
          } else if (left.type === "subscript" || left.type === "attribute") {
            // CACHE[k] = v / STATE.x = v mutate a global container.
            const base = leftmostIdentifier(left);
            if (base && tracked(base, ctx)) {
              m.globalAccess.push({ from: ctx.def, name: base, mode: "write", line: node.startPosition.row + 1 });
            }
          }
        }
        // Visit the right-hand side for calls / reads, but not the target identifier.
        const right = node.childForFieldName("right");
        if (right) visit(right, ctx);
        // annotations reference things too: Annotated[str, AfterValidator(check)]
        const annotation = node.childForFieldName("type");
        if (annotation) visit(annotation, ctx);
        if (left && left.type !== "identifier") visitChildren(left, ctx);
        return;
      }
      case "attribute": {
        // Only the object can be a variable reference; `.attr` is a property name.
        const obj = node.childForFieldName("object");
        if (obj) visit(obj, ctx);
        return;
      }
      case "keyword_argument": {
        const value = node.childForFieldName("value");
        if (value) visit(value, ctx);
        return;
      }
      case "identifier": {
        const name = node.text;
        valueRefs.add(name);
        if (ctx.def && tracked(name, ctx)) {
          m.globalAccess.push({ from: ctx.def, name, mode: "read", line: node.startPosition.row + 1 });
        }
        return;
      }
    }

    const nextCtx = LOOPS.has(node.type)
      ? { ...ctx, inLoop: true }
      : CONDITIONALS.has(node.type)
        ? { ...ctx, conditional: true }
        : ctx;
    visitChildren(node, nextCtx);
  };

  const visitChildren = (node: Node, ctx: Ctx) => {
    for (const c of node.namedChildren) if (c) visit(c, ctx);
  };

  const visitDef = (node: Node, ctx: Ctx, decorators: string[]) => {
    const name = node.childForFieldName("name")?.text;
    if (!name) return;
    const qual = ctx.def ? `${ctx.def}.${name}` : name;
    const body = node.childForFieldName("body");
    if (node.type === "class_definition") {
      const bases = node.childForFieldName("superclasses")?.namedChildren.filter((c) => c && c.type !== "keyword_argument").map((c) => c!.text) ?? [];
      m.defs.push({
        qual,
        name,
        type: "class",
        parentQual: ctx.def || undefined,
        params: [],
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        doc: body ? docstring(body) : undefined,
        bases,
        decorators: decorators.length ? decorators : undefined,
      });
      if (body) visitChildren(body, { def: qual, cls: qual, inLoop: false, conditional: false, globalsDeclared: new Set(), locals: new Set(), types: new Map() });
      return;
    }

    const isMethod = !!ctx.cls && ctx.def === ctx.cls;
    const params = parseParams(node.childForFieldName("parameters"), isMethod && !decorators.includes("staticmethod"));
    const ret = node.childForFieldName("return_type")?.text;
    const def: Def = {
      qual,
      name,
      type: isMethod ? "method" : "function",
      parentQual: ctx.def || undefined,
      params,
      returns: ret,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      doc: body ? docstring(body) : undefined,
      isAsync: node.children[0]?.type === "async",
      decorators: decorators.length ? decorators : undefined,
    };
    if (body) {
      // skip the docstring so documented and undocumented copies still match
      const first = body.namedChildren[0];
      const doc = first?.type === "expression_statement" && first.namedChildren[0]?.type === "string" ? first : null;
      const fp = fingerprint(body, doc);
      if (fp.size >= MIN_FINGERPRINT) def.fingerprint = fp;
    }
    m.defs.push(def);
    const locals = new Set(params.map((p) => p.name.replace(/^\*+/, "")));
    locals.add("self");
    locals.add("cls");
    // closures see the enclosing function's variables
    const types = new Map<string, string[]>(ctx.def && !isMethod ? ctx.types : []);
    for (const p of params) {
      const t = typeParts(p.type);
      if (t) types.set(p.name, t);
    }
    if (body) visitChildren(body, { def: qual, cls: isMethod ? ctx.cls : undefined, inLoop: false, conditional: false, globalsDeclared: new Set(), locals, types });
  };

  visitChildren(root, { def: "", inLoop: false, conditional: false, globalsDeclared: new Set(), locals: new Set(), types: new Map() });

  for (const d of m.defs) if (!d.parentQual && !d.name.startsWith("_")) m.exports.push(d.name);
  m.valueRefs = [...valueRefs];
  const byQual = new Map(m.defs.map((d) => [d.qual, d]));
  for (const d of m.defs) {
    const parent = d.parentQual ? byQual.get(d.parentQual) : undefined;
    const privateName = d.name.startsWith("_") && !/^__\w+__$/.test(d.name);
    if (privateName || (parent && parent.type !== "class")) d.visibility = "internal";
    else if (parent?.visibility === "internal") d.visibility = "internal";
    else d.visibility = "public";
  }
  return m;
}

/** Bodies smaller than this (in syntax nodes) are too generic to call duplicates. */
export const MIN_FINGERPRINT = 30;

const MUTATORS = new Set(["append", "extend", "insert", "pop", "remove", "clear", "update", "add", "discard", "setdefault", "popitem", "sort", "reverse", "set", "put", "delete"]);

function parseParams(node: Node | null, dropFirst: boolean): Port[] {
  if (!node) return [];
  const ports: Port[] = [];
  for (const p of node.namedChildren) {
    if (!p) continue;
    let port: Port | undefined;
    switch (p.type) {
      case "identifier":
        port = { name: p.text };
        break;
      case "typed_parameter": {
        const id = p.namedChildren.find((c) => c && (c.type === "identifier" || c.type.endsWith("splat_pattern")));
        port = { name: id?.text ?? p.text, type: p.childForFieldName("type")?.text };
        break;
      }
      case "default_parameter":
        port = { name: p.childForFieldName("name")?.text ?? "?", optional: true, default: truncate(p.childForFieldName("value")?.text ?? "", 40) };
        break;
      case "typed_default_parameter":
        port = {
          name: p.childForFieldName("name")?.text ?? "?",
          type: p.childForFieldName("type")?.text,
          optional: true,
          default: truncate(p.childForFieldName("value")?.text ?? "", 40),
        };
        break;
      case "list_splat_pattern":
      case "dictionary_splat_pattern":
        port = { name: p.text, optional: true };
        break;
    }
    if (port) ports.push(clean(port));
  }
  if (dropFirst && ports.length && (ports[0].name === "self" || ports[0].name === "cls")) ports.shift();
  return ports;
}

function clean(p: Port): Port {
  for (const k of Object.keys(p) as (keyof Port)[]) if (p[k] === undefined) delete p[k];
  return p;
}

function docstring(block: Node): string | undefined {
  const first = block.namedChildren[0];
  if (first?.type !== "expression_statement") return undefined;
  const s = first.namedChildren[0];
  if (s?.type !== "string") return undefined;
  const text = s.text.replace(/^[rubfRUBF]*("""|'''|"|')/, "").replace(/("""|'''|"|')$/, "");
  return firstLine(text);
}

function isMutableValue(n: Node | null): boolean {
  if (!n) return false;
  if (["dictionary", "list", "set", "dictionary_comprehension", "list_comprehension", "set_comprehension"].includes(n.type)) return true;
  if (n.type === "call") {
    const fn = n.childForFieldName("function")?.text ?? "";
    return /^(dict|list|set|defaultdict|OrderedDict|Counter|deque|collections\.\w+|[A-Z]\w*)$/.test(fn);
  }
  return false;
}

function leftmostIdentifier(n: Node): string | undefined {
  let cur: Node | null = n;
  while (cur && (cur.type === "subscript" || cur.type === "attribute")) {
    cur = cur.childForFieldName(cur.type === "subscript" ? "value" : "object");
  }
  return cur?.type === "identifier" ? cur.text : undefined;
}
