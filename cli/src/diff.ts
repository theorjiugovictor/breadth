import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BehaviorChange, FlowGraph, FlowNode } from "@breadth/schema";
import { applyPlan, runCollectors, type CollectorOptions } from "@breadth/collectors";
import { describeChanges, runInsights, type ChangeReport } from "@breadth/insights";

/** Marker so the GitHub Action updates its own comment instead of adding a new one each push. */
export const COMMENT_MARKER = "<!-- breadth-diff -->";

function git(cwd: string, args: string[], input?: Buffer): Buffer {
  const r = spawnSync("git", args, { cwd, input, maxBuffer: 2 ** 31 - 1 });
  if (r.error) throw new Error(`git not found: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

export function repoRoot(dir: string): string {
  return git(dir, ["rev-parse", "--show-toplevel"]).toString().trim();
}

/** The ref to compare against: the PR base in CI, else the default branch's merge base. */
export function defaultBase(dir: string): string {
  const candidates = [process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "", "origin/HEAD", "origin/main", "main", "origin/master", "master"].filter(Boolean);
  for (const ref of candidates) {
    try {
      return git(dir, ["merge-base", "HEAD", ref]).toString().trim();
    } catch {
      /* try the next */
    }
  }
  return "HEAD";
}

export function shortRef(dir: string, ref: string): string {
  try {
    return git(dir, ["rev-parse", "--short", ref]).toString().trim();
  } catch {
    return ref;
  }
}

/**
 * A git ref's files, extracted to a temporary folder named like the repository (node ids
 * include the root folder name, so both versions must agree on it). Returns the folder.
 */
export function checkoutRef(root: string, ref: string): { dir: string; cleanup: () => void } {
  const tmp = mkdtempSync(path.join(tmpdir(), "breadth-diff-"));
  const dir = path.join(tmp, path.basename(root));
  mkdirSync(dir);
  const tar = git(root, ["archive", "--format=tar", ref]);
  const r = spawnSync("tar", ["-x", "-C", dir], { input: tar, maxBuffer: 2 ** 31 - 1 });
  if (r.status !== 0) throw new Error(`could not extract ${ref}: ${r.stderr?.toString().trim() || r.error?.message}`);
  return { dir, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

export async function scan(target: string, collectors: string[] | undefined, options: CollectorOptions): Promise<FlowGraph> {
  const graph = await runCollectors(target, collectors, options);
  graph.insights = runInsights(graph);
  return graph;
}

export function loadGraph(file: string): FlowGraph {
  return JSON.parse(readFileSync(file, "utf8")) as FlowGraph;
}

/** `--plan [dir=]plan.json`: a `terraform show -json` plan, optionally for the root module in dir. */
export interface PlanArg {
  dir?: string;
  file: string;
}

export function parsePlanArgs(values: string[] | undefined): PlanArg[] {
  return (values ?? []).map((v) => {
    const i = v.indexOf("=");
    return i > 0 ? { dir: v.slice(0, i).replace(/^\.\//, "").replace(/\/+$/, "") || ".", file: v.slice(i + 1) } : { file: v };
  });
}

/** Mark the graph's Terraform resources with what each plan does to them. Returns warnings. */
export function applyPlans(graph: FlowGraph, plans: PlanArg[]): string[] {
  const warnings: string[] = [];
  for (const p of plans) {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(readFileSync(p.file, "utf8"));
    } catch (err) {
      throw new Error(`could not read the plan ${p.file} (make it with \`terraform show -json tfplan > ${path.basename(p.file)}\`): ${(err as Error).message}`);
    }
    if (!Array.isArray(doc.resource_changes)) throw new Error(`${p.file} is not a Terraform plan in JSON (expected resource_changes; make it with \`terraform show -json tfplan\`)`);
    const n = applyPlan(graph, doc, p.dir);
    if (!n && doc.resource_changes.length) warnings.push(`the plan ${p.file} matched no Terraform resource in the scan${p.dir ? ` under ${p.dir}` : ""}`);
  }
  return warnings;
}

/** Diff two scans: the base ref's files against the working tree (or another ref). */
export async function diffRefs(opts: {
  target: string;
  base?: string;
  head?: string;
  collectors?: string[];
  collectorOptions: CollectorOptions;
  /** Terraform plans for the head version. */
  plans?: PlanArg[];
}): Promise<{ before: FlowGraph; after: FlowGraph; report: ChangeReport }> {
  const root = repoRoot(opts.target);
  const sub = path.relative(root, path.resolve(opts.target));
  const base = opts.base ?? defaultBase(root);
  const cleanups: (() => void)[] = [];
  try {
    const at = async (ref: string | undefined) => {
      if (!ref) return scan(path.resolve(opts.target), opts.collectors, opts.collectorOptions);
      const c = checkoutRef(root, ref);
      cleanups.push(c.cleanup);
      return scan(path.join(c.dir, sub), opts.collectors, opts.collectorOptions);
    };
    const before = await at(base);
    const after = await at(opts.head);
    if (opts.plans?.length) for (const w of applyPlans(after, opts.plans)) opts.collectorOptions.log?.warn(w);
    const report = describeChanges(before, after, { base: shortRef(root, base), head: opts.head ? shortRef(root, opts.head) : "working tree" });
    return { before, after, report };
  } finally {
    for (const c of cleanups) c();
  }
}

const ICON: Record<BehaviorChange["severity"], string> = { high: "🔴", medium: "🟠", low: "⚪" };

function fileOf(id: string, before: FlowGraph, after: FlowGraph): string | undefined {
  return (after.nodes.find((n) => n.id === id) ?? before.nodes.find((n) => n.id === id))?.source?.file;
}

/** A Mermaid picture of the changed parts: what a reviewer looks at first. */
export function mermaid(report: ChangeReport, before: FlowGraph, after: FlowGraph, max = 18): string | undefined {
  const byId = new Map<string, FlowNode>([...before.nodes.map((n) => [n.id, n] as const), ...after.nodes.map((n) => [n.id, n] as const)]);
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));
  const added = new Set(report.added);
  const removed = new Set(report.removed);
  const changed = new Set(report.changed);
  const removedEdges = new Set(report.edgesRemoved);
  const nodes: string[] = [];
  const edges: { id: string; from: string; to: string; label?: string; removed: boolean }[] = [];
  const want = (id: string) => {
    if (!byId.has(id) || nodes.includes(id)) return nodes.includes(id);
    if (nodes.length >= max) return false;
    nodes.push(id);
    return true;
  };
  for (const c of report.changes) {
    if (c.kind.startsWith("insight:")) continue;
    if (c.edges?.length) {
      for (const eid of c.edges) {
        const e = afterEdges.get(eid) ?? beforeEdges.get(eid);
        if (!e || edges.some((x) => x.id === eid)) continue;
        if (want(e.from.node) && want(e.to.node)) edges.push({ id: eid, from: e.from.node, to: e.to.node, label: e.label ?? (e.kind === "call" ? undefined : e.kind), removed: removedEdges.has(eid) });
      }
    } else for (const id of c.nodes.slice(0, 1)) want(id);
  }
  if (!nodes.length) return undefined;
  // Connect what is on the picture (an endpoint to its handler, a caller to a callee).
  const inPicture = new Set(nodes);
  for (const e of [...after.edges, ...before.edges.filter((x) => removedEdges.has(x.id))]) {
    if (edges.length >= max * 2) break;
    if (e.from.node === e.to.node || !inPicture.has(e.from.node) || !inPicture.has(e.to.node) || edges.some((x) => x.id === e.id)) continue;
    edges.push({ id: e.id, from: e.from.node, to: e.to.node, label: e.label ?? (e.kind === "call" ? undefined : e.kind), removed: removedEdges.has(e.id) });
  }
  const key = new Map(nodes.map((id, i) => [id, `n${i}`]));
  const esc = (s: string) => s.replace(/"/g, "#quot;").replace(/[<>]/g, "").slice(0, 60);
  const lines = ["flowchart LR"];
  for (const id of nodes) {
    const n = byId.get(id)!;
    const file = n.source?.file?.split("/").pop();
    const sub = n.kind === "function" && file ? file : n.kind.replace("_", " ");
    lines.push(`  ${key.get(id)}["${esc(n.name)}<br/><small>${esc(sub)}</small>"]`);
  }
  edges.forEach((e) => {
    const l = e.label ? `|"${esc(e.label)}"|` : "";
    lines.push(`  ${key.get(e.from)} ${e.removed ? "-.->" : "-->"}${l} ${key.get(e.to)}`);
  });
  const cls = (set: Set<string>, name: string) => {
    const ids = nodes.filter((id) => set.has(id)).map((id) => key.get(id));
    if (ids.length) lines.push(`  class ${ids.join(",")} ${name}`);
  };
  lines.push("  classDef added fill:#dcfce7,stroke:#16a34a,color:#14532d");
  lines.push("  classDef removed fill:#fee2e2,stroke:#dc2626,color:#7f1d1d,stroke-dasharray:4 3");
  lines.push("  classDef changed fill:#fef3c7,stroke:#d97706,color:#78350f");
  cls(added, "added");
  cls(removed, "removed");
  cls(changed, "changed");
  edges.forEach((e, i) => {
    if (e.removed) lines.push(`  linkStyle ${i} stroke:#dc2626`);
    else if (report.edgesAdded.includes(e.id)) lines.push(`  linkStyle ${i} stroke:#16a34a`);
  });
  return lines.join("\n");
}

/** The PR comment: behaviour first, structure second, details folded away. */
export function renderMarkdown(report: ChangeReport, before: FlowGraph, after: FlowGraph, opts: { title?: string; link?: string } = {}): string {
  const c = report.counts;
  const attention = report.changes.filter((x) => x.severity === "high");
  const other = report.changes.filter((x) => x.severity !== "high");
  const n = (v: number, s: string) => `${v} ${s}${v === 1 ? "" : "s"}`;
  const parts = [
    c.functionsAdded && `+${n(c.functionsAdded, "function")}`,
    c.functionsRemoved && `−${n(c.functionsRemoved, "function")}`,
    c.functionsChanged && `${c.functionsChanged} changed`,
    c.endpointsAdded && `+${n(c.endpointsAdded, "endpoint")}`,
    c.endpointsRemoved && `−${n(c.endpointsRemoved, "endpoint")}`,
    (c.edgesAdded || c.edgesRemoved) && `${c.edgesAdded} connections added, ${c.edgesRemoved} removed`,
  ].filter(Boolean);
  const unrequested = new Map((report.intent?.unrequested ?? []).map((u) => [u.change, u.why]));
  const line = (x: BehaviorChange) => {
    const file = fileOf(x.nodes[0], before, after);
    const i = report.changes.indexOf(x);
    const flag = unrequested.has(i) ? ` · **not in the request**${unrequested.get(i) ? `: ${unrequested.get(i)}` : ""}` : "";
    return `- ${ICON[x.severity]} ${x.text}${file && !x.text.includes(file) ? ` <sub>\`${file}\`</sub>` : ""}${flag}`;
  };
  const out: string[] = [COMMENT_MARKER, `### ${opts.title ?? "breadth · what this change does"}`, ""];
  if (!report.changes.length && !parts.length) {
    out.push("No change in structure or behaviour: the same functions, calls, data access and endpoints as before.");
  } else {
    out.push(
      `**${attention.length ? `${n(attention.length, "change")} worth a close look` : "Nothing high-risk"}**${parts.length ? ` · ${parts.join(" · ")}` : ""}`,
      "",
    );
    if (report.intent) out.push(...intentSection(report), "");
    if (attention.length) out.push("#### Worth a close look", ...attention.slice(0, 25).map(line), "");
    if (other.length) out.push("#### Also changes", ...other.slice(0, 25).map(line), other.length > 25 ? `- …and ${other.length - 25} more` : "", "");
    const picture = mermaid(report, before, after);
    if (picture) out.push("<details open><summary><b>Picture of the change</b> (green added, red removed, amber changed)</summary>", "", "```mermaid", picture, "```", "", "</details>", "");
    if (report.insightsResolvedFull.length) out.push(`✅ Resolves: ${report.insightsResolvedFull.map((i) => i.title).slice(0, 8).join("; ")}`, "");
    const byId = new Map<string, FlowNode>([...before.nodes.map((x) => [x.id, x] as const), ...after.nodes.map((x) => [x.id, x] as const)]);
    const list = (title: string, ids: string[]) => {
      const fns = ids.map((id) => byId.get(id)).filter((x): x is FlowNode => !!x && (x.kind === "function" || x.kind === "network_endpoint"));
      return fns.length ? [`**${title}** (${fns.length}): ${fns.slice(0, 60).map((x) => `\`${x.name}\``).join(", ")}${fns.length > 60 ? ", …" : ""}`, ""] : [];
    };
    const details = [...list("Added", report.added), ...list("Removed", report.removed), ...list("Changed", report.changed)];
    if (details.length) out.push("<details><summary>All structural changes</summary>", "", ...details, "</details>", "");
  }
  out.push(
    `<sub>breadth compared ${report.base ?? "base"} → ${report.head ?? "head"} by scanning both versions. It maps structure and data flow; dynamic calls and runtime-only behaviour are not visible.${opts.link ? ` [Open the map](${opts.link})` : ""}</sub>`,
  );
  return out.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n";
}

/** The request compared with the change (breadth diff --intent). */
function intentSection(report: ChangeReport): string[] {
  const it = report.intent!;
  const out = ["#### Compared with the request"];
  if (it.summary) out.push(`> ${it.summary}`, "");
  const extra = (it.unrequested ?? []).filter((u) => report.changes[u.change]);
  if (extra.length) {
    out.push(`**Not in the request** (${extra.length}):`);
    for (const u of extra.slice(0, 15)) out.push(`- ${ICON[report.changes[u.change].severity]} ${report.changes[u.change].text}${u.why ? ` · ${u.why}` : ""}`);
    out.push("");
  }
  if (it.missing?.length) out.push("**Asked for, but not visible in the change:**", ...it.missing.slice(0, 10).map((m) => `- ${m}`), "");
  if (!extra.length && !it.missing?.length) out.push("Every behaviour change is explained by the request.", "");
  out.push(`<sub>Request checked by ${it.model ?? "an LLM"} against the list of changes; it can be wrong.</sub>`);
  return out;
}

/** Plain text for terminals. */
export function renderText(report: ChangeReport): string {
  const c = report.counts;
  const head = `${report.base ?? "base"} → ${report.head ?? "head"}: +${c.functionsAdded} −${c.functionsRemoved} ~${c.functionsChanged} functions, +${c.edgesAdded} −${c.edgesRemoved} connections`;
  if (!report.changes.length) return `${head}\nNo behaviour changes.\n`;
  const mark = { high: "!!", medium: " !", low: "  " } as const;
  const extra = new Map((report.intent?.unrequested ?? []).map((u) => [u.change, u.why]));
  const lines = [head, ""];
  if (report.intent?.summary) lines.push(`Request: ${report.intent.summary}`, "");
  lines.push(...report.changes.map((x, i) => `${mark[x.severity]} ${x.text}${extra.has(i) ? `   <- not in the request${extra.get(i) ? `: ${extra.get(i)}` : ""}` : ""}`));
  if (report.intent?.missing?.length) lines.push("", "Asked for, not visible:", ...report.intent.missing.map((m) => `   ${m}`));
  return lines.join("\n") + "\n";
}
