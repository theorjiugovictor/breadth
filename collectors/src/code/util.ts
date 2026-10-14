import type { Node } from "web-tree-sitter";

/**
 * Flatten a callee expression into identifier parts.
 * `a.b.c` -> ['a','b','c'], `self.x` -> ['self','x'], `get().json` -> ['?','json'].
 */
export function calleeParts(n: Node, memberType: string, objectField: string, propField: string): string[] {
  if (n.type === "identifier" || n.type === "this" || n.type === "super" || n.type === "property_identifier") return [n.text];
  if (n.type === memberType) {
    const obj = n.childForFieldName(objectField);
    const prop = n.childForFieldName(propField);
    if (!prop) return [];
    const head = obj ? calleeParts(obj, memberType, objectField, propField) : [];
    return [...(head.length ? head : ["?"]), prop.text];
  }
  if (n.type === "parenthesized_expression" || n.type === "non_null_expression") {
    const inner = n.namedChildren[0];
    return inner ? calleeParts(inner, memberType, objectField, propField) : [];
  }
  return [];
}

/** Return the value of a plain string literal node, or undefined. */
export function stringLiteral(n: Node): string | undefined {
  if (n.type === "string" || n.type === "template_string") {
    const raw = n.text;
    const m = raw.match(/^[rbufRBUF]*(["'`]{1,3})([\s\S]*)\1$/);
    if (!m) return undefined;
    let body = m[2];
    // Keep placeholder names ({ORDERS_URL}) - they often name the service being called.
    body = body.replace(/\$\{\s*([^}]*?)\s*\}/g, "{$1}");
    return truncate(body, 200);
  }
  if (n.type === "concatenated_string") {
    const first = n.namedChildren[0];
    return first ? stringLiteral(first) : undefined;
  }
  return undefined;
}

export function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function firstLine(s: string): string | undefined {
  const line = s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? truncate(line, 200) : undefined;
}

/**
 * Turn a type annotation into callee-like parts when it names a single class:
 * 'Repo' -> ['Repo'], 'Optional[models.User]' -> ['models','User'], 'Repo | None' -> ['Repo'].
 */
export function typeParts(annotation?: string): string[] | undefined {
  if (!annotation) return undefined;
  let t = annotation.replace(/^:\s*/, "").trim();
  const opt = t.match(/^Optional\[(.*)\]$/);
  if (opt) t = opt[1];
  t = t
    .split("|")
    .map((x) => x.trim())
    .filter((x) => x && x !== "None" && x !== "null" && x !== "undefined")[0] ?? "";
  t = t.replace(/^["']|["']$/g, "");
  if (!/^[A-Za-z_][\w.]*$/.test(t)) return undefined;
  if (/^(str|int|float|bool|bytes|dict|list|set|tuple|object|any|Any|string|number|boolean|unknown|void|never)$/.test(t)) return undefined;
  return t.split(".");
}

/** Identifiers passed directly as call arguments. */
export function argIdentifiers(args: Node | null): string[] | undefined {
  if (!args) return undefined;
  const out: string[] = [];
  for (const a of args.namedChildren) {
    if (!a) continue;
    if (a.type === "identifier") out.push(a.text);
    else if (a.type === "keyword_argument") {
      const v = a.childForFieldName("value");
      if (v?.type === "identifier") out.push(v.text);
    } else if (a.type === "member_expression" || a.type === "attribute") {
      if (/^[\w.]+$/.test(a.text)) out.push(a.text);
    }
  }
  return out.length ? out : undefined;
}

const SIG_SIZE = 16;
const SEEDS = Array.from({ length: SIG_SIZE }, (_, i) => Math.imul(0x9e3779b1, i + 1) >>> 0);

function fnv(s: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

function mix(h: number, seed: number): number {
  let x = (h ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

export interface Fingerprint {
  /** Hash of the node-type sequence: equal for structurally identical bodies. */
  shape: string;
  /** Number of syntax nodes in the body. */
  size: number;
  /** MinHash over 4-grams of node types, for near-duplicate search. */
  sig: number[];
}

/**
 * Structural fingerprint of a function body: names, literals and comments are ignored, so
 * copy-pasted logic with renamed variables still matches.
 */
export function fingerprint(body: Node, skip?: Node | null): Fingerprint {
  const types: string[] = [];
  const walk = (n: Node) => {
    if (n.type === "comment" || (skip && n.id === skip.id)) return;
    types.push(n.type);
    for (const c of n.namedChildren) if (c) walk(c);
  };
  walk(body);
  const shingles = new Set<number>();
  for (let i = 0; i + 4 <= types.length; i++) shingles.add(fnv(types.slice(i, i + 4).join(" ")));
  if (!shingles.size) shingles.add(fnv(types.join(" ")));
  const sig = SEEDS.map((seed) => {
    let min = 0xffffffff;
    for (const s of shingles) {
      const v = mix(s, seed);
      if (v < min) min = v;
    }
    return min;
  });
  return { shape: fnv(types.join(" ")).toString(36), size: types.length, sig };
}
