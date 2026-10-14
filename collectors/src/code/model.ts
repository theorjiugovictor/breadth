import type { Port } from "@noodles/schema";

export type Lang = "python" | "typescript" | "tsx" | "javascript";

/** A function, method or class found in a file. */
export interface Def {
  /** Dotted name inside the file: 'helper', 'User', 'User.save', 'outer.inner'. */
  qual: string;
  name: string;
  type: "function" | "method" | "class";
  /** qual of the enclosing def, if nested. */
  parentQual?: string;
  params: Port[];
  returns?: string;
  line: number;
  endLine: number;
  doc?: string;
  isAsync?: boolean;
  /** Base classes, as written. */
  bases?: string[];
  decorators?: string[];
}

/** One call expression, with the callee flattened into identifier parts. */
export interface CallSite {
  /** qual of the calling def, or '' for module-level code. */
  from: string;
  /** e.g. ['foo'], ['self','save'], ['requests','get'], ['?','json'] for unknown receivers. */
  parts: string[];
  line: number;
  inLoop: boolean;
  conditional: boolean;
  /** First argument when it is a string literal (URLs, SQL, topics). */
  firstArg?: string;
  /** Rendered via JSX rather than called. */
  jsx?: boolean;
  /** Constructed with `new`. */
  isNew?: boolean;
  /** Known type (constructor/annotation callee parts) of parts[0] when it is a local variable. */
  receiver?: string[];
  /** Plain identifiers passed as arguments (route handlers, callbacks). */
  argNames?: string[];
}

export interface ImportBinding {
  /** Local name bound in this file. */
  local: string;
  /** Module specifier as written: './users', 'requests', '..db', 'app.models'. */
  module: string;
  /** Imported symbol; '*' for a namespace/module import, 'default' for default imports. */
  imported: string;
  line: number;
}

export interface GlobalVar {
  name: string;
  line: number;
  /** Literal kind of the initial value, used to decide if it is mutable shared state. */
  mutable: boolean;
  constantLike: boolean;
}

export interface GlobalAccess {
  from: string;
  name: string;
  mode: "read" | "write";
  line: number;
}

export interface FileModel {
  path: string;
  lang: Lang;
  doc?: string;
  defs: Def[];
  calls: CallSite[];
  imports: ImportBinding[];
  globals: GlobalVar[];
  globalAccess: GlobalAccess[];
  /** Top-level names exported (TS) or public (Python, no leading underscore). */
  exports: string[];
  /** Types of instance attributes: 'Class.attr' -> type callee parts (from self.x = Foo() / typed fields). */
  attrTypes: Record<string, string[]>;
  lines: number;
}

export function emptyModel(path: string, lang: Lang): FileModel {
  return { path, lang, defs: [], calls: [], imports: [], globals: [], globalAccess: [], exports: [], attrTypes: {}, lines: 0 };
}
