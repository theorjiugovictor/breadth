// A small parser for HCL2, the language of Terraform / OpenTofu configuration.
// Browser-safe (no Node APIs), so the in-browser repo scanner can read .tf files too.
// It parses everything Terraform accepts in native syntax; what it does not try to do is
// evaluate: that is terraform-hcl.ts's job.

export type Expr =
  | { t: "lit"; v: string | number | boolean | null }
  | { t: "tmpl"; parts: (string | Expr)[] }
  | { t: "tuple"; items: Expr[] }
  | { t: "object"; items: { key: Expr; value: Expr }[] }
  | { t: "var"; name: string }
  | { t: "get"; obj: Expr; name: string }
  | { t: "index"; obj: Expr; index: Expr }
  | { t: "splat"; obj: Expr }
  | { t: "call"; name: string; args: Expr[] }
  | { t: "unary"; op: string; x: Expr }
  | { t: "binary"; op: string; a: Expr; b: Expr }
  | { t: "cond"; c: Expr; a: Expr; b: Expr }
  | { t: "for"; keyVar?: string; valVar: string; coll: Expr; key?: Expr; value: Expr; cond?: Expr; object: boolean }
  /** A template directive (%{if}, %{for}): its value is not computed, its expressions still carry references. */
  | { t: "directive"; exprs: Expr[]; vars: string[] };

export interface Attribute {
  name: string;
  expr: Expr;
  line: number;
}

export interface Block {
  type: string;
  labels: string[];
  body: Body;
  line: number;
}

export interface Body {
  attrs: Attribute[];
  blocks: Block[];
}

export class HclError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
  }
}

/** Parse a .tf / .tfvars file. Throws HclError on syntax errors. */
export function parseHcl(text: string): Body {
  return new Parser(text).file();
}

/** Look up an attribute by name. */
export function attr(body: Body, name: string): Attribute | undefined {
  return body.attrs.find((a) => a.name === name);
}

const BINARY_OPS = [["||"], ["&&"], ["==", "!="], ["<=", ">=", "<", ">"], ["+", "-"], ["*", "/", "%"]];
const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_-]/;

class Parser {
  private i = 0;
  /** Inside (), [] or {} of an expression newlines are insignificant; in a body they end an item. */
  private depth = 0;
  private lineStarts: number[] = [0];

  constructor(private readonly s: string) {
    for (let k = 0; k < s.length; k++) if (s[k] === "\n") this.lineStarts.push(k + 1);
  }

  file(): Body {
    if (this.s.charCodeAt(0) === 0xfeff) this.i = 1;
    return this.body(false);
  }

  /** Template text only (heredoc contents). */
  templateOnly(): Expr {
    return this.template(this.s.length);
  }

  /* ---------------- lexing helpers ---------------- */

  private line(pos = this.i): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  private fail(msg: string): never {
    throw new HclError(msg, this.line());
  }

  private skip(newlines: boolean) {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === " " || c === "\t" || c === "\r") this.i++;
      else if (c === "\n" && newlines) this.i++;
      else if (c === "#" || (c === "/" && s[this.i + 1] === "/")) {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
      } else if (c === "/" && s[this.i + 1] === "*") {
        const end = s.indexOf("*/", this.i + 2);
        this.i = end < 0 ? s.length : end + 2;
      } else break;
    }
  }

  private ws() {
    this.skip(this.depth > 0);
  }

  private peek(str: string): boolean {
    return this.s.startsWith(str, this.i);
  }

  private expect(str: string) {
    this.ws();
    if (!this.peek(str)) this.fail(`expected "${str}"`);
    this.i += str.length;
  }

  private ident(): string | undefined {
    if (!IDENT_START.test(this.s[this.i] ?? "")) return undefined;
    const start = this.i;
    while (this.i < this.s.length && IDENT_CHAR.test(this.s[this.i])) this.i++;
    return this.s.slice(start, this.i);
  }

  /** A keyword like `for`, `in` or `if`, not followed by an identifier character. */
  private keyword(word: string): boolean {
    if (!this.peek(word) || IDENT_CHAR.test(this.s[this.i + word.length] ?? "")) return false;
    this.i += word.length;
    return true;
  }

  private nested<T>(depth: number, fn: () => T): T {
    const saved = this.depth;
    this.depth = depth;
    try {
      return fn();
    } finally {
      this.depth = saved;
    }
  }

  /* ---------------- structure ---------------- */

  private body(closing: boolean): Body {
    const body: Body = { attrs: [], blocks: [] };
    for (;;) {
      this.skip(true);
      if (this.i >= this.s.length) {
        if (closing) this.fail('unclosed block: expected "}"');
        return body;
      }
      if (this.s[this.i] === "}") {
        if (!closing) this.fail('unexpected "}"');
        this.i++;
        return body;
      }
      const line = this.line();
      const name = this.ident();
      if (!name) this.fail(`expected an attribute or a block, found "${this.s[this.i]}"`);
      this.skip(false);
      if (this.s[this.i] === "=" && this.s[this.i + 1] !== "=") {
        this.i++;
        const expr = this.nested(0, () => this.expr());
        body.attrs.push({ name, expr, line });
        this.endOfItem();
        continue;
      }
      const labels: string[] = [];
      for (;;) {
        this.skip(false);
        if (this.s[this.i] === '"') {
          const e = this.nested(1, () => this.stringLit());
          labels.push(e.t === "lit" ? String(e.v) : "");
        } else {
          const l = this.ident();
          if (!l) break;
          labels.push(l);
        }
      }
      this.skip(false);
      if (this.s[this.i] !== "{") this.fail(`expected "{" or "=" after "${name}"`);
      this.i++;
      const inner = this.nested(0, () => this.body(true));
      body.blocks.push({ type: name, labels, body: inner, line });
      this.endOfItem();
    }
  }

  private endOfItem() {
    this.skip(false);
    const c = this.s[this.i];
    if (c === "\n") this.i++;
    else if (c === "," || c === ";") this.i++;
    else if (c !== undefined && c !== "}") this.fail(`expected a new line, found "${c}"`);
  }

  /* ---------------- expressions ---------------- */

  private expr(): Expr {
    const c = this.binary(0);
    this.ws();
    if (this.s[this.i] === "?") {
      this.i++;
      const a = this.expr();
      this.expect(":");
      const b = this.expr();
      return { t: "cond", c, a, b };
    }
    return c;
  }

  private binary(level: number): Expr {
    if (level === BINARY_OPS.length) return this.unary();
    let a = this.binary(level + 1);
    for (;;) {
      this.ws();
      const op = BINARY_OPS[level].find((o) => this.peek(o));
      if (!op) return a;
      this.i += op.length;
      const b = this.binary(level + 1);
      a = { t: "binary", op, a, b };
    }
  }

  private unary(): Expr {
    this.ws();
    const c = this.s[this.i];
    if ((c === "!" && this.s[this.i + 1] !== "=") || c === "-") {
      this.i++;
      return { t: "unary", op: c, x: this.unary() };
    }
    return this.postfix(this.primary());
  }

  private postfix(e: Expr): Expr {
    for (;;) {
      const save = this.i;
      this.ws();
      const c = this.s[this.i];
      if (c === "." && this.s[this.i + 1] !== ".") {
        this.i++;
        if (this.s[this.i] === "*") {
          this.i++;
          e = { t: "splat", obj: e };
          continue;
        }
        const digits = this.s.slice(this.i).match(/^\d+/)?.[0];
        if (digits) {
          this.i += digits.length;
          e = { t: "index", obj: e, index: { t: "lit", v: Number(digits) } };
          continue;
        }
        const name = this.ident();
        if (!name) this.fail('expected an attribute name after "."');
        e = { t: "get", obj: e, name };
        continue;
      }
      if (c === "[") {
        this.i++;
        const inner = this.nested(this.depth + 1, () => {
          this.ws();
          if (this.s[this.i] === "*") {
            this.i++;
            this.expect("]");
            return undefined;
          }
          const index = this.expr();
          this.expect("]");
          return index;
        });
        e = inner ? { t: "index", obj: e, index: inner } : { t: "splat", obj: e };
        continue;
      }
      this.i = save;
      return e;
    }
  }

  private primary(): Expr {
    this.ws();
    const s = this.s;
    const c = s[this.i];
    if (c === undefined) this.fail("unexpected end of file");
    if (/[0-9]/.test(c)) {
      const m = s.slice(this.i).match(/^\d+(\.\d+)?([eE][+-]?\d+)?/)!;
      this.i += m[0].length;
      return { t: "lit", v: Number(m[0]) };
    }
    if (c === '"') return this.nested(this.depth + 1, () => this.stringLit());
    if (c === "<" && s[this.i + 1] === "<") return this.heredoc();
    if (c === "(") {
      this.i++;
      return this.nested(this.depth + 1, () => {
        const e = this.expr();
        this.expect(")");
        return e;
      });
    }
    if (c === "[") {
      this.i++;
      return this.nested(this.depth + 1, () => this.tupleOrFor());
    }
    if (c === "{") {
      this.i++;
      return this.nested(this.depth + 1, () => this.objectOrFor());
    }
    const name = this.ident();
    if (!name) this.fail(`unexpected "${c}"`);
    if (name === "true" || name === "false") return { t: "lit", v: name === "true" };
    if (name === "null") return { t: "lit", v: null };
    // provider-defined functions: provider::aws::arn_parse(...)
    let fn = name;
    while (this.peek("::")) {
      this.i += 2;
      fn += `::${this.ident() ?? ""}`;
    }
    if (s[this.i] === "(") {
      this.i++;
      return this.nested(this.depth + 1, () => {
        const args: Expr[] = [];
        for (;;) {
          this.ws();
          if (s[this.i] === ")") break;
          args.push(this.expr());
          this.ws();
          if (this.peek("...")) {
            this.i += 3;
            this.ws();
          }
          if (s[this.i] === ",") this.i++;
          else if (s[this.i] !== ")") this.fail('expected "," or ")" in function call');
        }
        this.i++;
        return { t: "call", name: fn, args };
      });
    }
    return { t: "var", name: fn };
  }

  private tupleOrFor(): Expr {
    this.ws();
    if (this.keyword("for")) return this.forExpr("]", false);
    const items: Expr[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") break;
      items.push(this.expr());
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") this.fail('expected "," or "]"');
    }
    this.i++;
    return { t: "tuple", items };
  }

  private objectOrFor(): Expr {
    this.ws();
    if (this.keyword("for")) return this.forExpr("}", true);
    const items: { key: Expr; value: Expr }[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") break;
      // A bare identifier key is a literal name, not a variable reference.
      const save = this.i;
      let key: Expr | undefined;
      const name = this.ident();
      if (name) {
        this.ws();
        if ((this.s[this.i] === "=" && this.s[this.i + 1] !== "=") || (this.s[this.i] === ":" && this.s[this.i + 1] !== ":")) key = { t: "lit", v: name };
        else this.i = save;
      }
      key ??= this.expr();
      this.ws();
      if ((this.s[this.i] === "=" && this.s[this.i + 1] !== "=") || this.s[this.i] === ":") this.i++;
      else this.fail('expected "=" or ":" in object');
      const value = this.expr();
      items.push({ key, value });
      this.ws();
      if (this.s[this.i] === ",") this.i++;
    }
    this.i++;
    return { t: "object", items };
  }

  private forExpr(close: string, object: boolean): Expr {
    this.ws();
    const first = this.ident();
    if (!first) this.fail("expected a variable name after for");
    this.ws();
    let keyVar: string | undefined;
    let valVar = first;
    if (this.s[this.i] === ",") {
      this.i++;
      this.ws();
      keyVar = first;
      valVar = this.ident() ?? this.fail("expected a second variable name");
    }
    this.ws();
    if (!this.keyword("in")) this.fail('expected "in"');
    const coll = this.expr();
    this.expect(":");
    let key: Expr | undefined;
    let value = this.expr();
    this.ws();
    if (object && this.peek("=>")) {
      this.i += 2;
      key = value;
      value = this.expr();
      this.ws();
      if (this.peek("...")) this.i += 3;
    }
    this.ws();
    let cond: Expr | undefined;
    if (this.keyword("if")) cond = this.expr();
    this.expect(close);
    return { t: "for", keyVar, valVar, coll, key, value, cond, object };
  }

  /* ---------------- strings ---------------- */

  private stringLit(): Expr {
    this.i++; // opening quote
    return this.template('"');
  }

  /** Parse template text up to a closing quote (strings) or a position (heredocs). */
  private template(end: '"' | number): Expr {
    const s = this.s;
    const parts: (string | Expr)[] = [];
    let buf = "";
    const done = () => (end === '"' ? s[this.i] === '"' : this.i >= end);
    while (!done()) {
      if (this.i >= s.length) this.fail("unterminated string");
      const c = s[this.i];
      if (end === '"' && c === "\\") {
        const n = s[this.i + 1];
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
        if (n === "u" || n === "U") {
          const len = n === "u" ? 4 : 8;
          buf += String.fromCodePoint(parseInt(s.slice(this.i + 2, this.i + 2 + len), 16) || 0xfffd);
          this.i += 2 + len;
        } else {
          buf += map[n] ?? n;
          this.i += 2;
        }
        continue;
      }
      if ((c === "$" || c === "%") && s[this.i + 1] === c && s[this.i + 2] === "{") {
        buf += `${c}{`;
        this.i += 3;
        continue;
      }
      if (c === "$" && s[this.i + 1] === "{") {
        this.i += 2;
        if (buf) parts.push(buf);
        buf = "";
        parts.push(
          this.nested(this.depth + 1, () => {
            this.ws();
            if (s[this.i] === "~") this.i++;
            const e = this.expr();
            this.ws();
            if (s[this.i] === "~") this.i++;
            this.expect("}");
            return e;
          }),
        );
        continue;
      }
      if (c === "%" && s[this.i + 1] === "{") {
        this.i += 2;
        if (buf) parts.push(buf);
        buf = "";
        parts.push(this.nested(this.depth + 1, () => this.directive()));
        continue;
      }
      buf += c;
      this.i++;
    }
    if (end === '"') this.i++;
    if (buf) parts.push(buf);
    if (parts.length === 0) return { t: "lit", v: "" };
    if (parts.length === 1 && typeof parts[0] === "string") return { t: "lit", v: parts[0] };
    return { t: "tmpl", parts };
  }

  private directive(): Expr {
    this.ws();
    if (this.s[this.i] === "~") this.i++;
    this.ws();
    const exprs: Expr[] = [];
    const vars: string[] = [];
    if (this.keyword("if")) exprs.push(this.expr());
    else if (this.keyword("for")) {
      this.ws();
      vars.push(this.ident() ?? "");
      this.ws();
      if (this.s[this.i] === ",") {
        this.i++;
        this.ws();
        vars.push(this.ident() ?? "");
      }
      this.ws();
      if (!this.keyword("in")) this.fail('expected "in"');
      exprs.push(this.expr());
    } else this.ident(); // else, endif, endfor
    this.ws();
    if (this.s[this.i] === "~") this.i++;
    this.expect("}");
    return { t: "directive", exprs, vars };
  }

  private heredoc(): Expr {
    const s = this.s;
    this.i += 2;
    const indent = s[this.i] === "-";
    if (indent) this.i++;
    const marker = this.ident();
    if (!marker) this.fail("expected a heredoc marker");
    const nl = s.indexOf("\n", this.i);
    if (nl < 0) this.fail("unterminated heredoc");
    const start = nl + 1;
    // The closing marker is alone on its line (leading whitespace allowed).
    const re = new RegExp(`^[ \\t]*${marker}[ \\t]*\\r?$`, "m");
    const rest = s.slice(start);
    const m = re.exec(rest);
    if (!m) this.fail(`heredoc ${marker} is not closed`);
    let text = rest.slice(0, m.index);
    this.i = start + m.index + m[0].length;
    if (indent) {
      const lines = text.split("\n");
      const min = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0].length));
      if (Number.isFinite(min)) text = lines.map((l) => l.slice(Math.min(min, l.match(/^[ \t]*/)![0].length))).join("\n");
    }
    return new Parser(text).templateOnly();
  }
}
