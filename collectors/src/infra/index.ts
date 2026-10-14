import { promises as fs } from "node:fs";
import path from "node:path";
import { mergeGraphs, SCHEMA_VERSION, type FlowGraph } from "@noodles/schema";
import type { Collector, CollectorOptions } from "../core/types.js";
import { walkFiles } from "../core/walk.js";
import { k8sGraph, parseK8s, type K8sObject } from "./k8s.js";
import { parseTerraform, terraformGraph } from "./terraform.js";

const CANDIDATE = /\.(json|tfstate|ya?ml)$/i;
/** Skip things that are certainly not infra descriptions. */
const NOT_INFRA = /(^|\/)(package(-lock)?\.json|tsconfig[\w.]*\.json|composer\.json|\.eslintrc\.json|flowgraph\.json|.*\.otlp\.json|pnpm-lock\.yaml|\.github\/.*|docker-compose\.ya?ml|mkdocs\.ya?ml|\.pre-commit-config\.yaml)$/;

async function candidates(target: string, options: CollectorOptions): Promise<{ root: string; files: string[] }> {
  const st = await fs.stat(target);
  if (st.isFile()) return { root: path.dirname(target), files: [path.basename(target)] };
  const files = await walkFiles(target, {
    exclude: options.exclude,
    include: options.include,
    filter: (f) => CANDIDATE.test(f) && !NOT_INFRA.test(f),
    maxFileBytes: 50_000_000,
  });
  return { root: target, files };
}

interface Found {
  terraform: { file: string; doc: Record<string, unknown> }[];
  k8s: K8sObject[];
}

async function scan(target: string, options: CollectorOptions): Promise<Found> {
  const { root, files } = await candidates(target, options);
  const found: Found = { terraform: [], k8s: [] };
  for (const rel of files) {
    let text: string;
    try {
      text = await fs.readFile(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    if (/\.(json|tfstate)$/i.test(rel)) {
      if (!/"(format_version|terraform_version)"/.test(text.slice(0, 5000))) continue;
      try {
        found.terraform.push({ file: rel, doc: JSON.parse(text) });
      } catch {
        options.log?.warn(`infra: could not parse ${rel}`);
      }
    } else if (/^\s*(apiVersion|kind):/m.test(text)) {
      found.k8s.push(...parseK8s(text, rel));
    }
  }
  return found;
}

export const infraCollector: Collector = {
  name: "infra",
  description: "Terraform/OpenTofu state or plan JSON and Kubernetes manifests",
  implemented: true,

  async detect(target, options = {}) {
    try {
      const f = await scan(target, { exclude: options.exclude, include: options.include });
      return f.terraform.length > 0 || f.k8s.length > 0;
    } catch {
      return false;
    }
  },

  async collect(target, options = {}) {
    const found = await scan(target, options);
    const graphs: FlowGraph[] = [];
    const rootName = path.basename(path.resolve(target)).replace(/\.\w+$/, "") || "infra";
    for (const { file, doc } of found.terraform) {
      const resources = parseTerraform(doc);
      if (!resources) continue;
      options.log?.info(`infra: ${file}: ${resources.length} terraform resources`);
      const { nodes, edges } = terraformGraph(resources, file, rootName);
      graphs.push({ version: SCHEMA_VERSION, nodes, edges });
    }
    if (found.k8s.length) {
      options.log?.info(`infra: ${found.k8s.length} kubernetes objects`);
      const { nodes, edges } = k8sGraph(found.k8s);
      graphs.push({ version: SCHEMA_VERSION, nodes, edges });
    }
    const merged = graphs.length ? mergeGraphs(...graphs) : { version: SCHEMA_VERSION, nodes: [], edges: [] };
    merged.sources = [{ collector: "infra", target: path.resolve(target), collectedAt: new Date().toISOString() }];
    return merged as FlowGraph;
  },
};
