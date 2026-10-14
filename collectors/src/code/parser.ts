import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { Lang } from "./model.js";

const require = createRequire(import.meta.url);

const GRAMMAR_FILES: Record<Lang, string> = {
  python: "tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
};

let initPromise: Promise<void> | undefined;
const languages = new Map<Lang, Promise<Language>>();
const parsers = new Map<Lang, Parser>();

function grammarPath(file: string): string {
  const pkg = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkg), "out", file);
}

/** Lazily initialise tree-sitter and return a parser for the language. */
export async function getParser(lang: Lang): Promise<Parser> {
  initPromise ??= Parser.init();
  await initPromise;
  const cached = parsers.get(lang);
  if (cached) return cached;
  if (!languages.has(lang)) languages.set(lang, Language.load(grammarPath(GRAMMAR_FILES[lang])));
  const language = await languages.get(lang)!;
  const parser = new Parser();
  parser.setLanguage(language);
  parsers.set(lang, parser);
  return parser;
}

export function langForFile(file: string): Lang | undefined {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".py":
    case ".pyi":
      return ext === ".pyi" ? undefined : "python";
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
    default:
      return undefined;
  }
}
