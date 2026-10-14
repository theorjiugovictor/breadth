import ignore from "ignore";
import { DEFAULT_EXCLUDES, langForFile, SERVICE_MANIFESTS } from "@breadth/collectors/browser";

export interface RepoRef {
  owner: string;
  repo: string;
  ref?: string;
  subpath?: string;
}

/** Accepts owner/repo, github.com/owner/repo, full URLs, .git suffixes and /tree/<ref>/<path>. */
export function parseRepoInput(input: string): RepoRef | undefined {
  const s = input
    .trim()
    .replace(/^git@github\.com:/, "github.com/")
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const m = s.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?$/);
  if (!m) return undefined;
  return { owner: m[1], repo: m[2], ref: m[3], subpath: m[4] };
}

export function repoLabel(r: RepoRef): string {
  return `${r.owner}/${r.repo}${r.subpath ? `/${r.subpath}` : ""}`;
}

export class ScanError extends Error {}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

export interface RepoListing {
  ref: string;
  code: { path: string; size: number }[];
  others: string[];
  skipped: number;
  truncated: boolean;
}

export const MAX_FILES = 1200;
const MAX_BYTES = 300_000;
const TEST = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|examples?|docs?_src)\//i;

/** One GitHub API call: the recursive tree of the default branch (or the given ref). */
export async function listRepo(r: RepoRef, signal?: AbortSignal): Promise<RepoListing> {
  const ref = r.ref ?? "HEAD";
  const res = await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
    headers: { accept: "application/vnd.github+json" },
    signal,
  });
  if (res.status === 404 || res.status === 422) throw new ScanError(`${r.owner}/${r.repo} was not found. Only public GitHub repositories can be scanned in the browser; use the CLI for private code.`);
  if (res.status === 409) throw new ScanError(`${r.owner}/${r.repo} is empty.`);
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const when = reset ? ` Try again after ${new Date(reset * 1000).toLocaleTimeString()}.` : "";
    throw new ScanError(`GitHub's limit for anonymous requests (60 per hour) is used up.${when} The CLI has no such limit.`);
  }
  if (!res.ok) throw new ScanError(`GitHub returned ${res.status} for ${r.owner}/${r.repo}.`);
  const body = (await res.json()) as { sha: string; tree: TreeEntry[]; truncated: boolean };

  const ig = ignore().add(DEFAULT_EXCLUDES);
  const prefix = r.subpath ? `${r.subpath.replace(/\/$/, "")}/` : "";
  const code: { path: string; size: number }[] = [];
  const others: string[] = [];
  for (const e of body.tree) {
    if (e.type !== "blob" || !e.path.startsWith(prefix)) continue;
    if (ig.ignores(e.path)) continue;
    if (langForFile(e.path)) {
      if ((e.size ?? 0) <= MAX_BYTES) code.push({ path: e.path, size: e.size ?? 0 });
    } else if (SERVICE_MANIFESTS.has(e.path.split("/").pop()!)) others.push(e.path);
  }
  // Large repos: keep application code first (not tests or docs), shallow before deep, small before big.
  let skipped = 0;
  if (code.length > MAX_FILES) {
    code.sort((a, b) => Number(TEST.test(a.path)) - Number(TEST.test(b.path)) || a.path.split("/").length - b.path.split("/").length || a.size - b.size);
    skipped = code.length - MAX_FILES;
    code.length = MAX_FILES;
  }
  return { ref: body.sha ?? ref, code, others, skipped, truncated: body.truncated };
}

/** Download files from raw.githubusercontent.com (not counted against the API limit). */
export async function downloadFiles(
  r: RepoRef,
  ref: string,
  files: { path: string }[],
  onProgress: (done: number) => void,
  signal?: AbortSignal,
  concurrency = 16,
): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      const url = `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${ref}/${f.path.split("/").map(encodeURIComponent).join("/")}`;
      try {
        const res = await fetch(url, { signal });
        if (res.ok) out.push({ path: f.path, text: await res.text() });
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
      }
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
