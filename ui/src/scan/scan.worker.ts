/// <reference lib="webworker" />
import { scanSources, setWasmLocator } from "@breadth/collectors/browser";
import { runInsights } from "@breadth/insights";
import type { FlowGraph } from "@breadth/schema";
import { downloadFiles, listRepo, ScanError, repoLabel, type RepoRef } from "./github";

export type ScanMessage =
  | { type: "progress"; phase: "list" | "download" | "parse" | "insights"; done?: number; total?: number; note?: string }
  | { type: "done"; graph: FlowGraph; note?: string }
  | { type: "error"; message: string };

const post = (m: ScanMessage) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<{ repo: RepoRef; wasmBase: string }>) => {
  const { repo, wasmBase } = e.data;
  setWasmLocator({ runtime: `${wasmBase}tree-sitter.wasm`, grammar: (f) => `${wasmBase}${f}` });
  try {
    post({ type: "progress", phase: "list" });
    const listing = await listRepo(repo);
    if (!listing.code.length) throw new ScanError(`No Python, TypeScript or JavaScript files found in ${repoLabel(repo)}.`);
    const total = listing.code.length;
    post({ type: "progress", phase: "download", done: 0, total });
    const files = await downloadFiles(repo, listing.ref, listing.code, (done) => {
      if (done % 10 === 0 || done === total) post({ type: "progress", phase: "download", done, total });
    });
    post({ type: "progress", phase: "parse", done: 0, total: files.length });
    const rootName = repo.subpath ? repo.subpath.split("/").pop()! : repo.repo;
    const graph = await scanSources(files, {
      rootName,
      otherFiles: listing.others,
      onProgress: (done, t) => {
        if (done % 20 === 0 || done === t) post({ type: "progress", phase: "parse", done, total: t });
      },
    });
    // Deep links to GitHub for the Source tab.
    const blob = `https://github.com/${repo.owner}/${repo.repo}/blob/${listing.ref}/`;
    for (const n of graph.nodes) {
      if (n.source?.file && n.id.startsWith("code:")) n.source.url = `${blob}${n.source.file}${n.source.line ? `#L${n.source.line}` : ""}`;
    }
    graph.sources = [{ collector: "code", target: `https://github.com/${repo.owner}/${repo.repo}`, collectedAt: new Date().toISOString() }];
    post({ type: "progress", phase: "insights" });
    graph.insights = runInsights(graph);
    const notes: string[] = [];
    if (listing.skipped) notes.push(`Scanned ${total} of ${total + listing.skipped} files (application code first). Use the CLI for the full repository.`);
    if (listing.truncated) notes.push("GitHub truncated the file list for this very large repository.");
    post({ type: "done", graph, note: notes.join(" ") || undefined });
  } catch (err) {
    post({ type: "error", message: err instanceof ScanError ? err.message : `Scan failed: ${(err as Error).message}` });
  }
};
