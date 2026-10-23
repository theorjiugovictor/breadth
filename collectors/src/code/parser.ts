import { Language, Parser } from "web-tree-sitter";
import type { Lang } from "./model.js";
import { extname } from "./posix.js";

export const GRAMMAR_FILES: Record<Lang, string> = {
  python: "tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
};

/**
 * Where tree-sitter's own runtime and the grammar .wasm files live. Node resolves them from
 * node_modules (see parser-node.ts); the browser serves them as static files.
 */
export interface WasmLocator {
  /** URL or path of web-tree-sitter's tree-sitter.wasm (undefined = let the library find it). */
  runtime?: string;
  grammar(file: string): string | Promise<string | Uint8Array>;
}

let locator: WasmLocator | undefined;
let initPromise: Promise<void> | undefined;
const languages = new Map<Lang, Promise<Language>>();
const parsers = new Map<Lang, Parser>();

export function setWasmLocator(l: WasmLocator) {
  locator = l;
}

/** Lazily initialise tree-sitter and return a parser for the language. */
export async function getParser(lang: Lang): Promise<Parser> {
  if (!locator) throw new Error("tree-sitter wasm locator not configured");
  const loc = locator;
  initPromise ??= Parser.init(loc.runtime ? { locateFile: () => loc.runtime! } : undefined);
  await initPromise;
  const cached = parsers.get(lang);
  if (cached) return cached;
  if (!languages.has(lang)) languages.set(lang, Promise.resolve(loc.grammar(GRAMMAR_FILES[lang])).then((src) => Language.load(src)));
  const language = await languages.get(lang)!;
  const parser = new Parser();
  parser.setLanguage(language);
  parsers.set(lang, parser);
  return parser;
}

export function langForFile(file: string): Lang | undefined {
  switch (extname(file).toLowerCase()) {
    case ".py":
      return "python";
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".jsx":
      return "javascript";
    case ".go":
      return "go";
    case ".java":
      return "java";
    default:
      return undefined;
  }
}
