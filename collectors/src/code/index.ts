import { promises as fs } from "node:fs";
import path from "node:path";
import type { FlowGraph } from "@noodles/schema";
import type { Collector, CollectorOptions } from "../core/types.js";
import { isDirectory, walkFiles } from "../core/walk.js";
import { buildGraph } from "./build.js";
import type { FileModel } from "./model.js";
import { getParser, langForFile } from "./parser.js";
import { extractPython } from "./python.js";
import { extractTypeScript } from "./typescript.js";

export interface CodeCollectorSettings {
  /** Show third-party packages as nodes (default true). */
  includeExternal?: boolean;
  /** Skip test files (default false). */
  skipTests?: boolean;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(\.|_)(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/;

export async function parseFile(root: string, rel: string): Promise<FileModel | undefined> {
  const lang = langForFile(rel);
  if (!lang) return undefined;
  const text = await fs.readFile(path.join(root, rel), "utf8");
  // Skip generated / minified files: very long lines are a strong signal.
  if (text.length > 20_000 && text.split("\n", 50).some((l) => l.length > 2000)) return undefined;
  const parser = await getParser(lang);
  const tree = parser.parse(text);
  if (!tree) return undefined;
  try {
    return lang === "python" ? extractPython(rel, tree.rootNode) : extractTypeScript(rel, tree.rootNode, lang);
  } finally {
    tree.delete();
  }
}

export const codeCollector: Collector = {
  name: "code",
  description: "Static code structure for Python and TypeScript/JavaScript (tree-sitter)",
  implemented: true,

  async detect(target, options = {}) {
    if (!(await isDirectory(target))) return false;
    const files = await walkFiles(target, { exclude: options.exclude, include: options.include, filter: (f) => !!langForFile(f) });
    return files.length > 0;
  },

  async collect(target, options: CollectorOptions = {}): Promise<FlowGraph> {
    const settings = (options.settings?.code ?? {}) as CodeCollectorSettings;
    const root = path.resolve(target);
    const all = await walkFiles(root, { exclude: options.exclude, include: options.include });
    const codeFiles = all.filter((f) => langForFile(f) && !(settings.skipTests && TEST_FILE.test(f)));
    const otherFiles = all.filter((f) => !langForFile(f));
    options.log?.info(`code: parsing ${codeFiles.length} files`);

    const models: FileModel[] = [];
    for (const rel of codeFiles) {
      try {
        const m = await parseFile(root, rel);
        if (m) models.push(m);
      } catch (err) {
        options.log?.warn(`code: failed to parse ${rel}: ${(err as Error).message}`);
      }
    }

    const graph = buildGraph({
      rootName: path.basename(root) || "root",
      files: models,
      otherFiles,
      includeExternal: settings.includeExternal ?? true,
    });
    graph.sources = [{ collector: "code", target: root, collectedAt: new Date().toISOString() }];
    return graph;
  },
};
