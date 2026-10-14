import { promises as fs } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { normPath } from "@noodles/schema";

import { DEFAULT_EXCLUDES } from "./excludes.js";

export { DEFAULT_EXCLUDES };

export interface WalkOptions {
  exclude?: string[];
  include?: string[];
  /** Only return files whose name passes this test. */
  filter?: (relPath: string) => boolean;
  maxFileBytes?: number;
}

/** Recursively list files under root (relative, forward-slash paths), honouring .gitignore files. */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const base = ignore().add(DEFAULT_EXCLUDES).add(opts.exclude ?? []);
  const include = opts.include?.length ? ignore().add(opts.include) : undefined;
  const maxBytes = opts.maxFileBytes ?? 1_000_000;
  const out: string[] = [];

  // Each directory level may add its own .gitignore; rules are relative to that directory.
  async function visit(dir: string, rules: { dir: string; ig: Ignore }[]) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    const gi = entries.find((e) => e.isFile() && e.name === ".gitignore");
    if (gi) {
      try {
        const text = await fs.readFile(path.join(root, dir, ".gitignore"), "utf8");
        rules = [...rules, { dir, ig: ignore().add(text) }];
      } catch {
        /* unreadable .gitignore: ignore it */
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const rel = normPath(dir ? `${dir}/${e.name}` : e.name);
      const isDir = e.isDirectory();
      const test = isDir ? `${rel}/` : rel;
      if (base.ignores(test)) continue;
      if (rules.some((r) => r.ig.ignores(normPath(path.posix.relative(r.dir, rel)) + (isDir ? "/" : "")))) continue;
      if (isDir) {
        await visit(rel, rules);
      } else if (e.isFile()) {
        if (include && !include.ignores(rel)) continue;
        if (opts.filter && !opts.filter(rel)) continue;
        try {
          const st = await fs.stat(path.join(root, rel));
          if (st.size > maxBytes) continue;
        } catch {
          continue;
        }
        out.push(rel);
      }
    }
  }

  await visit("", []);
  return out;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
