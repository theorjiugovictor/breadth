import type { Node } from "web-tree-sitter";
import type { Port } from "@noodles/schema";
import { emptyModel, type Def, type FileModel, type Lang } from "./model.js";
import { argIdentifiers, calleeParts, firstLine, stringLiteral, truncate, typeParts } from "./util.js";

const LOOPS = new Set(["for_statement", "for_in_statement", "while_statement", "do_statement"]);
const CONDITIONALS = new Set(["if_statement", "else_clause", "ternary_expression", "switch_case", "switch_default", "catch_clause"]);
/** Callbacks passed to these run once per element. */
const ITERATING_METHODS = new Set(["map", "forEach", "filter", "reduce", "flatMap", "some", "every", "find", "findIndex", "reduceRight"]);
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "set", "delete", "clear", "add", "sort", "reverse", "fill", "assign"]);

interface Ctx {
  def: string;
  cls?: string;
  inLoop: boolean;
  conditional: boolean;
  guarded?: boolean;
  locals: Set<string>;
  types: Map<string, string[]>;
  /** Decorators seen just before the next class member. */
  pendingDecorators?: string[];
}

export function extractTypeScript(path: string, root: Node, lang: Lang): FileModel {
  const m = emptyModel(path, lang);
  m.lines = root.endPosition.row + 1;
  const globalNames = new Set<string>();
  const exported = new Set<string>();
  const importedNames = new Set<string>();
  const valueRefs = new Set<string>();
  const tracked = (name: string, ctx: Ctx) => (globalNames.has(name) || importedNames.has(name)) && !ctx.locals.has(name);

  // Pass 1: top-level mutable variables (shared module state).
  for (let stmt of root.namedChildren) {
    if (!stmt) continue;
    if (stmt.type === "export_statement") stmt = stmt.childForFieldName("declaration") ?? stmt;
    if (stmt.type !== "lexical_declaration" && stmt.type !== "variable_declaration") continue;
    const isConst = stmt.children[0]?.text === "const";
    for (const d of stmt.namedChildren) {
      if (d?.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name");
      const value = d.childForFieldName("value");
      if (name?.type !== "identifier") continue;
      if (value && (FUNCTION_VALUES.has(value.type) || isRequire(value))) continue;
      const init = newType(value) ?? callType(value);
      const mutable = !isConst || isMutableValue(value);
      if (!mutable && !init) continue;
      globalNames.add(name.text);
      m.globals.push({ name: name.text, line: d.startPosition.row + 1, mutable, constantLike: false, init });
    }
  }

  const addDef = (def: Def) => m.defs.push(def);

  const visit = (node: Node, ctx: Ctx) => {
    switch (node.type) {
      case "import_statement": {
        if (!ctx.def) {
          for (const id of node.descendantsOfType(["identifier"])) if (id) importedNames.add(id.text);
        }
        const source = stringLiteral(node.childForFieldName("source") ?? node.namedChildren[node.namedChildren.length - 1]!);
        if (!source) return;
        const clause = node.namedChildren.find((c) => c?.type === "import_clause");
        const line = node.startPosition.row + 1;
        if (!clause) {
          m.imports.push({ local: "", module: source, imported: "*", line });
          return;
        }
        for (const c of clause.namedChildren) {
          if (!c) continue;
          if (c.type === "identifier") m.imports.push({ local: c.text, module: source, imported: "default", line });
          else if (c.type === "namespace_import") {
            const id = c.namedChildren.find((x) => x?.type === "identifier");
            if (id) m.imports.push({ local: id.text, module: source, imported: "*", line });
          } else if (c.type === "named_imports") {
            for (const s of c.namedChildren) {
              if (s?.type !== "import_specifier") continue;
              const name = s.childForFieldName("name")?.text ?? "";
              const alias = s.childForFieldName("alias")?.text ?? name;
              m.imports.push({ local: alias, module: source, imported: name, line });
            }
          }
        }
        return;
      }
      case "export_statement": {
        const decl = node.childForFieldName("declaration");
        if (decl) {
          for (const n of declaredNames(decl)) exported.add(n);
          visit(decl, ctx);
          return;
        }
        // export { a, b as c } from './x'  — re-exports act like imports for resolution.
        const source = node.childForFieldName("source");
        const clause = node.namedChildren.find((c) => c?.type === "export_clause");
        if (clause) {
          for (const s of clause.namedChildren) {
            if (s?.type !== "export_specifier") continue;
            const name = s.childForFieldName("name")?.text ?? "";
            const alias = s.childForFieldName("alias")?.text ?? name;
            exported.add(alias);
            // export { local as publicName }: the local definition is exported too
            if (!source) exported.add(name);
            if (source) {
              const src = stringLiteral(source);
              if (src) m.imports.push({ local: alias, module: src, imported: name, line: node.startPosition.row + 1 });
            }
          }
          return;
        }
        if (source && node.children.some((c) => c?.type === "*")) {
          const src = stringLiteral(source);
          if (src) m.imports.push({ local: "*", module: src, imported: "*", line: node.startPosition.row + 1 });
          return;
        }
        visitChildren(node, ctx);
        return;
      }
      case "function_declaration":
      case "generator_function_declaration": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          visitFunction(node, name, ctx, "function");
          return;
        }
        break;
      }
      case "class_declaration":
      case "abstract_class_declaration":
      case "class": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          visitClass(node, name, ctx);
          return;
        }
        break;
      }
      case "variable_declarator": {
        const nameNode = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (nameNode?.type === "identifier" && value && FUNCTION_VALUES.has(value.type)) {
          visitFunction(value, nameNode.text, ctx, "function", node);
          return;
        }
        if (value && isRequire(value)) {
          const src = requireSource(value);
          if (src && nameNode) {
            if (nameNode.type === "identifier") m.imports.push({ local: nameNode.text, module: src, imported: "*", line: node.startPosition.row + 1 });
            else if (nameNode.type === "object_pattern") {
              for (const p of nameNode.namedChildren) {
                if (!p) continue;
                if (p.type === "shorthand_property_identifier_pattern") m.imports.push({ local: p.text, module: src, imported: p.text, line: node.startPosition.row + 1 });
                else if (p.type === "pair_pattern") {
                  const k = p.childForFieldName("key")?.text ?? "";
                  const v = p.childForFieldName("value")?.text ?? k;
                  m.imports.push({ local: v, module: src, imported: k, line: node.startPosition.row + 1 });
                }
              }
            }
          }
          return;
        }
        if (ctx.def && nameNode?.type === "identifier") {
          ctx.locals.add(nameNode.text);
          const t = typeParts(node.childForFieldName("type")?.text) ?? newType(value);
          if (t) ctx.types.set(nameNode.text, t);
        }
        if (value) visit(value, ctx);
        return;
      }
      case "decorator": {
        if (ctx.cls && ctx.def === ctx.cls) {
          ctx.pendingDecorators = [...(ctx.pendingDecorators ?? []), node.text.replace(/^@/, "")];
          return;
        }
        break;
      }
      case "method_definition": {
        const name = node.childForFieldName("name")?.text;
        if (name && ctx.cls) {
          const decorators = [...(ctx.pendingDecorators ?? []), ...node.namedChildren.filter((c) => c?.type === "decorator").map((c) => c!.text.replace(/^@/, ""))];
          ctx.pendingDecorators = undefined;
          visitFunction(node, name, ctx, "method", undefined, decorators);
          if (node.namedChildren.some((c) => c?.type === "accessibility_modifier" && c.text !== "public") || name.startsWith("#")) m.defs[m.defs.length - 1].private = true;
          return;
        }
        break;
      }
      case "public_field_definition": {
        ctx.pendingDecorators = undefined;
        const name = node.childForFieldName("name")?.text;
        const value = node.childForFieldName("value");
        if (name && ctx.cls && value && FUNCTION_VALUES.has(value.type)) {
          visitFunction(value, name, ctx, "method", node);
          return;
        }
        if (name && ctx.cls) {
          const t = typeParts(node.childForFieldName("type")?.text) ?? newType(value);
          if (t) m.attrTypes[`${ctx.cls}.${name}`] = t;
        }
        break;
      }
      case "call_expression": {
        const fn = node.childForFieldName("function");
        const args = node.childForFieldName("arguments");
        if (fn) {
          const parts = calleeParts(fn, "member_expression", "object", "property");
          if (parts.length && parts[0] !== "require") {
            const first = args?.namedChildren[0];
            m.calls.push({
              from: ctx.def,
              parts,
              line: node.startPosition.row + 1,
              inLoop: ctx.inLoop,
              conditional: ctx.conditional,
              guarded: ctx.guarded || undefined,
              firstArg: first ? (stringLiteral(first) ?? objectTopic(first)) : undefined,
              receiver: parts.length > 1 ? ctx.types.get(parts[0]) : undefined,
              argNames: argIdentifiers(args),
            });
            if (parts.length === 2 && tracked(parts[0], ctx) && ctx.def && MUTATORS.has(parts[1])) {
              m.globalAccess.push({ from: ctx.def, name: parts[0], mode: "write", line: node.startPosition.row + 1 });
            }
          }
          // promise.then(...).catch(...): everything in the chain is handled
          const catches = fn.type === "member_expression" && fn.childForFieldName("property")?.text === "catch";
          if (fn.type !== "identifier") visit(fn, catches ? { ...ctx, guarded: true } : ctx);
          // Callbacks passed to .map/.forEach/... run in a loop.
          const iterating = parts.length > 1 && ITERATING_METHODS.has(parts[parts.length - 1]);
          if (args) visitChildren(args, iterating ? { ...ctx, inLoop: true } : ctx);
        }
        return;
      }
      case "new_expression": {
        const ctor = node.childForFieldName("constructor");
        if (ctor) {
          const parts = calleeParts(ctor, "member_expression", "object", "property");
          if (parts.length) m.calls.push({ from: ctx.def, parts, line: node.startPosition.row + 1, inLoop: ctx.inLoop, conditional: ctx.conditional, isNew: true });
        }
        const args = node.childForFieldName("arguments");
        if (args) visitChildren(args, ctx);
        return;
      }
      case "try_statement": {
        const body = node.childForFieldName("body");
        for (const c of node.namedChildren) if (c) visit(c, c === body ? { ...ctx, guarded: true } : ctx);
        return;
      }
      case "jsx_opening_element":
      case "jsx_self_closing_element": {
        const name = node.childForFieldName("name");
        if (name && /^[A-Z]/.test(name.text)) {
          const parts = name.text.split(".");
          m.calls.push({ from: ctx.def, parts, line: node.startPosition.row + 1, inLoop: ctx.inLoop, conditional: ctx.conditional, jsx: true });
        }
        visitChildren(node, ctx);
        return;
      }
      case "assignment_expression":
      case "augmented_assignment_expression": {
        const left = node.childForFieldName("left");
        const rhs = node.childForFieldName("right");
        if (ctx.cls && left?.type === "member_expression" && left.childForFieldName("object")?.type === "this") {
          const t = newType(rhs) ?? (rhs?.type === "identifier" ? ctx.types.get(rhs.text) : undefined);
          if (t) m.attrTypes[`${ctx.cls}.${left.childForFieldName("property")!.text}`] = t;
        }
        if (ctx.def && left) {
          const base = left.type === "identifier" ? left.text : leftmostIdentifier(left);
          if (base && tracked(base, ctx)) {
            m.globalAccess.push({ from: ctx.def, name: base, mode: "write", line: node.startPosition.row + 1 });
          }
        }
        const right = node.childForFieldName("right");
        if (right) visit(right, ctx);
        if (left && left.type !== "identifier") visitChildren(left, ctx);
        return;
      }
      case "update_expression": {
        const arg = node.childForFieldName("argument");
        const base = arg ? (arg.type === "identifier" ? arg.text : leftmostIdentifier(arg)) : undefined;
        if (ctx.def && base && tracked(base, ctx)) {
          m.globalAccess.push({ from: ctx.def, name: base, mode: "write", line: node.startPosition.row + 1 });
        }
        return;
      }
      case "member_expression": {
        const obj = node.childForFieldName("object");
        if (obj) visit(obj, ctx);
        return;
      }
      case "shorthand_property_identifier":
        valueRefs.add(node.text);
        return;
      case "identifier": {
        valueRefs.add(node.text);
        if (ctx.def && tracked(node.text, ctx)) {
          m.globalAccess.push({ from: ctx.def, name: node.text, mode: "read", line: node.startPosition.row + 1 });
        }
        return;
      }
      case "arrow_function":
      case "function_expression":
      case "function": {
        // Anonymous callback: treat as part of the enclosing def, with its params as locals.
        const params = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
        const locals = new Set(ctx.locals);
        if (params) for (const p of parseParams(params)) locals.add(p.name.replace(/^\.\.\./, ""));
        const body = node.childForFieldName("body");
        if (body) visit(body, { ...ctx, locals });
        return;
      }
    }
    const nextCtx = LOOPS.has(node.type) ? { ...ctx, inLoop: true } : CONDITIONALS.has(node.type) ? { ...ctx, conditional: true } : ctx;
    visitChildren(node, nextCtx);
  };

  const visitChildren = (node: Node, ctx: Ctx) => {
    for (const c of node.namedChildren) if (c) visit(c, ctx);
  };

  const visitFunction = (fn: Node, name: string, ctx: Ctx, type: "function" | "method", declNode?: Node, decorators: string[] = []) => {
    const qual = ctx.def ? `${ctx.def}.${name}` : name;
    const paramsNode = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
    const params = paramsNode ? parseParams(paramsNode) : [];
    // closures see the enclosing function's variables
    const types = new Map<string, string[]>(ctx.def ? ctx.types : []);
    for (const p of params) {
      const t = typeParts(p.type);
      if (t) types.set(p.name, t);
    }
    // constructor(private repo: Repo) declares an instance attribute
    if (type === "method" && name === "constructor" && ctx.cls && paramsNode) {
      for (const p of paramsNode.namedChildren) {
        if (p?.namedChildren.some((c) => c?.type === "accessibility_modifier" || c?.type === "readonly")) {
          const pn = p.childForFieldName("pattern")?.text;
          const t = typeParts(p.childForFieldName("type")?.text);
          if (pn && t) m.attrTypes[`${ctx.cls}.${pn}`] = t;
        }
      }
    }
    const ret = fn.childForFieldName("return_type")?.text.replace(/^:\s*/, "");
    const outer = declNode ?? fn;
    addDef({
      qual,
      name,
      type,
      parentQual: ctx.def || undefined,
      params,
      returns: ret ? truncate(ret, 80) : undefined,
      line: outer.startPosition.row + 1,
      endLine: fn.endPosition.row + 1,
      doc: jsDoc(declNode?.parent?.type === "lexical_declaration" ? declNode.parent : outer),
      isAsync: fn.children.some((c) => c?.type === "async"),
      decorators: decorators.length ? decorators : undefined,
    });
    const locals = new Set(params.map((p) => p.name.replace(/^\.\.\./, "")));
    const body = fn.childForFieldName("body");
    if (body) visit(body, { def: qual, cls: type === "method" ? ctx.cls : undefined, inLoop: false, conditional: false, locals, types });
  };

  const visitClass = (node: Node, name: string, ctx: Ctx) => {
    const qual = ctx.def ? `${ctx.def}.${name}` : name;
    const heritage = node.namedChildren.find((c) => c?.type === "class_heritage");
    const decorators = node.namedChildren.filter((c) => c?.type === "decorator").map((c) => c!.text.replace(/^@/, ""));
    if (node.parent?.type === "export_statement") {
      for (const c of node.parent.namedChildren) if (c?.type === "decorator") decorators.push(c.text.replace(/^@/, ""));
    }
    const bases = heritage ? heritage.namedChildren.flatMap((c) => (c ? c.namedChildren.map((x) => x?.text ?? "") : [])).filter(Boolean) : [];
    addDef({
      qual,
      name,
      type: "class",
      parentQual: ctx.def || undefined,
      params: [],
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      doc: jsDoc(node),
      bases,
      decorators: decorators.length ? decorators : undefined,
    });
    const body = node.childForFieldName("body");
    if (body) visitChildren(body, { def: qual, cls: qual, inLoop: false, conditional: false, locals: new Set(), types: new Map() });
  };

  visitChildren(root, { def: "", inLoop: false, conditional: false, locals: new Set(), types: new Map() });

  // Use the constructor's params as the class's inputs.
  for (const d of m.defs) {
    if (d.type !== "class") continue;
    const ctor = m.defs.find((x) => x.qual === `${d.qual}.constructor`);
    if (ctor) d.params = ctor.params;
  }
  m.exports = [...exported];
  m.valueRefs = [...valueRefs];
  const byQual = new Map(m.defs.map((d) => [d.qual, d]));
  for (const d of m.defs) {
    const parent = d.parentQual ? byQual.get(d.parentQual) : undefined;
    if (!parent) d.visibility = exported.has(d.name) ? "exported" : "internal";
    else if (parent.type === "class") d.visibility = d.private || parent.visibility === "internal" ? "internal" : "public";
    else d.visibility = "internal";
  }
  return m;
}

/** Callee parts of `x = make()` / `x = kafka.consumer()` initialisers. */
function callType(value: Node | null | undefined): string[] | undefined {
  if (value?.type === "await_expression") value = value.namedChildren[0];
  if (value?.type !== "call_expression") return undefined;
  const fn = value.childForFieldName("function");
  const parts = fn ? calleeParts(fn, "member_expression", "object", "property") : [];
  return parts.length && !parts.includes("?") ? parts : undefined;
}

/** `{ topic: "orders" }` style arguments (kafkajs, bullmq, ...): the destination name. */
function objectTopic(n: Node): string | undefined {
  if (n.type !== "object") return undefined;
  for (const p of n.namedChildren) {
    if (p?.type !== "pair") continue;
    const key = p.childForFieldName("key")?.text.replace(/["']/g, "");
    const value = p.childForFieldName("value");
    if (key && /^(topic|queue|queueName|channel|subject|QueueUrl|TopicArn)$/.test(key) && value) return stringLiteral(value);
  }
  return undefined;
}

function newType(value: Node | null | undefined): string[] | undefined {
  if (value?.type === "await_expression") value = value.namedChildren[0];
  if (value?.type !== "new_expression") return undefined;
  const ctor = value.childForFieldName("constructor");
  const parts = ctor ? calleeParts(ctor, "member_expression", "object", "property") : [];
  return parts.length && !parts.includes("?") ? parts : undefined;
}

function parseParams(node: Node): Port[] {
  if (node.type === "identifier") return [{ name: node.text }];
  const out: Port[] = [];
  for (const p of node.namedChildren) {
    if (!p) continue;
    const port: Port = { name: "" };
    switch (p.type) {
      case "required_parameter":
      case "optional_parameter": {
        const pattern = p.childForFieldName("pattern");
        port.name = truncate(pattern?.text ?? p.text, 40);
        const t = p.childForFieldName("type")?.text.replace(/^:\s*/, "");
        if (t) port.type = truncate(t, 60);
        const v = p.childForFieldName("value");
        if (p.type === "optional_parameter" || v) port.optional = true;
        if (v) port.default = truncate(v.text, 40);
        if (pattern?.type === "this") continue;
        break;
      }
      case "identifier":
        port.name = p.text;
        break;
      case "assignment_pattern":
        port.name = truncate(p.childForFieldName("left")?.text ?? p.text, 40);
        port.optional = true;
        port.default = truncate(p.childForFieldName("right")?.text ?? "", 40);
        break;
      case "rest_pattern":
      case "object_pattern":
      case "array_pattern":
        port.name = truncate(p.text, 40);
        break;
      default:
        continue;
    }
    out.push(port);
  }
  return out;
}

function declaredNames(decl: Node): string[] {
  const name = decl.childForFieldName("name");
  if (name) return [name.text];
  if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
    return decl.namedChildren.filter((d) => d?.type === "variable_declarator").map((d) => d!.childForFieldName("name")?.text ?? "").filter(Boolean);
  }
  return [];
}

function isRequire(n: Node): boolean {
  if (n.type === "await_expression") return false;
  return n.type === "call_expression" && n.childForFieldName("function")?.text === "require";
}

function requireSource(n: Node): string | undefined {
  const arg = n.childForFieldName("arguments")?.namedChildren[0];
  return arg ? stringLiteral(arg) : undefined;
}

function isMutableValue(n: Node | null): boolean {
  if (!n) return false;
  if (n.type === "array" || n.type === "object") return true;
  if (n.type === "new_expression") return /^(Map|Set|WeakMap|Array|Object|LRUCache|\w*Cache)\b/.test(n.childForFieldName("constructor")?.text ?? "");
  return false;
}

function leftmostIdentifier(n: Node): string | undefined {
  let cur: Node | null = n;
  while (cur && (cur.type === "member_expression" || cur.type === "subscript_expression")) cur = cur.childForFieldName("object");
  return cur?.type === "identifier" ? cur.text : undefined;
}

function jsDoc(n: Node): string | undefined {
  let prev = n.previousNamedSibling;
  if (!prev && n.parent?.type === "export_statement") prev = n.parent.previousNamedSibling;
  if (prev?.type !== "comment" || !prev.text.startsWith("/**")) return undefined;
  if (prev.endPosition.row + 1 < n.startPosition.row) return undefined;
  return firstLine(prev.text.replace(/^\/\*\*|\*\/$/g, "").replace(/^\s*\*\s?/gm, ""));
}
