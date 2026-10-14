import type { FlowGraph } from "@breadth/schema";
import { buildGraph } from "./build.js";
import type { FileModel } from "./model.js";
import { getParser, langForFile } from "./parser.js";
import { extractPython } from "./python.js";
import { extractTypeScript } from "./typescript.js";

export interface SourceFile {
  path: string;
  text: string;
}

/** Parse one source file into a model (undefined for unsupported or generated files). */
export async function parseSource(path: string, text: string): Promise<FileModel | undefined> {
  const lang = langForFile(path);
  if (!lang) return undefined;
  // Skip generated / minified files: very long lines are a strong signal.
  if (text.length > 20_000 && text.split("\n", 50).some((l) => l.length > 2000)) return undefined;
  const parser = await getParser(lang);
  const tree = parser.parse(text);
  if (!tree) return undefined;
  try {
    return lang === "python" ? extractPython(path, tree.rootNode) : extractTypeScript(path, tree.rootNode, lang);
  } finally {
    tree.delete();
  }
}

export interface ScanOptions {
  rootName: string;
  /** Paths of non-code files (manifests mark services). */
  otherFiles?: string[];
  includeExternal?: boolean;
  onProgress?: (done: number, total: number) => void;
  onError?: (path: string, err: Error) => void;
}

/** Build a code flowgraph from sources already in memory (used by the browser scanner). */
export async function scanSources(files: SourceFile[], opts: ScanOptions): Promise<FlowGraph> {
  const models: FileModel[] = [];
  let done = 0;
  for (const f of files) {
    try {
      const m = await parseSource(f.path, f.text);
      if (m) models.push(m);
    } catch (err) {
      opts.onError?.(f.path, err as Error);
    }
    opts.onProgress?.(++done, files.length);
  }
  return buildGraph({ rootName: opts.rootName, files: models, otherFiles: opts.otherFiles ?? [], includeExternal: opts.includeExternal ?? true });
}
