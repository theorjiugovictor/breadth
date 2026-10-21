/// <reference lib="webworker" />
import { scanSources, scanTerraformSources, setWasmLocator } from "@breadth/collectors/browser";
import { runInsights } from "@breadth/insights";
import { mergeGraphs, type FlowGraph } from "@breadth/schema";
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
    if (!listing.code.length && !listing.terraform.length) throw new ScanError(`No Python, TypeScript, JavaScript or Terraform files found in ${repoLabel(repo)}.`);
    const wanted = [...listing.code, ...listing.terraform];
    const total = wanted.length;
    post({ type: "progress", phase: "download", done: 0, total });
    const downloaded = await downloadFiles(repo, listing.ref, wanted, (done) => {
      if (done % 10 === 0 || done === total) post({ type: "progress", phase: "download", done, total });
    });
    const isTf = new Set(listing.terraform.map((f) => f.path));
    const files = downloaded.filter((f) => !isTf.has(f.path));
    post({ type: "progress", phase: "parse", done: 0, total: files.length });
    const rootName = repo.subpath ? repo.subpath.split("/").pop()! : repo.repo;
    const code = await scanSources(files, {
      rootName,
      otherFiles: listing.others,
      onProgress: (done, t) => {
        if (done % 20 === 0 || done === t) post({ type: "progress", phase: "parse", done, total: t });
      },
    });
    const tf = downloaded.filter((f) => isTf.has(f.path));
    const graph = tf.length ? mergeGraphs(code, scanTerraformSources(tf, rootName)) : code;
    // Deep links to GitHub for the Source tab.
    const blob = `https://github.com/${repo.owner}/${repo.repo}/blob/${listing.ref}/`;
    for (const n of graph.nodes) {
      if (n.source?.file && (n.id.startsWith("code:") || n.id.startsWith("tf:"))) n.source.url = `${blob}${n.source.file}${n.source.line ? `#L${n.source.line}` : ""}`;
    }
    graph.sources = [{ collector: "code", target: `https://github.com/${repo.owner}/${repo.repo}`, collectedAt: new Date().toISOString() }];
    if (tf.length) graph.sources.push({ collector: "infra", target: `https://github.com/${repo.owner}/${repo.repo}`, collectedAt: new Date().toISOString() });
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
