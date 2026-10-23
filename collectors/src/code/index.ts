import { promises as fs } from "node:fs";
import path from "node:path";
import type { FlowGraph } from "@breadth/schema";
import type { Collector, CollectorOptions } from "../core/types.js";
import { isDirectory, walkFiles } from "../core/walk.js";
import "./parser-node.js";
import { buildGraph } from "./build.js";
import type { FileModel } from "./model.js";
import { langForFile } from "./parser.js";
import { parseSource } from "./scan.js";
import { parseProto, type ProtoService } from "./grpc.js";

export interface CodeCollectorSettings {
  /** Show third-party packages as nodes (default true). */
  includeExternal?: boolean;
  /** Skip test files (default false). */
  skipTests?: boolean;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(\.|_)(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/;

/** Parsed files keyed by absolute path, reused while size and mtime are unchanged (live mode rescans). */
const parseCache = new Map<string, { mtimeMs: number; size: number; model: FileModel | undefined }>();

export async function parseFile(root: string, rel: string, overlay?: Map<string, string>): Promise<FileModel | undefined> {
  if (!langForFile(rel)) return undefined;
  const abs = path.join(root, rel);
  const unsaved = overlay?.get(abs);
  if (unsaved !== undefined) return parseSource(rel, unsaved);
  const st = await fs.stat(abs);
  const hit = parseCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.model;
  const model = await parseSource(rel, await fs.readFile(abs, "utf8"));
  parseCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, model });
  return model;
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
        const m = await parseFile(root, rel, options.overlay);
        if (m) models.push(m);
      } catch (err) {
        options.log?.warn(`code: failed to parse ${rel}: ${(err as Error).message}`);
      }
    }

    const protos: ProtoService[] = [];
    for (const rel of otherFiles.filter((f) => f.endsWith(".proto"))) {
      try {
        protos.push(...parseProto(rel, await fs.readFile(path.join(root, rel), "utf8")));
      } catch {
        /* unreadable proto: skip */
      }
    }

    const graph = buildGraph({
      protos,
      rootName: path.basename(root) || "root",
      files: models,
      otherFiles,
      includeExternal: settings.includeExternal ?? true,
    });
    graph.sources = [{ collector: "code", target: root, collectedAt: new Date().toISOString() }];
    return graph;
  },
};
