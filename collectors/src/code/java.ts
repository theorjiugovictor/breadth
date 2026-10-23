import type { Node } from "web-tree-sitter";
import type { Port } from "@breadth/schema";
import { emptyModel, type Def, type FileModel } from "./model.js";
import { MIN_FINGERPRINT } from "./python.js";
import { argIdentifiers, argValue, calleeParts, collectConstants, fingerprint, firstLine, namedArgs, stringLiteral, truncate } from "./util.js";

const LOOPS = new Set(["for_statement", "enhanced_for_statement", "while_statement", "do_statement"]);
const CONDITIONALS = new Set(["if_statement", "ternary_expression", "switch_block_statement_group", "switch_rule", "catch_clause"]);
const TYPE_DECLS = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration", "annotation_type_declaration"]);
/** Collection pipelines whose lambdas run once per element. */
const ITERATING = /^(forEach|map|flatMap|filter|peek|reduce|anyMatch|allMatch|noneMatch|collect|removeIf|replaceAll|computeIfAbsent)$/;

interface Ctx {
  def: string;
  cls?: string;
  inLoop: boolean;
  conditional: boolean;
  guarded?: boolean;
  locals: Set<string>;
  types: Map<string, string[]>;
}

/** Type parts: OrderRepository -> ['OrderRepository'], List<Order> -> ['List'], a.b.C -> ['a','b','C']. */
function javaType(n: Node | null | undefined): string[] | undefined {
  if (!n) return undefined;
  if (n.type === "type_identifier") return [n.text];
  if (n.type === "scoped_type_identifier") return n.text.split(".");
  if (n.type === "generic_type") return javaType(n.namedChildren[0]);
  return undefined;
}

/** `@GetMapping("/x")` -> 'GetMapping("/x")', `@Transactional` -> 'Transactional'. */
function annotations(mods: Node | null | undefined): string[] {
  const out: string[] = [];
  for (const a of mods?.namedChildren ?? []) {
    if (a?.type === "marker_annotation") out.push(a.childForFieldName("name")?.text ?? "");
    else if (a?.type === "annotation") {
      const args = a.childForFieldName("arguments")?.text ?? "()";
      out.push(`${a.childForFieldName("name")?.text ?? ""}${args.replace(/\s+/g, " ")}`);
    }
  }
  return out.filter(Boolean);
}

function modifierWords(mods: Node | null | undefined): Set<string> {
  return new Set((mods?.children ?? []).map((c) => c?.text ?? "").filter((t) => /^[a-z]+$/.test(t)));
}

export function extractJava(path: string, root: Node): FileModel {
  const m = emptyModel(path, "java");
  m.lines = root.endPosition.row + 1;
  const valueRefs = new Set<string>();
  const seen = new Set<string>();
  /** Static fields: shared by every caller (Java's module globals). */
  const globalNames = new Set<string>();

  for (const imp of root.namedChildren.filter((c) => c?.type === "import_declaration")) {
    const id = imp!.namedChildren.find((c) => c?.type === "scoped_identifier" || c?.type === "identifier")?.text;
    if (!id) continue;
    const wildcard = imp!.namedChildren.some((c) => c?.type === "asterisk");
    const line = imp!.startPosition.row + 1;
    if (wildcard) m.imports.push({ local: "*", module: id, imported: "*", line });
    else {
      const parts = id.split(".");
      m.imports.push({ local: parts[parts.length - 1], module: parts.slice(0, -1).join("."), imported: parts[parts.length - 1], line });
    }
  }

  const visitType = (node: Node, outer: string | undefined) => {
    const name = node.childForFieldName("name")?.text;
    const body = node.childForFieldName("body");
    if (!name) return;
    const qual = outer ? `${outer}.${name}` : name;
    const mods = node.namedChildren.find((c) => c?.type === "modifiers");
    const words = modifierWords(mods);
    const bases = [
      ...(javaType(node.childForFieldName("superclass")?.namedChildren[0]) ? [node.childForFieldName("superclass")!.namedChildren[0]!.text] : []),
      ...(node.childForFieldName("interfaces")?.descendantsOfType(["type_identifier", "generic_type", "scoped_type_identifier"]).filter((t) => t?.parent?.type === "type_list").map((t) => t!.text) ?? []),
      // interface Repo extends JpaRepository<Order, Long>
      ...(node.namedChildren.find((c) => c?.type === "extends_interfaces")?.descendantsOfType(["type_identifier", "generic_type"]).filter((t) => t?.parent?.type === "type_list").map((t) => t!.text) ?? []),
    ];
    const decorators = annotations(mods);
    m.defs.push({
      qual,
      name,
      type: "class",
      parentQual: outer,
      params: [],
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      doc: javadoc(node),
      bases: bases.length ? bases : undefined,
      decorators: decorators.length ? decorators : undefined,
      visibility: words.has("public") ? "exported" : words.has("private") ? "internal" : "public",
      private: words.has("private") || undefined,
    });
    // Fields first, so methods know their types wherever they are declared.
    for (const member of body?.namedChildren ?? []) {
      if (member?.type !== "field_declaration" && member?.type !== "constant_declaration") continue;
      const t = javaType(member.childForFieldName("type"));
      const fmods = modifierWords(member.namedChildren.find((c) => c?.type === "modifiers"));
      for (const decl of member.namedChildren.filter((c) => c?.type === "variable_declarator")) {
        const fname = decl!.childForFieldName("name")?.text;
        if (!fname) continue;
        if (t) m.attrTypes[`${qual}.${fname}`] = t;
        if (fmods.has("static") && !(fmods.has("final") && /^[A-Z][A-Z0-9_]*$/.test(fname))) {
          const value = decl!.childForFieldName("value");
          globalNames.add(fname);
          m.globals.push({ name: fname, line: decl!.startPosition.row + 1, mutable: !fmods.has("final") || /^new (Hash|Linked|Tree|Concurrent|Array)/.test(value?.text ?? ""), constantLike: false, init: value?.type === "object_creation_expression" ? javaType(value.childForFieldName("type")) : undefined });
        }
      }
    }
    for (const member of body?.namedChildren ?? []) {
      if (!member) continue;
      if (TYPE_DECLS.has(member.type)) visitType(member, qual);
      else if (member.type === "method_declaration" || member.type === "constructor_declaration") visitMethod(member, qual);
      else if (member.type === "field_declaration") {
        const ctx: Ctx = { def: qual, cls: qual, inLoop: false, conditional: false, locals: new Set(), types: new Map() };
        for (const decl of member.namedChildren.filter((c) => c?.type === "variable_declarator")) {
          const v = decl!.childForFieldName("value");
          if (v) visit(v, ctx);
        }
      } else if (member.type === "enum_body_declarations" || member.type === "class_body") {
        for (const c of member.namedChildren) if (c && (c.type === "method_declaration" || c.type === "constructor_declaration")) visitMethod(c, qual);
      }
    }
  };

  const visitMethod = (node: Node, cls: string) => {
    const name = node.type === "constructor_declaration" ? "<init>" : node.childForFieldName("name")?.text;
    if (!name) return;
    const qual = `${cls}.${name}`;
    // Overloads share a name: the first one stands for all of them.
    if (seen.has(qual)) return;
    seen.add(qual);
    const mods = node.namedChildren.find((c) => c?.type === "modifiers");
    const words = modifierWords(mods);
    const params = javaParams(node.childForFieldName("parameters"));
    const body = node.childForFieldName("body");
    const decorators = annotations(mods);
    const d: Def = {
      qual,
      name: name === "<init>" ? cls.split(".").pop()! : name,
      type: "method",
      parentQual: cls,
      params,
      returns: node.childForFieldName("type")?.text,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      doc: javadoc(node),
      decorators: decorators.length ? decorators : undefined,
      visibility: words.has("private") ? "internal" : "public",
      private: words.has("private") || undefined,
    };
    if (body) {
      const fp = fingerprint(body);
      if (fp.size >= MIN_FINGERPRINT) d.fingerprint = fp;
    }
    m.defs.push(d);
    const types = new Map<string, string[]>();
    for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) {
      const t = javaType(p?.childForFieldName("type"));
      const n = p?.childForFieldName("name")?.text;
      if (t && n) types.set(n, t);
    }
    if (body) visit(body, { def: qual, cls, inLoop: false, conditional: false, locals: new Set(params.map((p) => p.name)), types });
  };

  // AWS SDK v2 requests are built, not passed as named arguments:
  //   s3.putObject(PutObjectRequest.builder().bucket("receipts").key(k).build(), body)
  //   s3.putObject(b -> b.bucket(BUCKET).key(k), body)
  //   var req = SendMessageRequest.builder().queueUrl(url).build(); sqs.sendMessage(req)
  // The setters that name a resource become the call's named arguments, as in boto3.
  const AWS_SETTERS: Record<string, string> = { bucket: "Bucket", tableName: "TableName", queueUrl: "QueueUrl", queueName: "QueueName", topicArn: "TopicArn", secretId: "SecretId", functionName: "FunctionName", streamName: "StreamName" };
  const builderArgs = (n: Node | null | undefined, root?: string): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    let cur = n;
    let built = false;
    while (cur?.type === "method_invocation") {
      const name = cur.childForFieldName("name")?.text ?? "";
      const obj = cur.childForFieldName("object");
      if (AWS_SETTERS[name]) {
        const v = argValue(cur.childForFieldName("arguments")?.namedChildren[0]);
        if (v) out[AWS_SETTERS[name]] ??= v;
      }
      if (name === "builder" && obj && /Request$/.test(obj.text)) built = true;
      if (root && obj?.type === "identifier" && obj.text === root) built = true;
      cur = obj;
    }
    return built && Object.keys(out).length ? out : undefined;
  };
  const requestArgs = (args: Node | null | undefined, built: Map<string, Record<string, string>>): Record<string, string> | undefined => {
    for (const a of args?.namedChildren ?? []) {
      if (!a) continue;
      if (a.type === "identifier" && built.has(a.text)) return built.get(a.text);
      if (a.type === "lambda_expression") {
        const p = a.childForFieldName("parameters");
        const param = p?.type === "identifier" ? p.text : p?.namedChildren[0]?.text;
        const r = builderArgs(a.childForFieldName("body"), param);
        if (r) return r;
      }
      const r = builderArgs(a);
      if (r) return r;
    }
    return undefined;
  };
  const builtRequests = new Map<string, Map<string, Record<string, string>>>();
  const requestsOf = (def: string) => builtRequests.get(def) ?? builtRequests.set(def, new Map()).get(def)!;

  const visit = (node: Node, ctx: Ctx) => {
    switch (node.type) {
      case "class_declaration":
      case "interface_declaration":
      case "enum_declaration":
      case "record_declaration":
        // local and anonymous classes: their methods are separate defs
        visitType(node, ctx.def || undefined);
        return;
      case "method_invocation": {
        const obj = node.childForFieldName("object");
        const name = node.childForFieldName("name")?.text;
        const args = node.childForFieldName("arguments");
        if (name) {
          let parts = obj ? [...calleeParts(obj, "field_access", "object", "field"), name] : ["this", name];
          // a field used without `this.`: same as this.field
          if (parts.length > 1 && ctx.cls && !ctx.locals.has(parts[0]) && !ctx.types.has(parts[0]) && m.attrTypes[`${ctx.cls}.${parts[0]}`]) parts = ["this", ...parts];
          if (parts[0] === "?" && parts.length === 1) parts = [name];
          const first = args?.namedChildren[0];
          m.calls.push({
            from: ctx.def,
            parts,
            line: node.startPosition.row + 1,
            inLoop: ctx.inLoop,
            conditional: ctx.conditional,
            guarded: ctx.guarded || undefined,
            firstArg: first ? stringLiteral(first) : undefined,
            receiver: parts.length > 1 && parts[0] !== "this" ? ctx.types.get(parts[0]) : undefined,
            argNames: argIdentifiers(args),
            kwargs: requestArgs(args, requestsOf(ctx.def)) ?? namedArgs(args),
          });
          if (parts.length === 2 && globalNames.has(parts[0]) && !ctx.locals.has(parts[0]) && ctx.def && /^(put|add|remove|clear|set|offer|poll|push|pop|merge|compute\w*|putIfAbsent|addAll|removeAll|increment\w*)$/.test(name)) {
            m.globalAccess.push({ from: ctx.def, name: parts[0], mode: "write", line: node.startPosition.row + 1 });
          }
        }
        if (obj) visit(obj, ctx);
        if (args) visit(args, name && ITERATING.test(name) ? { ...ctx, inLoop: true } : ctx);
        return;
      }
      case "object_creation_expression": {
        const t = javaType(node.childForFieldName("type"));
        const args = node.childForFieldName("arguments");
        if (t) m.calls.push({ from: ctx.def, parts: t, line: node.startPosition.row + 1, inLoop: ctx.inLoop, conditional: ctx.conditional, isNew: true, kwargs: namedArgs(args), argNames: argIdentifiers(args) });
        for (const c of node.namedChildren) if (c && c !== node.childForFieldName("type")) visit(c, ctx);
        return;
      }
      case "local_variable_declaration": {
        const t = javaType(node.childForFieldName("type"));
        for (const decl of node.namedChildren.filter((c) => c?.type === "variable_declarator")) {
          const n = decl!.childForFieldName("name")?.text;
          const value = decl!.childForFieldName("value");
          if (n) {
            ctx.locals.add(n);
            const req = value ? builderArgs(value) : undefined;
            if (req) requestsOf(ctx.def).set(n, req);
            const vt = t ?? (value?.type === "object_creation_expression" ? javaType(value.childForFieldName("type")) : undefined);
            if (vt && vt[0] !== "var") ctx.types.set(n, vt);
          }
          if (value) visit(value, ctx);
        }
        return;
      }
      case "enhanced_for_statement": {
        const n = node.childForFieldName("name")?.text;
        if (n) ctx.locals.add(n);
        break;
      }
      case "try_statement":
      case "try_with_resources_statement": {
        const body = node.childForFieldName("body");
        for (const c of node.namedChildren) if (c) visit(c, c === body || c.type === "resource_specification" ? { ...ctx, guarded: true } : ctx);
        return;
      }
      case "assignment_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        const base = left?.type === "identifier" ? left.text : left?.type === "array_access" ? left.childForFieldName("array")?.text : undefined;
        if (base && ctx.def && globalNames.has(base) && !ctx.locals.has(base)) m.globalAccess.push({ from: ctx.def, name: base, mode: "write", line: node.startPosition.row + 1 });
        if (right) visit(right, ctx);
        return;
      }
      case "method_reference":
        // this::handle, Foo::bar: a function used as a value
        valueRefs.add(node.namedChildren[node.namedChildren.length - 1]?.text ?? "");
        return;
      case "identifier": {
        valueRefs.add(node.text);
        if (ctx.def && globalNames.has(node.text) && !ctx.locals.has(node.text)) m.globalAccess.push({ from: ctx.def, name: node.text, mode: "read", line: node.startPosition.row + 1 });
        return;
      }
    }
    const next = LOOPS.has(node.type) ? { ...ctx, inLoop: true } : CONDITIONALS.has(node.type) ? { ...ctx, conditional: true } : ctx;
    for (const c of node.namedChildren) if (c) visit(c, next);
  };

  for (const t of root.namedChildren) if (t && TYPE_DECLS.has(t.type)) visitType(t, undefined);
  for (const d of m.defs) if (!d.parentQual && d.visibility === "exported") m.exports.push(d.name);
  m.valueRefs = [...valueRefs].filter(Boolean);
  m.constants = collectConstants(root, "variable_declarator", "name", "value");
  m.doc = m.defs[0]?.doc;
  return m;
}

function javaParams(list: Node | null): Port[] {
  const out: Port[] = [];
  for (const p of list?.namedChildren ?? []) {
    if (p?.type !== "formal_parameter" && p?.type !== "spread_parameter") continue;
    const name = p.childForFieldName("name")?.text ?? p.namedChildren.find((c) => c?.type === "variable_declarator")?.childForFieldName("name")?.text;
    const type = p.childForFieldName("type")?.text ?? p.namedChildren.find((c) => c?.type?.endsWith("type") || c?.type === "type_identifier")?.text;
    if (name) out.push({ name, ...(type ? { type: truncate(type, 60) } : {}), ...(p.type === "spread_parameter" ? { optional: true } : {}) });
  }
  return out;
}

/** First sentence of the /** javadoc *\/ right above a declaration. */
function javadoc(node: Node): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev?.type !== "block_comment" || !prev.text.startsWith("/**") || prev.endPosition.row < node.startPosition.row - 1) return undefined;
  const text = prev.text
    .replace(/^\/\*\*|\*\/$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .filter((l) => !l.startsWith("@"))
    .join(" ");
  return firstLine(text);
}
